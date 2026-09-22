import { randomBytes, randomUUID } from 'node:crypto';
import { MULTI, Session, type ClientMsg, type ServerMsg } from '@mine/core';
import type { WebSocket } from 'ws';
import type { Store } from './store';

/** Actions a connection may send per second (a token bucket); the rest are dropped. */
const RATE = 40;
/** Coordinates a message may carry (the Earth map is 1440 x 720; anything far outside is junk). */
const MAX_COORD = 100_000;

export interface Conn {
  ws: WebSocket;
  session: Session | null;
  color: number;
  token: string;
  bucket: number;
  lastRefill: number;
}

/**
 * Sessions and the connections playing them. A `hello` resumes the player a
 * token names, or seats a new one (random colour) in a random joinable
 * session, making a new session when none is. Session events are broadcast
 * to everyone in it; a player who steps on a mine gets `gameover` and is
 * detached (the client goes back to the title and says `hello` again later).
 */
export class Lobby {
  readonly sessions = new Map<string, Session>();
  private readonly conns = new Map<Session, Set<Conn>>();
  private readonly dirty = new Set<Session>();

  constructor(private store: Store) {
    for (const s of store.loadAll()) this.add(s);
  }

  private add(s: Session): void {
    this.sessions.set(s.id, s);
    this.conns.set(s, new Set());
    const all = (msg: ServerMsg) => this.broadcast(s, msg);
    s.events.on('cells', (e) => {
      this.dirty.add(s);
      all({ t: 'cells', by: e.by, cells: e.cells });
    });
    s.events.on('blast', (e) => all({ t: 'blast', ...e }));
    s.events.on('settle', (e) => all({ t: 'settle', ...e }));
    s.events.on('players', (players) => {
      this.dirty.add(s);
      all({ t: 'players', players });
    });
    s.events.on('gameover', (e) => {
      for (const c of this.conns.get(s)!) {
        if (c.token !== e.token) continue;
        send(c, { t: 'gameover', score: e.score });
        this.detach(c);
      }
    });
  }

  private broadcast(s: Session, msg: ServerMsg): void {
    const conns = this.conns.get(s);
    if (!conns?.size) return;
    const data = JSON.stringify(msg);
    for (const c of conns) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  connect(ws: WebSocket): Conn {
    return { ws, session: null, color: -1, token: '', bucket: RATE, lastRefill: Date.now() };
  }

  message(c: Conn, raw: string): void {
    const now = Date.now();
    c.bucket = Math.min(RATE, c.bucket + ((now - c.lastRefill) / 1000) * RATE);
    c.lastRefill = now;
    if (c.bucket < 1) return;
    c.bucket--;
    let m: ClientMsg;
    try {
      m = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') return this.hello(c, m);
    if (m.t === 'ping') return send(c, { t: 'pong' });
    const s = c.session;
    if (!s) return;
    if (!('x' in m) || !coord(m.x) || !coord(m.y)) return;
    s.setOnline(c.color, true, now);
    let r;
    switch (m.t) {
      case 'reveal':
        r = s.reveal(c.color, m.x, m.y);
        break;
      case 'chord':
        r = s.chord(c.color, m.x, m.y);
        break;
      case 'flag':
        r = s.flag(c.color, m.x, m.y, m.on === true);
        this.dirty.add(s);
        break;
      default:
        return;
    }
    if (!r.ok && r.error) send(c, { t: 'error', code: r.error });
  }

  private hello(c: Conn, m: Extract<ClientMsg, { t: 'hello' }>): void {
    if (m.v !== MULTI.version) return send(c, { t: 'error', code: 'version' });
    if (c.session) this.detach(c);
    const now = Date.now();
    if (typeof m.leave === 'string' && m.leave) this.leave(m.leave);
    let s: Session | undefined;
    let p;
    if (typeof m.token === 'string' && m.token) {
      for (const cand of this.sessions.values()) {
        p = cand.playerByToken(m.token);
        if (p) {
          s = cand;
          break;
        }
      }
    }
    if (s && p) {
      // The same player on another connection (a second tab, a stale socket) is replaced.
      for (const other of this.conns.get(s)!) {
        if (other.token !== p.token) continue;
        this.detach(other);
        other.ws.close(4000, 'replaced');
      }
    } else {
      s = this.pick() ?? this.create();
      p = s.addPlayer(randomUUID(), now);
      if (!p) return send(c, { t: 'error', code: 'full' });
    }
    c.session = s;
    c.color = p.color;
    c.token = p.token;
    this.conns.get(s)!.add(c);
    s.setOnline(p.color, true, now);
    send(c, { t: 'welcome', token: p.token, session: s.id, seed: s.seed, you: p.color, players: s.playerInfo(), chunks: s.snapshotChunks(), flags: [...p.flags] });
    this.dirty.add(s);
  }

  /** The player `token` names leaves at once (a new game over a kept seat); their land stays, uncoloured. */
  private leave(token: string): void {
    for (const s of this.sessions.values()) {
      const p = s.playerByToken(token);
      if (!p) continue;
      for (const other of [...this.conns.get(s)!]) {
        if (other.token !== token) continue;
        this.detach(other);
        other.ws.close(4000, 'replaced');
      }
      s.removePlayer(p.color, false);
      this.dirty.add(s);
      return;
    }
  }

  /** A random session with room and land left (user decision: under 90 % opened, fewer than 12 players). */
  private pick(): Session | undefined {
    const open = [...this.sessions.values()].filter((s) => s.joinable());
    return open.length ? open[Math.floor(Math.random() * open.length)] : undefined;
  }

  private create(): Session {
    const s = new Session(randomBytes(6).toString('hex'), 1 + Math.floor(Math.random() * 1_000_000));
    this.add(s);
    this.dirty.add(s);
    console.log(`session ${s.id} created (seed ${s.seed})`);
    return s;
  }

  /** The connection stops playing its session (closed, replaced or game over); the player stays until idle. */
  detach(c: Conn): void {
    const s = c.session;
    if (!s) return;
    c.session = null;
    this.conns.get(s)!.delete(c);
    if (![...this.conns.get(s)!].some((o) => o.token === c.token)) s.setOnline(c.color, false, Date.now());
  }

  /** Every 30 s: drop idle players, forget finished empty sessions, save what changed. */
  sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) if (s.dropIdle(now).length) this.dirty.add(s);
    for (const s of [...this.sessions.values()]) {
      if (s.players.size || s.unlockRatio() < MULTI.joinMaxUnlock) continue;
      this.sessions.delete(s.id);
      this.conns.delete(s);
      this.dirty.delete(s);
      this.store.remove(s.id);
      console.log(`session ${s.id} finished and removed`);
    }
    this.flush();
  }

  flush(): void {
    for (const s of this.dirty) {
      try {
        this.store.save(s);
      } catch (e) {
        console.error(`saving session ${s.id} failed:`, e);
      }
    }
    this.dirty.clear();
  }
}

function send(c: Conn, msg: ServerMsg): void {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function coord(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_COORD;
}
