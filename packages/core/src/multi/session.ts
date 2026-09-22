import { Board, CHUNK, CellState, isKnownMine, isRevealed, isWall, numberOf, revealedState } from '../board';
import { type GameConfig, makeConfig } from '../config';
import type { CspContext } from '../csp';
import { blastRadius } from '../econ/blast';
import { Emitter } from '../events';
import { cellKey, chebyshev, deltaX, forEachNeighbor, keyX, keyY, wrapX } from '../key';
import { resolveReveal } from '../resolve';
import { World } from '../world';
import { base64Decode, base64Encode } from './codec';
import { MULTI, SIGNATURE_COLORS, multiConfig, type MultiError, type PlayerInfo, type WireCells } from './protocol';

/**
 * One multiplayer session on the Earth map (user decisions 2026-09-22), run
 * by the server. Pure logic like `Game`, but for up to `MULTI.maxPlayers`
 * players sharing one board:
 *
 * - One world truth and one board. Flags are private (per player, never on the
 *   shared board); every opened cell and base belongs to the player who opened
 *   it (`owner`: signature colour + 1, 0 = nobody).
 * - Points go straight to the score: +`tilePoints` per cell a player's opening
 *   reveals, +`basePoints` per base their settlement creates, −`basePoints` per
 *   wrong flag. No pool, combo, multiplier, upgrades, tiers, fog or network.
 * - The first click places the player's main base: it needs untouched land
 *   around it, and the square of `MULTI.startRadius` around it is committed
 *   mine-free.
 * - Stepping on a mine is game over: the blast is shown to everyone (it
 *   touches nobody else), every cell the player owns turns back to Unknown and
 *   the player leaves. A player who leaves any other way (offline too long)
 *   keeps their land on the board, uncoloured.
 * - Settlement works as in `Game` (claim batches through sealed numbers, only
 *   openings settle), per player: a number is sealed for a player when every
 *   closed neighbour carries one of their flags. A new base takes the opened
 *   cells around it (`claimAround`), other players' land included.
 */
export interface SessionPlayer {
  token: string;
  color: number;
  score: number;
  main: number | null;
  flags: Set<number>;
  /** Cells this player owns (opened cells, bases, lost mines). */
  cells: Set<number>;
  /** Flags placed since the last opening: they settle on the next one. */
  deferred: Set<number>;
  online: boolean;
  /** Last time the player was seen (ms, the server's clock): offline players are dropped after `MULTI.idleKickMs`. */
  lastSeen: number;
}

export interface SessionEvents extends Record<string, unknown> {
  /** Cells changed by the action of `by` (a colour, or -1). */
  cells: { by: number; cells: WireCells };
  blast: { x: number; y: number; r: number; color: number };
  settle: { color: number; x: number; y: number; cells: number[]; correct: number; wrong: number; payout: number };
  /** Scores, main bases or the player list changed. */
  players: PlayerInfo[];
  /** A player stepped on a mine and left. */
  gameover: { color: number; token: string; score: number };
}

export type ActionResult = { ok: true } | { ok: false; error?: MultiError };

export interface SessionSave {
  version: 1;
  id: string;
  seed: number;
  world: { overrides: Array<[number, 0 | 1]>; chunkPressure: Array<[number, number]>; densityDebt: number; interventions: number };
  /** [chunk key, states base64, owners base64]. */
  chunks: Array<[number, string, string]>;
  players: Array<{ token: string; color: number; score: number; main: number | null; flags: number[]; deferred: number[]; lastSeen: number }>;
  hits: number;
}

/** Owner per cell: signature colour + 1, 0 = nobody. Stored like the board, in 16x16 chunks. */
export class OwnerLayer {
  readonly chunks = new Map<number, Uint8Array>();
  constructor(readonly wrap: number) {}

  get(x: number, y: number): number {
    x = wrapX(x, this.wrap);
    const c = this.chunks.get(cellKey(x >> 4, y >> 4));
    return c ? c[((y & 15) << 4) | (x & 15)] : 0;
  }

  set(x: number, y: number, v: number): void {
    x = wrapX(x, this.wrap);
    const ck = cellKey(x >> 4, y >> 4);
    let c = this.chunks.get(ck);
    if (!c) {
      if (v === 0) return;
      c = new Uint8Array(CHUNK * CHUNK);
      this.chunks.set(ck, c);
    }
    c[((y & 15) << 4) | (x & 15)] = v;
  }
}

export class Session {
  readonly cfg: GameConfig;
  readonly world: World;
  readonly board = new Board();
  readonly owners: OwnerLayer;
  readonly ctx: CspContext;
  readonly players = new Map<number, SessionPlayer>();
  readonly events = new Emitter<SessionEvents>();
  /** Land cells on the map, and land cells no longer Unknown. */
  readonly landCells: number;
  private opened = 0;
  private hits = 0;
  private rescues = { left: 0 };
  /** Changes of the current action, flushed as one `cells` event. */
  private changed: WireCells = [];
  /** Keys of the cells changed in the current action (settlement looks around them). */
  private touched: number[] = [];

  constructor(
    readonly id: string,
    readonly seed: number,
  ) {
    this.cfg = makeConfig(multiConfig(seed));
    this.world = new World(this.cfg.world, seed);
    this.owners = new OwnerLayer(this.world.wrap);
    this.board.terrain = (x, y) => this.world.terrain(x, y);
    this.board.wrap = this.world.wrap;
    this.ctx = { board: this.board, world: this.world, scanners: [] };
    let land = 0;
    for (const v of this.world.map!.data) land += v;
    this.landCells = land;
  }

  // ------------------------------------------------------------------ queries

  get wrap(): number {
    return this.world.wrap;
  }

  /** Share of the land no longer Unknown (opened, bases, lost or exploded mines). */
  unlockRatio(): number {
    return this.opened / this.landCells;
  }

  /** Room for one more player, and not too much of the map opened yet. */
  joinable(): boolean {
    return this.players.size < MULTI.maxPlayers && this.unlockRatio() < MULTI.joinMaxUnlock;
  }

  playerInfo(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({ color: p.color, score: p.score, online: p.online, main: p.main })).sort((a, b) => b.score - a.score || a.color - b.color);
  }

  playerByToken(token: string): SessionPlayer | undefined {
    for (const p of this.players.values()) if (p.token === token) return p;
    return undefined;
  }

  /** Every chunk with something in it: [chunk key, states, owners], base64. */
  snapshotChunks(): Array<[number, string, string]> {
    const out: Array<[number, string, string]> = [];
    for (const [ck, c] of this.board.chunks) out.push([ck, base64Encode(c), base64Encode(this.owners.chunks.get(ck) ?? new Uint8Array(CHUNK * CHUNK))]);
    return out;
  }

  // ------------------------------------------------------------------ players

  /** A new player with a random free colour, or null when the session is full. */
  addPlayer(token: string, now: number, rand: () => number = Math.random): SessionPlayer | null {
    if (this.players.size >= MULTI.maxPlayers) return null;
    const free = SIGNATURE_COLORS.map((_, i) => i).filter((c) => !this.players.has(c));
    if (!free.length) return null;
    const color = free[Math.floor(rand() * free.length)];
    const p: SessionPlayer = { token, color, score: 0, main: null, flags: new Set(), cells: new Set(), deferred: new Set(), online: true, lastSeen: now };
    this.players.set(color, p);
    this.emitPlayers();
    return p;
  }

  setOnline(color: number, online: boolean, now: number): void {
    const p = this.players.get(color);
    if (!p) return;
    p.lastSeen = now;
    if (p.online === online) return;
    p.online = online;
    this.emitPlayers();
  }

  /**
   * The player leaves. `revert` (a mine): everything they own turns back to
   * Unknown. Otherwise (offline too long) their land stays, owned by nobody.
   */
  removePlayer(color: number, revert: boolean): void {
    const p = this.players.get(color);
    if (!p) return;
    this.players.delete(color);
    for (const k of p.cells) {
      const x = keyX(k);
      const y = keyY(k);
      if (revert) this.setCell(x, y, CellState.Unknown, 0);
      else this.owners.set(x, y, 0);
      if (!revert) this.changed.push(x, y, this.board.get(x, y), 0, -1);
    }
    p.cells.clear();
    this.flush(color);
    this.emitPlayers();
  }

  /** Offline players past `MULTI.idleKickMs` leave (their land stays). Returns their tokens. */
  dropIdle(now: number): string[] {
    const gone: string[] = [];
    for (const p of [...this.players.values()]) {
      if (p.online || now - p.lastSeen < MULTI.idleKickMs) continue;
      gone.push(p.token);
      this.removePlayer(p.color, false);
    }
    return gone;
  }

  // ------------------------------------------------------------------ actions

  /** Open a cell; the player's first opening places their main base. */
  reveal(color: number, x: number, y: number): ActionResult {
    const p = this.players.get(color);
    if (!p) return { ok: false };
    x = this.wx(x);
    if (isWall(this.board.get(x, y))) return { ok: false, error: 'water' };
    if (this.board.get(x, y) !== CellState.Unknown) return { ok: true };
    if (p.main === null) return this.found(p, x, y);
    if (p.flags.has(cellKey(x, y))) return { ok: true };
    if (this.open(p, x, y, true)) this.afterOpening(p);
    return { ok: true };
  }

  /** Open every closed neighbour of a number whose flags (the player's own) and known mines match it. Never rescued. */
  chord(color: number, x: number, y: number): ActionResult {
    const p = this.players.get(color);
    if (!p || p.main === null) return { ok: false };
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (!isRevealed(s)) return { ok: true };
    let marked = 0;
    const targets: Array<[number, number]> = [];
    forEachNeighbor(
      x,
      y,
      (nx, ny) => {
        const ns = this.board.get(nx, ny);
        if (isKnownMine(ns) || (ns === CellState.Unknown && p.flags.has(cellKey(nx, ny)))) marked++;
        else if (ns === CellState.Unknown) targets.push([nx, ny]);
      },
      this.wrap,
    );
    if (marked !== numberOf(s) || !targets.length) return { ok: true };
    for (const [tx, ty] of targets) {
      if (this.board.get(tx, ty) !== CellState.Unknown) continue;
      if (!this.open(p, tx, ty, false)) return { ok: true };
    }
    this.afterOpening(p);
    return { ok: true };
  }

  /** Place or lift one of the player's (private) flags. It settles on the next opening, never by itself. */
  flag(color: number, x: number, y: number, on: boolean): ActionResult {
    const p = this.players.get(color);
    if (!p || p.main === null) return { ok: false };
    x = this.wx(x);
    const k = cellKey(x, y);
    if (on) {
      if (this.board.get(x, y) !== CellState.Unknown) return { ok: false };
      p.flags.add(k);
      p.deferred.add(k);
    } else {
      p.flags.delete(k);
      p.deferred.delete(k);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- internals

  private wx(x: number): number {
    return wrapX(x, this.wrap);
  }

  /**
   * The first click: the main base goes on untouched land. The square of
   * `MULTI.startRadius` around it is committed mine-free (possible because no
   * revealed number sees it), so the opening always cascades over it.
   */
  private found(p: SessionPlayer, x: number, y: number): ActionResult {
    const r = MULTI.startRadius;
    for (let dy = -r - 1; dy <= r + 1; dy++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const s = this.board.get(x + dx, y + dy);
        if (s !== CellState.Unknown && !isWall(s)) return { ok: false, error: 'tooClose' };
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Cells pinned safe (an earlier start there, since reverted) are fine; a pinned mine is not.
        if (this.world.committed(cellKey(this.wx(x + dx), y + dy)) === 1) return { ok: false, error: 'tooClose' };
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = this.wx(x + dx);
        const cy = y + dy;
        if (isWall(this.board.get(cx, cy))) continue;
        // Mines taken out here are owed to the rest of the map (density debt, §5.3).
        if (this.world.committed(cellKey(cx, cy)) === 0) continue;
        if (this.world.truth(cx, cy) === 1) this.world.densityDebt++;
        this.world.commit(cellKey(cx, cy), 0);
      }
    }
    p.main = cellKey(x, y);
    if (this.open(p, x, y, false)) this.afterOpening(p);
    return { ok: true };
  }

  /** Open one cell for `p`. False when it was a mine (the player is gone). */
  private open(p: SessionPlayer, x: number, y: number, rescue: boolean): boolean {
    const r = resolveReveal({ cfg: this.cfg, ctx: this.ctx, rescues: this.rescues }, x, y, rescue);
    if (r.truth === 1) {
      this.hit(p, x, y);
      return false;
    }
    p.score += this.cascade(p, x, y) * this.cfg.econ.tilePoints;
    return true;
  }

  /** Game over for `p`: the blast (cosmetic), all their land back to Unknown, and they leave. */
  private hit(p: SessionPlayer, x: number, y: number): void {
    this.flush(p.color);
    const r = blastRadius(this.cfg.blast, 1, this.seed, x, y, this.hits++);
    this.events.emit('blast', { x, y, r, color: p.color });
    const score = p.score;
    this.removePlayer(p.color, true);
    this.events.emit('gameover', { color: p.color, token: p.token, score });
  }

  /** Reveal a safe cell for `p` and flood-fill through zeros (bounded as in `Game`). Returns cells opened. */
  private cascade(p: SessionPlayer, sx: number, sy: number): number {
    const origin = cellKey(sx, sy);
    const stack: number[] = [origin];
    const { cascadeRadius, cascadeCap } = this.cfg.play;
    let count = 0;
    while (stack.length) {
      const k = stack.pop()!;
      const x = keyX(k);
      const y = keyY(k);
      if (this.board.get(x, y) !== CellState.Unknown) continue;
      // The player's own flags stop their cascade, as on a single-player board.
      if (count > 0 && (count >= cascadeCap || chebyshev(x, y, sx, sy, this.wrap) > cascadeRadius || p.flags.has(k))) continue;
      let n = 0;
      forEachNeighbor(
        x,
        y,
        (nx, ny) => {
          const s = this.board.get(nx, ny);
          if (isKnownMine(s)) n++;
          else if (!isRevealed(s)) n += this.world.truth(nx, ny);
        },
        this.wrap,
      );
      this.setCell(x, y, revealedState(n), p.color + 1, origin);
      count++;
      if (n === 0) {
        forEachNeighbor(x, y, (nx, ny) => void (this.board.get(nx, ny) === CellState.Unknown && stack.push(cellKey(nx, ny))), this.wrap);
      }
    }
    return count;
  }

  /** Set a cell's state and owner; keeps the owners' cell sets, flags and the opened count in step. */
  private setCell(x: number, y: number, s: number, owner: number, from = -1): void {
    x = this.wx(x);
    const k = cellKey(x, y);
    const prev = this.board.get(x, y);
    const prevOwner = this.owners.get(x, y);
    if (prevOwner) this.players.get(prevOwner - 1)?.cells.delete(k);
    if (owner) this.players.get(owner - 1)?.cells.add(k);
    this.board.set(x, y, s);
    this.owners.set(x, y, owner);
    if (prev === CellState.Unknown && s !== CellState.Unknown) {
      this.opened++;
      // Nobody's flag stays on a cell that is no longer closed.
      for (const q of this.players.values()) {
        if (q.flags.delete(k)) q.deferred.delete(k);
      }
    } else if (prev !== CellState.Unknown && s === CellState.Unknown) this.opened--;
    this.changed.push(x, y, s, owner, from);
    this.touched.push(k);
  }

  /**
   * After an opening: settle every player's claim batches that became
   * settle-able around the cells it changed or around flags placed since the
   * last opening, then flush the changes.
   */
  private afterOpening(actor: SessionPlayer): void {
    for (const q of this.players.values()) {
      if (!q.flags.size) {
        q.deferred.clear();
        continue;
      }
      const done = new Set<number>();
      const around = (cx: number, cy: number) => {
        const candidates: number[] = [];
        const consider = (x: number, y: number) => {
          if (!this.sealedFor(q, x, y)) return;
          forEachNeighbor(x, y, (fx, fy) => {
            const fk = cellKey(fx, fy);
            if (!done.has(fk) && q.flags.has(fk) && this.settleableFor(q, fx, fy)) candidates.push(fk);
          }, this.wrap);
        };
        consider(cx, cy);
        forEachNeighbor(cx, cy, consider, this.wrap);
        for (const fk of candidates) {
          if (done.has(fk)) continue;
          const batch = this.collectBatch(q, fk, done);
          if (batch.length) this.settle(q, batch);
        }
      };
      const deferred = [...q.deferred];
      q.deferred.clear();
      for (const k of deferred) around(keyX(k), keyY(k));
      // settle() appends to `touched`, so its length is read every round.
      for (let i = 0; i < this.touched.length; i++) around(keyX(this.touched[i]), keyY(this.touched[i]));
    }
    this.flush(actor.color);
    this.emitPlayers();
  }

  /** A revealed number whose every closed neighbour carries one of `q`'s flags. */
  private sealedFor(q: SessionPlayer, x: number, y: number): boolean {
    const s = this.board.get(x, y);
    if (!isRevealed(s) || numberOf(s) === 0) return false;
    let sealed = true;
    forEachNeighbor(x, y, (nx, ny) => {
      if (sealed && this.board.get(nx, ny) === CellState.Unknown && !q.flags.has(cellKey(nx, ny))) sealed = false;
    }, this.wrap);
    return sealed;
  }

  /** One of `q`'s flags whose every numbered neighbour is sealed for `q` (and has at least one). */
  private settleableFor(q: SessionPlayer, x: number, y: number): boolean {
    let numbers = 0;
    let ok = true;
    forEachNeighbor(x, y, (nx, ny) => {
      const s = this.board.get(nx, ny);
      if (!isRevealed(s) || numberOf(s) === 0) return;
      numbers++;
      if (!this.sealedFor(q, nx, ny)) ok = false;
    }, this.wrap);
    return ok && numbers > 0;
  }

  private collectBatch(q: SessionPlayer, start: number, done: Set<number>): number[] {
    const batch: number[] = [];
    const queue = [start];
    done.add(start);
    const seen = new Set<number>();
    while (queue.length) {
      const fk = queue.pop()!;
      batch.push(fk);
      forEachNeighbor(keyX(fk), keyY(fk), (nx, ny) => {
        const nk = cellKey(nx, ny);
        if (seen.has(nk) || !this.sealedFor(q, nx, ny)) return;
        seen.add(nk);
        forEachNeighbor(nx, ny, (fx, fy) => {
          const k2 = cellKey(fx, fy);
          if (done.has(k2) || !q.flags.has(k2) || !this.settleableFor(q, fx, fy)) return;
          done.add(k2);
          queue.push(k2);
        }, this.wrap);
      }, this.wrap);
    }
    return batch;
  }

  /**
   * Judge one of `q`'s claim batches: all right, its mines become `q`'s bases
   * (+`basePoints` each); any wrong flag forfeits its mines (Lost), opens the
   * wrong flags (no points) and costs `basePoints` per wrong flag.
   */
  private settle(q: SessionPlayer, batch: number[]): void {
    const correct: number[] = [];
    const wrong: number[] = [];
    const x0 = keyX(batch[0]);
    let ax = 0;
    let ay = 0;
    for (const k of batch) {
      q.flags.delete(k);
      ax += deltaX(keyX(k), x0, this.wrap);
      ay += keyY(k);
      (this.world.truth(keyX(k), keyY(k)) === 1 ? correct : wrong).push(k);
    }
    const tainted = wrong.length > 0;
    for (const k of correct) this.setCell(keyX(k), keyY(k), tainted ? CellState.Lost : CellState.Owned, q.color + 1);
    for (const k of wrong) this.cascade(q, keyX(k), keyY(k));
    const bp = this.cfg.econ.basePoints;
    const payout = tainted ? 0 : correct.length * bp;
    q.score = Math.max(0, q.score + payout - wrong.length * bp);
    if (!tainted) for (const k of correct) this.claimAround(q, keyX(k), keyY(k));
    const n = batch.length;
    this.events.emit('settle', { color: q.color, x: this.wx(x0 + Math.round(ax / n)), y: Math.round(ay / n), cells: batch, correct: correct.length, wrong: wrong.length, payout });
  }

  /**
   * A new base of `q` takes the opened cells around it (user decision
   * 2026-09-22): every revealed neighbour becomes `q`'s land, another player's
   * included (their main base excepted; bases and lost mines stay whose they
   * are). Each cell taken scores `tilePoints` for `q` and costs its former
   * owner as much.
   */
  private claimAround(q: SessionPlayer, x: number, y: number): void {
    const mine = q.color + 1;
    const tp = this.cfg.econ.tilePoints;
    forEachNeighbor(x, y, (nx, ny) => {
      if (!isRevealed(this.board.get(nx, ny))) return;
      const prev = this.owners.get(nx, ny);
      if (prev === mine) return;
      const from = prev ? this.players.get(prev - 1) : undefined;
      if (from && from.main === cellKey(this.wx(nx), ny)) return;
      this.setCell(nx, ny, this.board.get(nx, ny), mine);
      q.score += tp;
      if (from) from.score = Math.max(0, from.score - tp);
    }, this.wrap);
  }

  private flush(by: number): void {
    this.touched = [];
    if (!this.changed.length) return;
    const cells = this.changed;
    this.changed = [];
    this.events.emit('cells', { by, cells });
  }

  private emitPlayers(): void {
    this.events.emit('players', this.playerInfo());
  }

  // ------------------------------------------------------------------ save

  toSave(): SessionSave {
    return {
      version: 1,
      id: this.id,
      seed: this.seed,
      world: {
        overrides: [...this.world.overrides.entries()],
        chunkPressure: [...this.world.chunkPressure.entries()],
        densityDebt: this.world.densityDebt,
        interventions: this.world.interventions,
      },
      chunks: this.snapshotChunks(),
      players: [...this.players.values()].map((p) => ({ token: p.token, color: p.color, score: p.score, main: p.main, flags: [...p.flags], deferred: [...p.deferred], lastSeen: p.lastSeen })),
      hits: this.hits,
    };
  }

  /** Players come back offline; the server marks them online when they reconnect. */
  static fromSave(d: SessionSave): Session {
    const s = new Session(d.id, d.seed);
    for (const [k, v] of d.world.overrides) s.world.overrides.set(k, v);
    for (const [k, v] of d.world.chunkPressure) s.world.chunkPressure.set(k, v);
    s.world.densityDebt = d.world.densityDebt;
    s.world.interventions = d.world.interventions;
    s.hits = d.hits;
    for (const p of d.players) {
      s.players.set(p.color, { token: p.token, color: p.color, score: p.score, main: p.main, flags: new Set(p.flags), cells: new Set(), deferred: new Set(p.deferred), online: false, lastSeen: p.lastSeen });
    }
    for (const [ck, states, owners] of d.chunks) {
      const c = base64Decode(states);
      const o = base64Decode(owners);
      s.board.chunks.set(ck, c);
      if (o.some((v) => v)) s.owners.chunks.set(ck, o);
      const bx = keyX(ck) * CHUNK;
      const by = keyY(ck) * CHUNK;
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        if (c[i] !== CellState.Unknown) s.opened++;
        if (!o[i]) continue;
        const p = s.players.get(o[i] - 1);
        if (p) p.cells.add(cellKey(bx + (i & 15), by + (i >> 4)));
        else o[i] = 0;
      }
    }
    s.board.recount();
    return s;
  }
}
