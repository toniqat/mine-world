import { ALL_TIERS, CellState, Game, Verdict, cellKey, keyX, keyY } from '@mine/core';

/** Seconds between two demo actions (a little jitter is added so it reads as a person). */
const ACTION_SEC = 0.44;
/** The demo digs one area: nothing farther than this from the start is touched. */
const REACH = 30;
/** Weight of the distance to the last cell against the distance to the start when picking the next cell. */
const TRAIL = 0.6;
/** Guesses in a row (nothing determined in between) before the demo counts itself stuck. */
const MAX_GUESSES = 3;
/** A world ends after this many actions at the latest. */
const MAX_ACTIONS = 500;

/**
 * Title-screen demo: a throwaway world (never saved) played by a small bot.
 * It digs outwards from the start as one growing patch: it solves the patch
 * with every solver tier and takes the verdict closest to the start (and to
 * the cell it last touched). When nothing is determined it guesses the least
 * likely mine it can see; once walls and guesses leave it nowhere to go
 * (a few guesses in a row, nothing left in reach) the world is over, and the
 * caller fades to black and starts the next one (`next`).
 */
export class DemoPlayer {
  game: Game;
  /** Cell the demo last acted on. */
  focus = { x: 0, y: 0 };
  /** Where the camera should look: drifts slowly after the focus, so the view stays calm. */
  view = { x: 0, y: 0 };
  /** No move left: the caller should fade out and call `next`. */
  over = false;
  private queue: Array<{ key: number; verdict: Verdict }> = [];
  /** Mine odds from the last solve, for guessing when nothing is determined. */
  private lastOdds = new Map<number, number>();
  private wait = 0.8;
  private actions = 0;
  private guesses = 0;
  private rng: () => number;

  constructor(seed = (Date.now() % 1_000_000) + 1) {
    this.rng = mulberry32(seed ^ 0x5eed);
    this.game = DemoPlayer.world(seed);
  }

  private static world(seed: number): Game {
    // No mining tiers (the bot would stall at the first locked ring) and no pool cap.
    return new Game({ seed, tiers: { enabled: false }, econ: { storageBase: Infinity } } as never);
  }

  /** A fresh world (while the screen is black). */
  next(): void {
    this.game = DemoPlayer.world(Math.floor(this.rng() * 1_000_000) + 1);
    this.queue = [];
    this.lastOdds = new Map();
    this.actions = 0;
    this.guesses = 0;
    this.focus = { x: 0, y: 0 };
    this.view = { x: 0, y: 0 };
    this.over = false;
    this.wait = 0.8;
  }

  tick(dt: number): void {
    const k = 1 - Math.exp(-dt * 0.35);
    this.view.x += (this.focus.x - this.view.x) * k;
    this.view.y += (this.focus.y - this.view.y) * k;
    if (this.over) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = ACTION_SEC * (0.6 + 0.8 * this.rng());
    if (this.actions >= MAX_ACTIONS) return void (this.over = true);
    this.act();
  }

  private act(): void {
    const g = this.game;
    this.actions++;
    if (!g.world.started) return void g.reveal(0, 0);
    // Drop verdicts made stale by earlier actions, then take the best one.
    this.queue = this.queue.filter((q) => g.cellState(keyX(q.key), keyY(q.key)) === CellState.Unknown);
    if (!this.queue.length) this.solve();
    const next = this.queue.shift();
    if (!next) return this.guess();
    this.guesses = 0;
    const x = keyX(next.key);
    const y = keyY(next.key);
    this.focus = { x, y };
    if (next.verdict === Verdict.Safe) g.reveal(x, y);
    else g.setFlag(x, y, true);
  }

  /** How far a cell is from where the demo wants to dig: the start first, then near the last cell. */
  private score(k: number, from = this.focus): number {
    const s = this.game.startCell();
    return Math.hypot(keyX(k) - s.x, keyY(k) - s.y) + TRAIL * Math.hypot(keyX(k) - from.x, keyY(k) - from.y);
  }

  private inReach(k: number): boolean {
    const s = this.game.startCell();
    return Math.hypot(keyX(k) - s.x, keyY(k) - s.y) <= REACH;
  }

  private solve(): void {
    const s = this.game.startCell();
    const r = REACH + 1;
    const res = this.game.analyze(s.x - r, s.y - r, s.x + r, s.y + r, 'belief', ALL_TIERS);
    this.lastOdds = res.probabilities;
    const list = [...res.verdicts].filter(([key]) => this.inReach(key)).map(([key, verdict]) => ({ key, verdict }));
    // Greedy chain: each next cell is the best-scored one from where the previous left off.
    this.queue = [];
    let from = this.focus;
    while (list.length && this.queue.length < 24) {
      let best = 0;
      for (let i = 1; i < list.length; i++) if (this.score(list[i].key, from) < this.score(list[best].key, from)) best = i;
      const [q] = list.splice(best, 1);
      this.queue.push(q);
      from = { x: keyX(q.key), y: keyY(q.key) };
    }
  }

  /** Nothing determined: open the least likely mine in reach, else a frontier cell; stuck when neither exists or guessing goes on. */
  private guess(): void {
    const g = this.game;
    if (++this.guesses > MAX_GUESSES) return void (this.over = true);
    let pick: number | null = null;
    let best = Infinity;
    for (const [k, p] of this.lastOdds) {
      if (!this.inReach(k) || g.cellState(keyX(k), keyY(k)) !== CellState.Unknown || g.fogged(keyX(k), keyY(k))) continue;
      const score = p + 0.004 * this.score(k);
      if (score < best) (best = score), (pick = k);
    }
    if (pick === null) pick = this.frontierCell();
    this.lastOdds = new Map();
    if (pick === null) return void (this.over = true);
    this.focus = { x: keyX(pick), y: keyY(pick) };
    g.reveal(this.focus.x, this.focus.y);
  }

  /** A random Unknown cell next to an opened one, in reach, searched in growing rings around the focus. */
  private frontierCell(): number | null {
    const g = this.game;
    for (let r = 1; r <= REACH; r++) {
      const found: number[] = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = this.focus.x + dx;
          const y = this.focus.y + dy;
          if (g.cellState(x, y) !== CellState.Unknown || g.fogged(x, y) || !this.inReach(cellKey(x, y))) continue;
          if (hasOpenNeighbour(g, x, y)) found.push(cellKey(x, y));
        }
      }
      if (found.length) return found[Math.floor(this.rng() * found.length)];
    }
    return null;
  }
}

function hasOpenNeighbour(g: Game, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const s = g.cellState(x + dx, y + dy);
      if ((dx || dy) && s !== CellState.Unknown && s !== CellState.Flag && s !== CellState.Mountain && s !== CellState.Water) return true;
    }
  }
  return false;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
