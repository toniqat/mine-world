import { ALL_TIERS, CellState, Game, Verdict, cellKey, keyX, keyY } from '@mine/core';

/** Seconds between two demo actions (a little jitter is added so it reads as a person). */
const ACTION_SEC = 0.22;
/** Half-size of the window the demo player solves around its focus. */
const WINDOW = 14;
/** The demo starts over on a fresh world after this many actions. */
const MAX_ACTIONS = 600;

/**
 * Title-screen demo: a throwaway world (never saved) played by a small bot.
 * It solves the window around the cell it last touched with every solver
 * tier, works through the verdicts nearest to that cell first and, when
 * nothing is determined, guesses the least likely mine it can see.
 */
export class DemoPlayer {
  game: Game;
  /** Cell the demo last acted on: the camera follows it. */
  focus = { x: 0, y: 0 };
  private queue: Array<{ key: number; verdict: Verdict }> = [];
  /** Mine odds from the last solve, for guessing when nothing is determined. */
  private lastOdds = new Map<number, number>();
  private wait = 0.8;
  private actions = 0;
  private rng: () => number;

  constructor(seed = (Date.now() % 1_000_000) + 1) {
    this.rng = mulberry32(seed ^ 0x5eed);
    this.game = DemoPlayer.world(seed);
  }

  private static world(seed: number): Game {
    // No mining tiers: the bot would stall at the first locked ring.
    return new Game({ seed, tiers: { enabled: false } } as never);
  }

  /** True when the demo started over this call (the caller rebinds the view). */
  tick(dt: number): boolean {
    this.wait -= dt;
    if (this.wait > 0) return false;
    this.wait = ACTION_SEC * (0.6 + 0.8 * this.rng());
    if (this.actions >= MAX_ACTIONS) {
      this.game = DemoPlayer.world(Math.floor(this.rng() * 1_000_000) + 1);
      this.queue = [];
      this.actions = 0;
      this.focus = { x: 0, y: 0 };
      this.wait = 0.8;
      return true;
    }
    this.act();
    return false;
  }

  private act(): void {
    const g = this.game;
    this.actions++;
    if (!g.world.started) return void g.reveal(0, 0);
    // Drop verdicts made stale by earlier actions, then take the one nearest the focus.
    this.queue = this.queue.filter((q) => g.cellState(keyX(q.key), keyY(q.key)) === CellState.Unknown);
    if (!this.queue.length) this.solve();
    const next = this.queue.shift();
    if (!next) return this.guess();
    const x = keyX(next.key);
    const y = keyY(next.key);
    this.focus = { x, y };
    if (next.verdict === Verdict.Safe) g.reveal(x, y);
    else g.setFlag(x, y, true);
  }

  private solve(): void {
    const { x, y } = this.focus;
    const res = this.game.analyze(x - WINDOW, y - WINDOW, x + WINDOW, y + WINDOW, 'belief', ALL_TIERS);
    this.lastOdds = res.probabilities;
    const d = (k: number) => Math.hypot(keyX(k) - x, keyY(k) - y);
    this.queue = [...res.verdicts].map(([key, verdict]) => ({ key, verdict })).sort((a, b) => d(a.key) - d(b.key));
    // Work outwards along a path instead of jumping back and forth across the window.
    for (let i = 1; i < this.queue.length; i++) {
      const prev = this.queue[i - 1].key;
      let best = i;
      let bestD = Infinity;
      for (let j = i; j < Math.min(this.queue.length, i + 24); j++) {
        const k = this.queue[j].key;
        const dd = Math.hypot(keyX(k) - keyX(prev), keyY(k) - keyY(prev));
        if (dd < bestD) (bestD = dd), (best = j);
      }
      [this.queue[i], this.queue[best]] = [this.queue[best], this.queue[i]];
    }
  }

  /** Nothing determined: open the least likely mine among the odds, else a random frontier cell. */
  private guess(): void {
    const g = this.game;
    let pick: number | null = null;
    let best = Infinity;
    for (const [k, p] of this.lastOdds) {
      if (g.cellState(keyX(k), keyY(k)) !== CellState.Unknown || g.fogged(keyX(k), keyY(k))) continue;
      const score = p + 0.004 * Math.hypot(keyX(k) - this.focus.x, keyY(k) - this.focus.y);
      if (score < best) (best = score), (pick = k);
    }
    if (pick === null) pick = this.frontierCell();
    this.lastOdds = new Map();
    if (pick === null) return;
    this.focus = { x: keyX(pick), y: keyY(pick) };
    g.reveal(this.focus.x, this.focus.y);
  }

  /** A random Unknown cell next to an opened one, searched in growing rings around the focus. */
  private frontierCell(): number | null {
    const g = this.game;
    for (let r = 1; r <= 40; r++) {
      const found: number[] = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = this.focus.x + dx;
          const y = this.focus.y + dy;
          if (g.cellState(x, y) !== CellState.Unknown) continue;
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
      if ((dx || dy) && s !== CellState.Unknown && s !== CellState.Flag) return true;
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
