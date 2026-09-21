import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TIERS, NO_TIERS, type TierSet } from '@mine/core';
import { runHarness } from './harness';
import { toCsv, toMarkdown, type DensityMetrics } from './metrics';

/**
 * Phase 0 instrumentation runner. Produces results/phase0.csv + phase0.md.
 *
 *   npm run sim                # full run
 *   npm run sim -- --quick     # fewer cells/seeds
 */
const quick = process.argv.includes('--quick');
const densities = [0.08, 0.12, 0.16, 0.2, 0.25, 0.3, 0.35];
const seeds = quick ? [1, 2] : [1, 2, 3];
const cellsPerRun = quick ? 1200 : 3000;
const log = (m: string) => console.log(m);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'results');
mkdirSync(outDir, { recursive: true });

const ladder: Array<{ name: string; tiers: TierSet }> = [
  { name: 'T1a (open)', tiers: { ...NO_TIERS, t1Open: true } },
  { name: 'T1a+T1b (open+flag)', tiers: { ...NO_TIERS, t1Open: true, t1Flag: true } },
  { name: '+T2a (subset)', tiers: { ...NO_TIERS, t1Open: true, t1Flag: true, t2Subset: true } },
  { name: '+T2b (pairwise)', tiers: { ...NO_TIERS, t1Open: true, t1Flag: true, t2Subset: true, t2Pair: true } },
  { name: '+T3 (enum)', tiers: { ...ALL_TIERS, t4: false } },
  { name: '+T4 (prob)', tiers: ALL_TIERS },
];

const sections: string[] = [];

// 1. Local (drone-window) bot, full solver, FAIR: the reference table.
log('== local bot / full solver / FAIR ==');
const mainRows: DensityMetrics[] = runHarness({ densities, seeds, cellsPerRun, tiers: ALL_TIERS, interventionMode: 'FAIR', bot: 'local', radius: 8, onProgress: log });
sections.push(toMarkdown(mainRows, 'Local bot (radius 8), full solver (T1..T4), FAIR intervention', true));

// 2. Global bot, full solver, FAIR + STRICT.
log('== global bot / full solver / FAIR ==');
const globalRows = runHarness({ densities, seeds, cellsPerRun, tiers: ALL_TIERS, interventionMode: 'FAIR', bot: 'global', onProgress: log });
sections.push(toMarkdown(globalRows, 'Global bot (whole frontier), full solver, FAIR', false));
log('== global bot / full solver / STRICT ==');
const strictRows = runHarness({ densities, seeds: seeds.slice(0, 2), cellsPerRun, tiers: ALL_TIERS, interventionMode: 'STRICT', bot: 'global', onProgress: log });
sections.push(toMarkdown(strictRows, 'Global bot, full solver, STRICT (no intervention) baseline', false));

// 3. Tier ladder with the local bot at three densities: what each tier buys.
const ladderDensities = [0.12, 0.2, 0.3];
const ladderRows: Array<{ name: string; rows: DensityMetrics[] }> = [];
for (const ts of ladder) {
  log(`== tier ladder ${ts.name} ==`);
  const rows = runHarness({ densities: ladderDensities, seeds: seeds.slice(0, 2), cellsPerRun: Math.floor(cellsPerRun / 2), tiers: ts.tiers, interventionMode: 'FAIR', bot: 'local', radius: 8, onProgress: log });
  ladderRows.push({ name: ts.name, rows });
}
{
  const out: string[] = ['## Tier ladder (local bot, radius 8)', '', '| tiers | ' + ladderDensities.map((d) => `${d * 100}% stalls/1000 | ${d * 100}% hits/1000 | ${d * 100}% mines/1000`).join(' | ') + ' |', '|---|' + ladderDensities.map(() => '---|---|---|').join('')];
  for (const l of ladderRows) {
    out.push(`| ${l.name} | ` + l.rows.map((r) => `${r.stallsPer1000.toFixed(0)} | ${r.hitsPer1000.toFixed(1)} | ${r.minesPer1000.toFixed(0)}`).join(' | ') + ' |');
  }
  out.push('');
  sections.push(out.join('\n'));
}

const md = [
  '# Phase 0 measurements',
  '',
  `Generated ${new Date().toISOString()} by \`npm run sim${quick ? ' -- --quick' : ''}\`. Uniform-density worlds, ${cellsPerRun} revealed cells per run (ladder: ${Math.floor(cellsPerRun / 2)}).`,
  '',
  'Columns: stalls/1000 = local bot stalls per 1000 actions (each stall is a triage event: the player must relocate or intervene); forced guess / guess rate = share of actions that were blind guesses; ambiguous comp. = share of frontier components with undetermined cells; T1a..T4 = share of verdict cells produced by each tier; override = overrides per revealed cell; hits/1000 = mines stepped on per 1000 revealed cells; mines/1000 = mines claimed per 1000 revealed cells.',
  '',
  ...sections,
].join('\n');

writeFileSync(join(outDir, 'phase0.csv'), toCsv(mainRows));
writeFileSync(join(outDir, 'phase0-global.csv'), toCsv(globalRows));
writeFileSync(join(outDir, 'phase0.md'), md);
log(`wrote ${join(outDir, 'phase0.csv')}, phase0-global.csv and phase0.md`);
console.log('\n' + sections[0]);
