import {
  CellState,
  Game,
  TIER_IDS,
  Verdict,
  cellKey,
  chebyshev,
  collectRegion,
  constraintFor,
  isRevealed,
  keyX,
  keyY,
  numberOf,
  solve,
  type Constraint,
  type SolveResult,
  type TierSet,
} from '@mine/core';

/**
 * Headless auto-players (spec §13.3 Phase 0).
 *
 * GlobalBot solves the whole frontier each pass (an idealised player who can
 * always "go elsewhere"). LocalBot works inside a drone-sized window and
 * counts how often it stalls: that is the triage rate the real game will show.
 * Both only apply sound verdicts, so their flags are always right.
 */
export interface SolveSample {
  ms: number;
  components: number;
  undeterminedComponents: number;
  sizes: number[];
  tierCounts: number[];
  verdicts: number;
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(res: SolveResult, ms: number): SolveSample {
  const tierCounts = TIER_IDS.map(() => 0);
  for (const t of res.tier.values()) tierCounts[TIER_IDS.indexOf(t)]++;
  return {
    ms,
    components: res.components.length,
    undeterminedComponents: res.components.filter((c) => c.undetermined > 0).length,
    sizes: res.components.map((c) => c.size),
    tierCounts,
    verdicts: res.verdicts.size,
  };
}

export class GlobalBot {
  readonly active = new Set<number>();
  samples: SolveSample[] = [];
  actions = 0;
  guesses = 0;
  hits = 0;
  private rng: () => number;

  constructor(
    readonly game: Game,
    readonly tiers: TierSet,
    seed: number,
    readonly target: number,
  ) {
    this.rng = mulberry32(seed);
    game.board.forEachCell((x, y, s) => {
      if (isRevealed(s) && numberOf(s) > 0) this.active.add(cellKey(x, y));
    });
    game.events.on('cells', (list) => {
      for (const c of list) {
        if (isRevealed(c.state) && numberOf(c.state) > 0) this.active.add(cellKey(c.x, c.y));
      }
    });
  }

  private constraints(): Constraint[] {
    const out: Constraint[] = [];
    for (const k of [...this.active]) {
      const c = constraintFor(this.game.ctx, 'belief', keyX(k), keyY(k));
      if (c) out.push(c);
      else this.active.delete(k);
    }
    return out;
  }

  /** One solver pass + resulting actions. Returns false when a guess was needed. */
  step(): boolean {
    const cons = this.constraints();
    const t0 = performance.now();
    const res = solve(cons, this.game.solveOptions(this.tiers));
    this.samples.push(sample(res, performance.now() - t0));

    let acted = false;
    for (const [k, v] of res.verdicts) {
      if (this.game.board.revealedCount >= this.target) return true;
      const x = keyX(k);
      const y = keyY(k);
      if (this.game.cellState(x, y) !== CellState.Unknown) continue;
      if (v === Verdict.Safe) {
        if (this.game.reveal(x, y).hit) this.hits++;
      } else {
        this.game.setFlag(x, y, true);
      }
      this.actions++;
      acted = true;
    }
    if (acted) return true;

    this.guesses++;
    let pick: number | null = null;
    let best = Infinity;
    for (const [k, p] of res.probabilities) {
      if (p < best && this.game.cellState(keyX(k), keyY(k)) === CellState.Unknown) {
        best = p;
        pick = k;
      }
    }
    if (pick === null) {
      const frontier = [...res.undetermined].filter((k) => this.game.cellState(keyX(k), keyY(k)) === CellState.Unknown);
      if (frontier.length) pick = frontier[Math.floor(this.rng() * frontier.length)];
    }
    if (pick === null) pick = randomUnknownNearby(this.game, this.rng);
    if (pick === null) return false;
    if (this.game.reveal(keyX(pick), keyY(pick)).hit) this.hits++;
    return false;
  }
}

/**
 * Drone-like bot: solves only inside a (2r+1)^2 window around its anchor,
 * acts one cell at a time, and when stuck relocates the anchor to another
 * frontier cell (what a player does when a drone reports a stall).
 */
export class LocalBot {
  samples: SolveSample[] = [];
  actions = 0;
  stalls = 0;
  /** Stalls where relocating found no deducible cell anywhere: a forced guess. */
  guesses = 0;
  hits = 0;
  x = 0;
  y = 0;
  private rng: () => number;

  constructor(
    readonly game: Game,
    readonly tiers: TierSet,
    readonly radius: number,
    seed: number,
  ) {
    this.rng = mulberry32(seed);
  }

  step(): void {
    const g = this.game;
    const cons = collectRegion(g.ctx, 'belief', this.x - this.radius, this.y - this.radius, this.x + this.radius, this.y + this.radius);
    const t0 = performance.now();
    const res = solve(cons, g.solveOptions(this.tiers));
    this.samples.push(sample(res, performance.now() - t0));
    let pick: number | null = null;
    let pickD = Infinity;
    let pickV: Verdict = Verdict.Undetermined;
    for (const [k, v] of res.verdicts) {
      const x = keyX(k);
      const y = keyY(k);
      const d = chebyshev(x, y, this.x, this.y);
      if (d > this.radius || g.cellState(x, y) !== CellState.Unknown) continue;
      if (d < pickD) {
        pickD = d;
        pick = k;
        pickV = v;
      }
    }
    if (pick !== null) {
      this.actions++;
      if (pickV === Verdict.Safe) {
        if (g.reveal(keyX(pick), keyY(pick)).hit) this.hits++;
      } else g.setFlag(keyX(pick), keyY(pick), true);
      return;
    }
    // Stalled: relocate to a random frontier cell elsewhere.
    this.stalls++;
    const b = g.board;
    const all = collectRegion(g.ctx, 'belief', b.minX - 1, b.minY - 1, b.maxX + 1, b.maxY + 1);
    const global = solve(all, g.solveOptions(this.tiers));
    const candidates: number[] = [];
    for (const [k] of global.verdicts) if (g.cellState(keyX(k), keyY(k)) === CellState.Unknown) candidates.push(k);
    if (candidates.length) {
      const k = candidates[Math.floor(this.rng() * candidates.length)];
      this.x = keyX(k);
      this.y = keyY(k);
      return;
    }
    // Nowhere to go: forced guess at the lowest probability cell.
    this.guesses++;
    let best = Infinity;
    for (const [k, p] of global.probabilities) {
      if (p < best && g.cellState(keyX(k), keyY(k)) === CellState.Unknown) {
        best = p;
        pick = k;
      }
    }
    if (pick === null) {
      const frontier = [...global.undetermined].filter((k) => g.cellState(keyX(k), keyY(k)) === CellState.Unknown);
      if (frontier.length) pick = frontier[Math.floor(this.rng() * frontier.length)];
    }
    if (pick === null) pick = randomUnknownNearby(g, this.rng);
    if (pick === null) return;
    this.x = keyX(pick);
    this.y = keyY(pick);
    if (g.reveal(this.x, this.y).hit) this.hits++;
  }
}

function randomUnknownNearby(game: Game, rng: () => number): number | null {
  const b = game.board;
  for (let tries = 0; tries < 200; tries++) {
    const x = b.minX - 1 + Math.floor(rng() * (b.maxX - b.minX + 3));
    const y = b.minY - 1 + Math.floor(rng() * (b.maxY - b.minY + 3));
    if (game.cellState(x, y) === CellState.Unknown) return cellKey(x, y);
  }
  return null;
}
