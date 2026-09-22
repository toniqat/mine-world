import { describe, expect, it } from 'vitest';
import {
  CellState,
  MULTI,
  MirrorGame,
  Session,
  base64Decode,
  base64Encode,
  cellKey,
  forEachNeighbor,
  isKnownMine,
  isRevealed,
  keyX,
  keyY,
  numberOf,
  type ClientMsg,
  type SessionEvents,
  type SessionPlayer,
} from '../src';

/** Cell of a longitude / latitude on the Earth map. */
const at = (lon: number, lat: number) => ({ x: Math.floor((lon + 180) * 4), y: Math.floor((90 - lat) * 4) });
const SAHARA = at(10, 23);
const SIBERIA = at(100, 62);

let clock = 1_000;
function session(seed = 11): Session {
  return new Session('s1', seed);
}
function join(s: Session, token: string): SessionPlayer {
  return s.addPlayer(token, clock++, () => 0.5)!;
}

/** Every revealed number equals the mines around it by the world's truth (known mines count as mines). */
function expectConsistent(s: Session): void {
  let checked = 0;
  s.board.forEachCell((x, y, st) => {
    if (!isRevealed(st)) return;
    let n = 0;
    forEachNeighbor(x, y, (nx, ny) => {
      const t = s.board.get(nx, ny);
      if (isKnownMine(t)) n++;
      else if (!isRevealed(t)) n += s.world.truth(nx, ny);
    }, s.wrap);
    expect(numberOf(st)).toBe(n);
    checked++;
  });
  expect(checked).toBeGreaterThan(0);
}

/**
 * A cheating bot for `p`: opens safe closed neighbours of its land and flags
 * the mines, reading the truth. `steps` actions at most.
 */
function play(s: Session, p: SessionPlayer, steps: number): void {
  for (let i = 0; i < steps; i++) {
    let target: { x: number; y: number; mine: boolean } | null = null;
    for (const k of p.cells) {
      forEachNeighbor(keyX(k), keyY(k), (x, y) => {
        if (target || s.board.get(x, y) !== CellState.Unknown || p.flags.has(cellKey(x, y))) return;
        target = { x, y, mine: s.world.truth(x, y) === 1 };
      }, s.wrap);
      if (target) break;
    }
    if (!target) return;
    const t = target as { x: number; y: number; mine: boolean };
    if (t.mine) s.flag(p.color, t.x, t.y, true);
    else s.reveal(p.color, t.x, t.y);
  }
}

function events(s: Session) {
  const log: { [K in keyof SessionEvents]: SessionEvents[K][] } = { cells: [], blast: [], settle: [], players: [], gameover: [], finished: [] };
  for (const k of Object.keys(log) as Array<keyof SessionEvents>) s.events.on(k, (e) => (log[k] as unknown[]).push(e));
  return log;
}

describe('multiplayer session', () => {
  it('gives every player a different colour and stops at the player limit', () => {
    const s = session();
    const colors = new Set<number>();
    for (let i = 0; i < MULTI.maxPlayers; i++) colors.add(s.addPlayer(`t${i}`, 0)!.color);
    expect(colors.size).toBe(MULTI.maxPlayers);
    expect(s.addPlayer('late', 0)).toBeNull();
    expect(s.joinable()).toBe(false);
  });

  it('places the main base on the first click: its 5x5 is mine-free and opens, scoring every opened cell', () => {
    const s = session();
    const a = join(s, 'a');
    expect(s.reveal(a.color, SAHARA.x, SAHARA.y)).toEqual({ ok: true });
    expect(a.main).toBe(cellKey(SAHARA.x, SAHARA.y));
    expect(s.board.get(SAHARA.x, SAHARA.y)).toBe(CellState.RevealedBase);
    const r = MULTI.startRadius;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) expect(isRevealed(s.board.get(SAHARA.x + dx, SAHARA.y + dy))).toBe(true);
    expect(a.cells.size).toBeGreaterThanOrEqual((2 * r + 1) ** 2);
    expect(a.score).toBe(a.cells.size);
    for (const k of a.cells) expect(s.owners.get(keyX(k), keyY(k))).toBe(a.color + 1);
    expectConsistent(s);
  });

  it('refuses a main base on water or next to land already opened', () => {
    const s = session();
    const a = join(s, 'a');
    const b = join(s, 'b');
    const sea = at(-150, 0);
    expect(s.reveal(a.color, sea.x, sea.y)).toEqual({ ok: false, error: 'water' });
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    let edge = SAHARA.x;
    while (s.board.get(edge + 1, SAHARA.y) !== CellState.Unknown) edge++;
    expect(s.reveal(b.color, edge + 1, SAHARA.y)).toEqual({ ok: false, error: 'tooClose' });
    expect(b.main).toBeNull();
    expect(s.reveal(b.color, SIBERIA.x, SIBERIA.y)).toEqual({ ok: true });
    expect(b.main).not.toBeNull();
  });

  it('keeps flags private: they settle into their owner\'s bases (+basePoints) and never block anyone else', () => {
    const s = session();
    const a = join(s, 'a');
    const log = events(s);
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    play(s, a, 400);
    const owned = [...a.cells].filter((k) => s.board.get(keyX(k), keyY(k)) === CellState.Owned);
    expect(owned.length).toBeGreaterThan(0);
    expect(log.settle.every((e) => e.color === a.color && e.wrong === 0)).toBe(true);
    const opened = [...a.cells].filter((k) => isRevealed(s.board.get(keyX(k), keyY(k)))).length;
    expect(a.score).toBe(opened + owned.length * 5);
    // Flags never reach the shared board.
    let flagsOnBoard = 0;
    s.board.forEachCell((_x, _y, st) => void (st === CellState.Flag && flagsOnBoard++));
    expect(flagsOnBoard).toBe(0);
    expectConsistent(s);
  });

  it('turns a flag between two players\' land into a base that takes the opened cells around it', () => {
    const s = session();
    const a = join(s, 'a');
    const b = join(s, 'b');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    // A opens safe cells only, so the mines along A's edge stay closed and unflagged.
    for (let i = 0; i < 60; i++) {
      let safe: { x: number; y: number } | null = null;
      for (const k of a.cells) {
        forEachNeighbor(keyX(k), keyY(k), (x, y) => void (!safe && s.board.get(x, y) === CellState.Unknown && s.world.truth(x, y) === 0 && (safe = { x, y })), s.wrap);
        if (safe) break;
      }
      if (!safe) break;
      const c = safe as { x: number; y: number };
      s.reveal(a.color, c.x, c.y);
    }
    s.reveal(b.color, SIBERIA.x, SIBERIA.y);
    // A mine on A's edge, away from A's main base, and next to at least two of A's cells.
    let mine: { x: number; y: number } | null = null;
    for (const k of a.cells) {
      forEachNeighbor(keyX(k), keyY(k), (x, y) => {
        if (mine || s.board.get(x, y) !== CellState.Unknown || s.world.truth(x, y) !== 1) return;
        if (Math.max(Math.abs(x - SAHARA.x), Math.abs(y - SAHARA.y)) < 3) return;
        let aNear = 0;
        forEachNeighbor(x, y, (nx, ny) => void (s.owners.get(nx, ny) === a.color + 1 && isRevealed(s.board.get(nx, ny)) && aNear++), s.wrap);
        if (aNear >= 2) mine = { x, y };
      }, s.wrap);
    }
    expect(mine).not.toBeNull();
    const m = mine as unknown as { x: number; y: number };
    const aBefore = new Set(a.cells);
    const aScore = a.score;
    // B flags it and clears everything around the numbers next to it (flagging the other mines there).
    s.flag(b.color, m.x, m.y, true);
    for (let round = 0; round < 50 && s.board.get(m.x, m.y) === CellState.Unknown; round++) {
      let acted = false;
      forEachNeighbor(m.x, m.y, (nx, ny) => {
        const st = s.board.get(nx, ny);
        if (!isRevealed(st) || numberOf(st) === 0) return;
        forEachNeighbor(nx, ny, (cx, cy) => {
          if (acted || s.board.get(cx, cy) !== CellState.Unknown || b.flags.has(cellKey(cx, cy))) return;
          acted = true;
          if (s.world.truth(cx, cy) === 1) s.flag(b.color, cx, cy, true);
          else s.reveal(b.color, cx, cy);
        }, s.wrap);
      }, s.wrap);
      if (!acted) {
        // Everything is sealed for B: any opening settles the flag (B's own land is far away).
        let far: { x: number; y: number } | null = null;
        for (const k of b.cells) forEachNeighbor(keyX(k), keyY(k), (x, y) => void (!far && s.board.get(x, y) === CellState.Unknown && s.world.truth(x, y) === 0 && (far = { x, y })), s.wrap);
        const f = far as unknown as { x: number; y: number };
        s.reveal(b.color, f.x, f.y);
      }
    }
    expect(s.board.get(m.x, m.y)).toBe(CellState.Owned);
    expect(s.owners.get(m.x, m.y)).toBe(b.color + 1);
    let taken = 0;
    forEachNeighbor(m.x, m.y, (nx, ny) => {
      if (!isRevealed(s.board.get(nx, ny))) return;
      expect(s.owners.get(nx, ny)).toBe(b.color + 1);
      if (aBefore.has(cellKey(nx, ny))) taken++;
    }, s.wrap);
    expect(taken).toBeGreaterThanOrEqual(2);
    // Every cell B took from A moved a point with it (the scenario gives A nothing else).
    const lost = [...aBefore].filter((k) => s.owners.get(keyX(k), keyY(k)) === b.color + 1).length;
    expect(lost).toBeGreaterThanOrEqual(taken);
    expect(a.score).toBe(aScore - lost);
    expect(a.main).toBe(cellKey(SAHARA.x, SAHARA.y));
    expect(s.owners.get(SAHARA.x, SAHARA.y)).toBe(a.color + 1);
    expectConsistent(s);
  });

  it('opens a cell another player flagged, and drops that flag', () => {
    const s = session();
    const a = join(s, 'a');
    const b = join(s, 'b');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    play(s, a, 30);
    // A safe closed cell next to A's land, flagged (wrongly) by B.
    let safe: { x: number; y: number } | null = null;
    for (const k of a.cells) {
      forEachNeighbor(keyX(k), keyY(k), (x, y) => {
        if (!safe && s.board.get(x, y) === CellState.Unknown && s.world.truth(x, y) === 0) safe = { x, y };
      }, s.wrap);
    }
    expect(safe).not.toBeNull();
    const c = safe as unknown as { x: number; y: number };
    s.reveal(b.color, SIBERIA.x, SIBERIA.y);
    expect(s.flag(b.color, c.x, c.y, true)).toEqual({ ok: true });
    expect(b.flags.has(cellKey(c.x, c.y))).toBe(true);
    s.reveal(a.color, c.x, c.y);
    expect(isRevealed(s.board.get(c.x, c.y))).toBe(true);
    expect(b.flags.has(cellKey(c.x, c.y))).toBe(false);
  });

  it('chords with the player\'s own flags only', () => {
    const s = session();
    const a = join(s, 'a');
    const b = join(s, 'b');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    s.reveal(b.color, SIBERIA.x, SIBERIA.y);
    // A number of A's with closed neighbours, all its mines flagged by B only.
    let num: { x: number; y: number } | null = null;
    for (const k of a.cells) {
      const x = keyX(k), y = keyY(k);
      const st = s.board.get(x, y);
      if (!isRevealed(st) || numberOf(st) === 0) continue;
      let unknown = 0, mines = 0;
      forEachNeighbor(x, y, (nx, ny) => {
        if (s.board.get(nx, ny) !== CellState.Unknown) return;
        unknown++;
        mines += s.world.truth(nx, ny);
      }, s.wrap);
      if (unknown > mines && mines === numberOf(st)) { num = { x, y }; break; }
    }
    expect(num).not.toBeNull();
    const n = num as unknown as { x: number; y: number };
    forEachNeighbor(n.x, n.y, (nx, ny) => void (s.board.get(nx, ny) === CellState.Unknown && s.world.truth(nx, ny) === 1 && s.flag(b.color, nx, ny, true)), s.wrap);
    const before = s.board.revealedCount;
    s.chord(a.color, n.x, n.y);
    expect(s.board.revealedCount).toBe(before);
    // With A's own flags the chord opens the rest.
    forEachNeighbor(n.x, n.y, (nx, ny) => void (s.board.get(nx, ny) === CellState.Unknown && s.world.truth(nx, ny) === 1 && s.flag(a.color, nx, ny, true)), s.wrap);
    s.chord(a.color, n.x, n.y);
    expect(s.board.revealedCount).toBeGreaterThan(before);
    expectConsistent(s);
  });

  it('ends the game on a mine: a blast for everyone, the player\'s land back to Unknown, others untouched', () => {
    const s = session();
    const a = join(s, 'a');
    const b = join(s, 'b');
    const log = events(s);
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    s.reveal(b.color, SIBERIA.x, SIBERIA.y);
    play(s, a, 200);
    play(s, b, 50);
    const bCells = new Map([...b.cells].map((k) => [k, s.board.get(keyX(k), keyY(k))]));
    const aCells = [...a.cells];
    expect(aCells.some((k) => s.board.get(keyX(k), keyY(k)) === CellState.Owned)).toBe(true);
    // A steps on a mine next to their land.
    let mine: { x: number; y: number } | null = null;
    for (const k of aCells) {
      forEachNeighbor(keyX(k), keyY(k), (x, y) => {
        if (!mine && s.board.get(x, y) === CellState.Unknown && s.world.truth(x, y) === 1 && !a.flags.has(cellKey(x, y))) mine = { x, y };
      }, s.wrap);
    }
    expect(mine).not.toBeNull();
    const m = mine as unknown as { x: number; y: number };
    const score = a.score;
    s.reveal(a.color, m.x, m.y);
    expect(log.blast).toHaveLength(1);
    expect(log.blast[0]).toMatchObject({ x: m.x, y: m.y, color: a.color });
    expect(log.gameover).toEqual([{ color: a.color, token: 'a', score }]);
    expect(s.players.has(a.color)).toBe(false);
    for (const k of aCells) {
      expect(s.board.get(keyX(k), keyY(k))).toBe(CellState.Unknown);
      expect(s.owners.get(keyX(k), keyY(k))).toBe(0);
    }
    expect(s.board.get(m.x, m.y)).toBe(CellState.Unknown);
    for (const [k, st] of bCells) expect(s.board.get(keyX(k), keyY(k))).toBe(st);
    // The mine is still there for the next player.
    expect(s.world.truth(m.x, m.y)).toBe(1);
    expectConsistent(s);
  });

  it('lets a new main base go where a fallen player started', () => {
    const s = session();
    const a = join(s, 'a');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    let mine: { x: number; y: number } | null = null;
    for (const k of a.cells) {
      forEachNeighbor(keyX(k), keyY(k), (x, y) => {
        if (!mine && s.board.get(x, y) === CellState.Unknown && s.world.truth(x, y) === 1) mine = { x, y };
      }, s.wrap);
    }
    const m = mine as unknown as { x: number; y: number };
    s.reveal(a.color, m.x, m.y);
    expect(s.players.size).toBe(0);
    const b = join(s, 'b');
    expect(s.reveal(b.color, SAHARA.x, SAHARA.y)).toEqual({ ok: true });
    expect(b.main).toBe(cellKey(SAHARA.x, SAHARA.y));
    expectConsistent(s);
  });

  it('lets a player offline too long go, leaving their land uncoloured', () => {
    const s = session();
    const a = join(s, 'a');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    const cells = [...a.cells];
    s.setOnline(a.color, false, 5_000);
    expect(s.dropIdle(5_000 + MULTI.idleKickMs - 1)).toEqual([]);
    expect(s.dropIdle(5_000 + MULTI.idleKickMs)).toEqual(['a']);
    expect(s.players.size).toBe(0);
    for (const k of cells) {
      expect(isRevealed(s.board.get(keyX(k), keyY(k)))).toBe(true);
      expect(s.owners.get(keyX(k), keyY(k))).toBe(0);
    }
  });

  it('counts the opened share of the land', () => {
    const s = session();
    const a = join(s, 'a');
    expect(s.unlockRatio()).toBe(0);
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    expect(s.unlockRatio()).toBeCloseTo(a.cells.size / s.landCells, 10);
    expect(s.landCells).toBeGreaterThan(200_000);
  });

  it('stops taking new players at the join limit, and takes them again when the share drops', () => {
    const s = session();
    join(s, 'a');
    // Pretend the map is opened up to the limit, then a game over takes a cell back.
    const set = (ratio: number) => ((s as unknown as { opened: number }).opened = Math.ceil(ratio * s.landCells));
    set(MULTI.joinMaxUnlock);
    expect(s.joinable()).toBe(false);
    set(MULTI.joinMaxUnlock - 1 / s.landCells);
    expect(s.joinable()).toBe(true);
  });

  it('completes at the end share: the standings are final, actions are refused, nobody joins', () => {
    const s = session();
    const log = events(s);
    const a = join(s, 'a');
    const b = join(s, 'b');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    s.reveal(b.color, SIBERIA.x, SIBERIA.y);
    expect(s.final).toBeNull();
    // Just under the end share; b's next opening crosses it.
    (s as unknown as { opened: number }).opened = Math.ceil(MULTI.endUnlock * s.landCells) - 1;
    play(s, b, 20);
    expect(log.finished.length).toBe(1);
    const final = log.finished[0];
    expect(s.final).toEqual(final);
    expect(final.map((p) => p.color).sort()).toEqual([a.color, b.color].sort());
    expect(final[0].score).toBeGreaterThanOrEqual(final[1].score);
    expect(log.cells.at(-1)!.unlock).toBeGreaterThanOrEqual(MULTI.endUnlock);
    expect(s.joinable()).toBe(false);
    const before = s.unlockRatio();
    const scores = s.playerInfo().map((p) => p.score);
    expect(s.reveal(a.color, SAHARA.x + 40, SAHARA.y)).toEqual({ ok: false });
    expect(s.flag(a.color, SAHARA.x + 40, SAHARA.y, true)).toEqual({ ok: false });
    play(s, a, 20);
    expect(s.unlockRatio()).toBe(before);
    expect(s.playerInfo().map((p) => p.score)).toEqual(scores);
    expect(log.finished.length).toBe(1);
    const t = Session.fromSave(JSON.parse(JSON.stringify(s.toSave())));
    expect(t.final).toEqual(final);
    expect(t.joinable()).toBe(false);
  });

  it('round-trips through a save', () => {
    const s = session();
    const a = join(s, 'a');
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    play(s, a, 150);
    s.flag(a.color, 0, 300, true);
    const t = Session.fromSave(JSON.parse(JSON.stringify(s.toSave())));
    const a2 = t.players.get(a.color)!;
    expect(a2).toMatchObject({ token: 'a', score: a.score, main: a.main, online: false });
    expect([...a2.cells].sort()).toEqual([...a.cells].sort());
    expect([...a2.flags].sort()).toEqual([...a.flags].sort());
    expect(t.unlockRatio()).toBeCloseTo(s.unlockRatio(), 12);
    s.board.forEachCell((x, y, st) => expect(t.board.get(x, y)).toBe(st));
    play(t, a2, 50);
    expectConsistent(t);
  });
});

describe('multiplayer mirror', () => {
  it('encodes base64 both ways', () => {
    for (const n of [0, 1, 2, 3, 255, 256]) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
      expect([...base64Decode(base64Encode(b))]).toEqual([...b]);
    }
  });

  it('mirrors the session board and owners, sends actions and keeps flags local', () => {
    const s = session();
    const a = join(s, 'a');
    const b = join(s, 'b');
    s.reveal(b.color, SIBERIA.x, SIBERIA.y);
    const welcome = { t: 'welcome' as const, token: 'a', session: s.id, seed: s.seed, you: a.color, players: s.playerInfo(), chunks: s.snapshotChunks(), flags: [], unlock: s.unlockRatio(), final: null };
    const m = new MirrorGame(welcome);
    const sent: ClientMsg[] = [];
    m.send = (msg) => sent.push(msg);
    s.events.on('cells', (e) => m.applyCells(e.cells));
    s.events.on('players', (p) => m.setPlayers(p));
    expect(m.world.started).toBe(false);
    s.board.forEachCell((x, y, st) => expect(m.cellState(x, y)).toBe(st));
    expect(m.cellOwner(SIBERIA.x, SIBERIA.y)).toBe(b.color);
    // Opening is only sent; the server's answer updates the mirror.
    m.reveal(SAHARA.x, SAHARA.y);
    expect(sent).toEqual([{ t: 'reveal', x: SAHARA.x, y: SAHARA.y }]);
    expect(m.cellState(SAHARA.x, SAHARA.y)).toBe(CellState.Unknown);
    s.reveal(a.color, SAHARA.x, SAHARA.y);
    expect(m.cellState(SAHARA.x, SAHARA.y)).toBe(CellState.RevealedBase);
    expect(m.cellOwner(SAHARA.x, SAHARA.y)).toBe(a.color);
    expect(m.world.started).toBe(true);
    expect(m.startCell()).toEqual({ x: SAHARA.x, y: SAHARA.y });
    expect(m.mainBases()).toHaveLength(2);
    // A flag is placed locally and sent.
    let closed: { x: number; y: number } | null = null;
    for (const k of a.cells) forEachNeighbor(keyX(k), keyY(k), (x, y) => void (!closed && s.board.get(x, y) === CellState.Unknown && (closed = { x, y })), s.wrap);
    const c = closed as unknown as { x: number; y: number };
    m.cycleMark(c.x, c.y);
    expect(m.cellState(c.x, c.y)).toBe(CellState.Flag);
    expect(sent.at(-1)).toEqual({ t: 'flag', x: c.x, y: c.y, on: true });
  });
});
