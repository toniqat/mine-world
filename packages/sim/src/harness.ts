import { Game, type InterventionMode, type TierSet } from '@mine/core';
import { GlobalBot, LocalBot } from './bot';
import { aggregate, type DensityMetrics, type RunLike } from './metrics';

export interface HarnessOptions {
  densities: number[];
  seeds: number[];
  cellsPerRun: number;
  tiers: TierSet;
  interventionMode: InterventionMode;
  /** 'global' = whole-frontier bot, 'local' = drone-window bot with the given radius. */
  bot: 'global' | 'local';
  radius?: number;
  t3MaxCells?: number;
  t4MaxCells?: number;
  onProgress?: (msg: string) => void;
}

function makeGame(density: number, seed: number, opts: HarnessOptions): Game {
  return new Game({
    seed,
    world: { uniformDensity: density, startSafeRadius: 3, terrainEnabled: false },
    fog: { enabled: false },
    tiers: { enabled: false },
    econ: { storageBase: Infinity },
    resolve: { interventionMode: opts.interventionMode },
    solver: {
      ...(opts.t3MaxCells !== undefined ? { t3MaxCells: opts.t3MaxCells } : {}),
      ...(opts.t4MaxCells !== undefined ? { t4MaxCells: opts.t4MaxCells } : {}),
    },
  } as never);
}

export function runOne(density: number, seed: number, opts: HarnessOptions): RunLike {
  const game = makeGame(density, seed, opts);
  game.reveal(0, 0);
  const limit = opts.cellsPerRun * 40;
  if (opts.bot === 'global') {
    const bot = new GlobalBot(game, opts.tiers, seed * 7919 + 1, opts.cellsPerRun);
    let guard = 0;
    while (game.board.revealedCount < opts.cellsPerRun && guard++ < limit) bot.step();
    return { game, samples: bot.samples, actions: bot.actions, guesses: bot.guesses, stalls: 0, hits: bot.hits };
  }
  const bot = new LocalBot(game, opts.tiers, opts.radius ?? 8, seed * 7919 + 1);
  let guard = 0;
  while (game.board.revealedCount < opts.cellsPerRun && guard++ < limit) bot.step();
  return { game, samples: bot.samples, actions: bot.actions, guesses: bot.guesses, stalls: bot.stalls, hits: bot.hits };
}

export function runHarness(opts: HarnessOptions): DensityMetrics[] {
  const rows: DensityMetrics[] = [];
  for (const d of opts.densities) {
    const runs: RunLike[] = [];
    for (const s of opts.seeds) {
      const t0 = performance.now();
      runs.push(runOne(d, s, opts));
      const r = runs[runs.length - 1];
      opts.onProgress?.(`density ${d} seed ${s}: ${r.game.board.revealedCount} cells, ${r.actions} actions, ${r.stalls} stalls, ${r.guesses} guesses in ${(performance.now() - t0).toFixed(0)} ms`);
    }
    rows.push(aggregate(d, runs));
  }
  return rows;
}
