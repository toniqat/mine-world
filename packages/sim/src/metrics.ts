import { TIER_IDS, TIER_LABELS, type Game } from '@mine/core';
import type { SolveSample } from './bot';

/** Aggregated Phase 0 metrics for one density (spec §13.3). */
export interface DensityMetrics {
  density: number;
  seeds: number;
  cellsRevealed: number;
  solverRuns: number;
  actions: number;
  /** Global bot: guesses / (actions + guesses). Local bot: forced guesses / (actions + stalls). */
  guessRate: number;
  /** Local bot only: stalls per 1000 actions (triage events). */
  stallsPer1000: number;
  /** Share of frontier components with at least one undetermined cell. */
  ambiguousComponentRate: number;
  /** Share of verdict cells produced by each tier (TIER_IDS order). */
  tierShare: number[];
  /** Overrides written per revealed cell. */
  overrideRate: number;
  interventions: number;
  interventionRate: number;
  compP50: number;
  compP95: number;
  compP99: number;
  compMax: number;
  solveMsAvg: number;
  solveMsP99: number;
  solveMsMax: number;
  hitsPer1000: number;
  settlements: number;
  minesOwned: number;
  minesPer1000: number;
}

export interface RunLike {
  game: Game;
  samples: SolveSample[];
  actions: number;
  guesses: number;
  stalls: number;
  hits: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

export function aggregate(density: number, runs: RunLike[]): DensityMetrics {
  let cells = 0;
  let solverRuns = 0;
  let actions = 0;
  let guesses = 0;
  let stalls = 0;
  let components = 0;
  let ambiguous = 0;
  const tiers = TIER_IDS.map(() => 0);
  let overrides = 0;
  let interventions = 0;
  let hits = 0;
  let settlements = 0;
  let owned = 0;
  const sizes: number[] = [];
  const times: number[] = [];
  for (const r of runs) {
    cells += r.game.board.revealedCount;
    solverRuns += r.samples.length;
    actions += r.actions;
    guesses += r.guesses;
    stalls += r.stalls;
    hits += r.hits;
    overrides += r.game.world.overrides.size;
    interventions += r.game.stats.interventions;
    settlements += r.game.stats.closures;
    owned += r.game.econ.owned.size;
    for (const s of r.samples) {
      components += s.components;
      ambiguous += s.undeterminedComponents;
      for (let i = 0; i < tiers.length; i++) tiers[i] += s.tierCounts[i];
      sizes.push(...s.sizes);
      times.push(s.ms);
    }
  }
  sizes.sort((a, b) => a - b);
  times.sort((a, b) => a - b);
  const tierTotal = tiers.reduce((a, b) => a + b, 0) || 1;
  const denom = actions + guesses + stalls || 1;
  return {
    density,
    seeds: runs.length,
    cellsRevealed: cells,
    solverRuns,
    actions,
    guessRate: guesses / denom,
    stallsPer1000: (stalls / (actions + stalls || 1)) * 1000,
    ambiguousComponentRate: components ? ambiguous / components : 0,
    tierShare: tiers.map((t) => t / tierTotal),
    overrideRate: cells ? overrides / cells : 0,
    interventions,
    interventionRate: cells ? interventions / cells : 0,
    compP50: percentile(sizes, 0.5),
    compP95: percentile(sizes, 0.95),
    compP99: percentile(sizes, 0.99),
    compMax: sizes.length ? sizes[sizes.length - 1] : 0,
    solveMsAvg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    solveMsP99: percentile(times, 0.99),
    solveMsMax: times.length ? times[times.length - 1] : 0,
    hitsPer1000: cells ? (hits / cells) * 1000 : 0,
    settlements,
    minesOwned: owned,
    minesPer1000: cells ? (owned / cells) * 1000 : 0,
  };
}

export function toCsv(rows: DensityMetrics[]): string {
  const head = [
    'density', 'seeds', 'cellsRevealed', 'solverRuns', 'actions', 'guessRate', 'stallsPer1000', 'ambiguousComponentRate',
    ...TIER_IDS.map((t) => 'tier_' + t), 'overrideRate', 'interventions', 'interventionRate',
    'compP50', 'compP95', 'compP99', 'compMax', 'solveMsAvg', 'solveMsP99', 'solveMsMax',
    'hitsPer1000', 'settlements', 'minesOwned', 'minesPer1000',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.density, r.seeds, r.cellsRevealed, r.solverRuns, r.actions, r.guessRate.toFixed(4), r.stallsPer1000.toFixed(1), r.ambiguousComponentRate.toFixed(4),
        ...r.tierShare.map((v) => v.toFixed(4)), r.overrideRate.toFixed(4), r.interventions, r.interventionRate.toFixed(4),
        r.compP50, r.compP95, r.compP99, r.compMax, r.solveMsAvg.toFixed(3), r.solveMsP99.toFixed(3), r.solveMsMax.toFixed(3),
        r.hitsPer1000.toFixed(2), r.settlements, r.minesOwned, r.minesPer1000.toFixed(1),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function toMarkdown(rows: DensityMetrics[], title: string, local: boolean): string {
  const pct = (v: number) => (v * 100).toFixed(1) + '%';
  const out: string[] = [];
  out.push(`## ${title}`, '');
  const tierHead = TIER_IDS.map((t) => TIER_LABELS[t]).join(' | ');
  out.push(`| density | cells | ${local ? 'stalls/1000 | forced guess' : 'guess rate'} | ambiguous comp. | ${tierHead} | override | interventions | comp p50/p95/p99/max | solve ms avg/p99/max | hits/1000 | mines/1000 | settlements |`);
  out.push('|---|---|---|' + (local ? '---|' : '') + '---|' + TIER_IDS.map(() => '---|').join('') + '---|---|---|---|---|---|---|');
  for (const r of rows) {
    const g = local ? `${r.stallsPer1000.toFixed(0)} | ${pct(r.guessRate)}` : pct(r.guessRate);
    out.push(
      `| ${pct(r.density)} | ${r.cellsRevealed} | ${g} | ${pct(r.ambiguousComponentRate)} | ${r.tierShare.map(pct).join(' | ')} | ${pct(r.overrideRate)} | ${r.interventions} | ${r.compP50}/${r.compP95}/${r.compP99}/${r.compMax} | ${r.solveMsAvg.toFixed(2)}/${r.solveMsP99.toFixed(1)}/${r.solveMsMax.toFixed(1)} | ${r.hitsPer1000.toFixed(1)} | ${r.minesPer1000.toFixed(0)} | ${r.settlements} |`,
    );
  }
  out.push('');
  return out.join('\n');
}
