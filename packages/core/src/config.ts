/**
 * Tunable parameters (spec §15).
 *
 * Values marked `TODO(sim)` were deliberately left open by the spec. They are
 * filled from Phase 0 measurements (packages/sim/results/phase0.md) and may be
 * re-tuned later. Nothing in core hard-codes a number that lives here.
 */

export type InterventionMode = 'STRICT' | 'FAIR' | 'FORGIVING';

export interface WorldConfig {
  /** Lowest / highest mine density produced by the biome noise. TODO(sim): estimated 0.08 ~ 0.35. */
  densityMin: number;
  densityMax: number;
  /** Lattice size (in cells) of the biome value noise. TODO(sim). */
  biomeNoiseScale: number;
  biomeOctaves: number;
  /** Multiplier applied around 0.5 to spread fBm output over [0, 1]. */
  biomeContrast: number;
  /** Radius (cells) around the origin with zero mines so the first click always opens. */
  startSafeRadius: number;
  /** Density added per cell of distance from the origin (0 disables). Capped by distanceRampCap. */
  distanceRamp: number;
  distanceRampCap: number;
  /** Linear structures (§3.3): bands of near-certain mines. */
  riverEnabled: boolean;
  riverNoiseScale: number;
  riverWidth: number;
  riverDensity: number;
  riverMinRadius: number;
  /** When set, every cell (outside the start radius) has this density. Used by sim/tests. */
  uniformDensity: number | null;
  /** Max relative density boost used to repay density debt (§5.3). */
  debtPressureMax: number;
}

export interface SolverConfig {
  /** Components up to this size are fully enumerated by T3. TODO(sim): p95 of component size. */
  t3MaxCells: number;
  /** Components up to this size are enumerated with probabilities by T4. TODO(sim): p99, bounded by time budget. */
  t4MaxCells: number;
  /** Enumeration aborts (-> UNDETERMINED) after this many solutions. */
  solutionCap: number;
  /** Enumeration aborts after visiting this many search nodes. */
  nodeBudget: number;
}

export interface ResolveConfig {
  interventionMode: InterventionMode;
  /** Flood-fill bound for the FAIR escape test (§5.2). TODO(sim). */
  escapeCap: number;
  /** Number of guaranteed rescues in FORGIVING mode before it degrades to FAIR. */
  forgivingRescues: number;
}

export interface EconConfig {
  /** Value of a mine at densityMin. TODO(sim). */
  baseValue: number;
  /** densityMultiplier(d) = 2 ^ ((d - densityMin) / densityDoubling). TODO(sim): match inverse ambiguity rate. */
  densityDoubling: number;
  /** One-time payout on settlement = sum(mineValue) * this * streakMult. */
  settlementPayoutMult: number;
  /** Passive income per second per owned mine = mineValue * this. */
  incomePerSecondMult: number;
  /** Streak multiplier grows by this per safe player click, capped at streakMultCap. */
  streakMultPerClick: number;
  streakMultCap: number;
  /** Added to streakMultCap per level of the `streak_cap` upgrade. */
  streakCapPerLevel: number;
  /** Fraction of unbanked funds lost when stepping on a mine (§7.1, Sapper-style). TODO(sim). */
  mineHitLossFraction: number;
  /** Fraction of unbanked funds lost per wrong flag revealed at settlement (deviation from spec, see CLAUDE.md). */
  wrongFlagLossFraction: number;
  /** Prestige: cores = floor(sum(densityMultiplier of owned mines) / prestigeDivisor). */
  prestigeDivisor: number;
  /** Each core adds this fraction to all mine values. */
  prestigeBonusPerCore: number;
  /** Minimum owned mines before liquidation is offered. */
  prestigeMinOwned: number;
}

export interface DroneConfig {
  baseRadius: number;
  radiusPerLevel: number;
  baseActionsPerSec: number;
  speedPerLevel: number;
  /** Tiles per second a drone's line grows toward its target (and the drone travels along it). */
  baseMoveTilesPerSec: number;
  moveSpeedPerLevel: number;
}

/** Bases (Owned mines + the main base at the start cell), see econ/bases.ts. */
export interface BaseConfig {
  /** Speed of shipments along the base network (tiles per second), before the transport upgrade. */
  transportTilesPerSec: number;
  /** Tiles per second added per level of the `transport_speed` upgrade. */
  transportSpeedPerLevel: number;
  /** Each base ships its stock towards the main base this often (seconds). */
  shipInterval: number;
  /** All base production x growth^(level - 1). The main base itself produces nothing. */
  levelProdGrowth: number;
  mainCostBase: number;
  mainCostGrowth: number;
  maxLevel: number;
  /** A complex of at least this many bases is a grand complex. */
  grandMinBases: number;
  /** Grand complex: each member produces x(1 + this x members). */
  grandBonusPerBase: number;
}

/** Mine explosions disabling bases, and repairing them (see econ/blast.ts). */
export interface BlastConfig {
  /** Distance bands from the main base (tiles, Euclidean). */
  bandTiles: number;
  /** Radius range in band 0; later bands raise the minimum and the maximum in turn (3-5, 4-5, 4-6, 5-6, ...). */
  minRadius: number;
  maxRadius: number;
  /** Repair cost = repairCostBase + repairCostPerTile x opened cells. */
  repairCostBase: number;
  repairCostPerTile: number;
}

export interface PlayConfig {
  /** Zero-cascades stop at this Chebyshev radius from the opened cell (low densities percolate forever). */
  cascadeRadius: number;
  /** Hard cap on cells revealed by one cascade. */
  cascadeCap: number;
}

export interface GameConfig {
  seed: number;
  play: PlayConfig;
  world: WorldConfig;
  solver: SolverConfig;
  resolve: ResolveConfig;
  econ: EconConfig;
  drones: DroneConfig;
  bases: BaseConfig;
  blast: BlastConfig;
}

export const DEFAULT_CONFIG: GameConfig = {
  seed: 1,
  play: {
    cascadeRadius: 24,
    cascadeCap: 800,
  },
  world: {
    densityMin: 0.1, // sim: 8% worlds are almost empty (1 claimable mine / 1000 cells)
    densityMax: 0.35, // sim: forced guesses reach 5% of actions, hits 12 / 1000 cells
    biomeNoiseScale: 48, // TODO(play): tune by feel
    biomeOctaves: 3,
    biomeContrast: 2.2,
    startSafeRadius: 3,
    distanceRamp: 0.00025, // TODO(play): +0.025 density per 100 cells
    distanceRampCap: 0.12,
    riverEnabled: true,
    riverNoiseScale: 160,
    riverWidth: 0.012,
    riverDensity: 0.9,
    riverMinRadius: 60,
    uniformDensity: null,
    debtPressureMax: 0.5,
  },
  solver: {
    t3MaxCells: 32, // sim: component size p95 in a radius-8 window is 26-34
    t4MaxCells: 48, // sim: p99 is 35-47; solve p99 stays under 4 ms
    solutionCap: 200_000,
    nodeBudget: 4_000_000,
  },
  resolve: {
    interventionMode: 'FAIR',
    escapeCap: 64, // sim: bots never trigger FAIR (0 interventions); pocket rescue only matters for humans
    forgivingRescues: 3,
  },
  econ: {
    baseValue: 10, // TODO(play)
    densityDoubling: 0.06, // sim: local stalls/1000 go 12 -> 64 and hits 0 -> 12 between 12% and 35%
    settlementPayoutMult: 1,
    incomePerSecondMult: 0.02,
    streakMultPerClick: 0.02,
    streakMultCap: 3,
    streakCapPerLevel: 0.5,
    mineHitLossFraction: 0.5, // Sapper-style; TODO(play)
    wrongFlagLossFraction: 0.25,
    prestigeDivisor: 40,
    prestigeBonusPerCore: 0.1,
    prestigeMinOwned: 50,
  },
  drones: {
    baseRadius: 8,
    radiusPerLevel: 2,
    baseActionsPerSec: 2,
    speedPerLevel: 1,
    baseMoveTilesPerSec: 4, // TODO(play)
    moveSpeedPerLevel: 1,
  },
  bases: {
    transportTilesPerSec: 4, // TODO(play): 100 tiles out = 25 s until the first credits
    transportSpeedPerLevel: 1, // TODO(play)
    shipInterval: 2.5, // TODO(play)
    levelProdGrowth: 1.15, // user decision: each main-base level raises every base a little
    mainCostBase: 150, // TODO(play)
    mainCostGrowth: 1.6, // TODO(play)
    maxLevel: 50,
    grandMinBases: 5, // user decision
    grandBonusPerBase: 0.05, // user decision: 5 bases x1.25, 10 bases x1.5
  },
  blast: {
    bandTiles: 5, // user decision
    minRadius: 3, // user decision: 3-5, 4-5, 4-6, 5-6, ...
    maxRadius: 5,
    repairCostBase: 20, // TODO(play)
    repairCostPerTile: 0.2, // TODO(play)
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** Shallow-merge each section of a partial config over the defaults. */
export function makeConfig(partial: DeepPartial<GameConfig> = {}): GameConfig {
  return {
    seed: partial.seed ?? DEFAULT_CONFIG.seed,
    play: { ...DEFAULT_CONFIG.play, ...(partial.play ?? {}) },
    world: { ...DEFAULT_CONFIG.world, ...(partial.world ?? {}) },
    solver: { ...DEFAULT_CONFIG.solver, ...(partial.solver ?? {}) },
    resolve: { ...DEFAULT_CONFIG.resolve, ...(partial.resolve ?? {}) },
    econ: { ...DEFAULT_CONFIG.econ, ...(partial.econ ?? {}) },
    drones: { ...DEFAULT_CONFIG.drones, ...(partial.drones ?? {}) },
    bases: { ...DEFAULT_CONFIG.bases, ...(partial.bases ?? {}) },
    blast: { ...DEFAULT_CONFIG.blast, ...(partial.blast ?? {}) },
  };
}
