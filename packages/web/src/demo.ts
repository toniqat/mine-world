import { ALL_TIERS, CellState, Game, Verdict, cellKey, keyX, keyY } from '@mine/core';

/** Seconds between two demo actions (a little jitter is added so it reads as a person). */
const ACTION_SEC = 0.44;
/** The demo digs a corridor along one heading: at most this far to either side of its axis... */
const HALF_WIDTH = 12;
/** ...and this far behind the start. Forward it is only bounded by `MAX_ACTIONS`. */
const BEHIND = 6;
/** Cost of a tile of sideways offset against a tile of progress along the heading when picking the next cell. */
const SIDEWAYS = 0.5;
/** Weight of the distance to the last cell when picking the next cell (keeps the order local). */
const TRAIL = 0.6;
/** Half size of the window solved around the last cell (the whole corridor is solved only when it finds nothing). */
const WINDOW = 22;
/** The camera trails the farthest point dug along the heading by this many tiles, and never moves back. */
const CAMERA_LAG = 4;
/** Top camera speed (tiles/s) and how fast it eases between speeds (1/s). */
const CAMERA_SPEED = 2.2;
const CAMERA_EASE = 1.2;
/** Guesses in a row (nothing determined in between) before the demo counts itself stuck. */
const MAX_GUESSES = 3;
/** A world ends after this many actions at the latest. */
const MAX_ACTIONS = 500;

/**
 * Title-screen demo: a throwaway world (never saved) played by a small bot.
 * It digs a corridor from the start along one heading (mostly left or right,
 * since screens are wide): it solves around the cell it last touched with
 * every solver tier and takes the verdict farthest along the heading (and
 * near the axis and the last cell), so the dig front and the camera move one
 * way instead of circling the start. When nothing is determined it guesses
 * the least likely mine it can see; once walls and guesses leave it nowhere
 * to go (a few guesses in a row, nothing left in the corridor) the world is
 * over, and the caller fades to black and starts the next one (`next`).
 */
export class DemoPlayer {
  game: Game;
  /** Cell the demo last acted on. */
  focus = { x: 0, y: 0 };
  /** Where the camera should look: glides along the heading after the dig front, never sideways or back. */
  view = { x: 0, y: 0 };
  /** Unit vector the corridor runs along. */
  private dir = { x: 1, y: 0 };
  /** Distance along the heading the camera aims at (only grows). */
  private camAlong = 0;
  /** Where the camera is along the heading, and its speed: it follows `camAlong` with eased speed, so it never lurches. */
  private camPos = 0;
  private camVel = 0;
  /** Farthest distance along the heading any action has reached. */
  private tip = 0;
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
    this.pickHeading();
  }

  /** Left or right, tilted up to about ±25°. */
  private pickHeading(): void {
    const a = (this.rng() < 0.5 ? 0 : Math.PI) + (this.rng() - 0.5) * 0.9;
    this.dir = { x: Math.cos(a), y: Math.sin(a) };
    this.camAlong = 0;
    this.camPos = 0;
    this.camVel = 0;
    this.tip = 0;
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
    this.pickHeading();
  }

  tick(dt: number): void {
    const s = this.game.world.started ? this.game.startCell() : { x: 0, y: 0 };
    // Speed eases towards one proportional to the distance left (capped), so
    // the camera glides at a steady pace instead of jumping with every advance.
    const want = Math.min(CAMERA_SPEED, Math.max(0, (this.camAlong - this.camPos) * 0.3));
    this.camVel += (want - this.camVel) * (1 - Math.exp(-dt * CAMERA_EASE));
    this.camPos += this.camVel * dt;
    this.view = { x: s.x + this.dir.x * this.camPos, y: s.y + this.dir.y * this.camPos };
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
    this.moveFocus(x, y);
    if (next.verdict === Verdict.Safe) g.reveal(x, y);
    else g.setFlag(x, y, true);
  }

  private moveFocus(x: number, y: number): void {
    this.focus = { x, y };
    this.tip = Math.max(this.tip, this.axis(cellKey(x, y)).along);
    this.camAlong = Math.max(this.camAlong, this.tip - CAMERA_LAG);
  }

  /** A cell's position in corridor coordinates: distance along the heading and sideways from the axis. */
  private axis(k: number): { along: number; side: number } {
    const s = this.game.startCell();
    const dx = keyX(k) - s.x;
    const dy = keyY(k) - s.y;
    return { along: dx * this.dir.x + dy * this.dir.y, side: Math.abs(dy * this.dir.x - dx * this.dir.y) };
  }

  /** Lower is better: far along the heading, near the axis, near the cell `from`. */
  private score(k: number, from = this.focus): number {
    const a = this.axis(k);
    return -a.along + SIDEWAYS * a.side + TRAIL * Math.hypot(keyX(k) - from.x, keyY(k) - from.y);
  }

  private inReach(k: number): boolean {
    const a = this.axis(k);
    return a.along >= -BEHIND && a.side <= HALF_WIDTH;
  }

  /** Verdicts near the last cell; the whole corridor dug so far when there are none. */
  private solve(): void {
    const f = this.focus;
    const res = this.analyze(f.x - WINDOW, f.y - WINDOW, f.x + WINDOW, f.y + WINDOW);
    if (res.verdicts.size || this.tip < WINDOW) return this.plan(res);
    // Bounding box of the corridor from behind the start to just past the tip.
    const s = this.game.startCell();
    const d = this.dir;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const along of [-BEHIND, this.tip + 3]) {
      for (const side of [-HALF_WIDTH, HALF_WIDTH]) {
        xs.push(s.x + d.x * along - d.y * side);
        ys.push(s.y + d.y * along + d.x * side);
      }
    }
    this.plan(this.analyze(Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))));
  }

  private analyze(x0: number, y0: number, x1: number, y1: number) {
    return this.game.analyze(x0, y0, x1, y1, 'belief', ALL_TIERS);
  }

  private plan(res: ReturnType<Game['analyze']>): void {
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
      const score = p + 0.002 * this.score(k);
      if (score < best) (best = score), (pick = k);
    }
    if (pick === null) pick = this.frontierCell();
    this.lastOdds = new Map();
    if (pick === null) return void (this.over = true);
    this.moveFocus(keyX(pick), keyY(pick));
    g.reveal(this.focus.x, this.focus.y);
  }

  /** A random Unknown cell next to an opened one, in the corridor, searched in growing rings around the focus. */
  private frontierCell(): number | null {
    const g = this.game;
    for (let r = 1; r <= WINDOW; r++) {
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
