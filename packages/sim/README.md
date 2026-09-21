# @mine/sim

Headless Phase 0 instrumentation (spec §13.3). Runs bots against `@mine/core` on uniform-density worlds and writes the balancing tables.

## Files

| File | Responsibility |
|---|---|
| `src/bot.ts` | `GlobalBot` (solves the whole frontier per pass) and `LocalBot` (drone-sized window, counts stalls / forced guesses). Both apply only sound verdicts. |
| `src/harness.ts` | Builds a `Game` per (density, seed), runs a bot to N revealed cells. |
| `src/metrics.ts` | Aggregation (guess/stall rates, ambiguous component share, tier shares, override rate, component size percentiles, solver time percentiles, hits, mines claimed) and CSV / Markdown output. |
| `src/run.ts` | CLI entry: reference tables + STRICT baseline + tier ladder. `--quick` for a short run. |
| `results/phase0.md` | Latest measurements (human-readable). |
| `results/phase0.csv`, `results/phase0-global.csv` | Same data, machine-readable. |

## Usage

```
npm run sim               # full (~3-5 min)
npm run sim -- --quick
```

## What the numbers decided

- `densityMin` 0.10 (8 % worlds are empty), `densityMax` 0.35.
- `t3MaxCells` 32 (p95 of component size in a radius-8 window), `t4MaxCells` 48 (p99).
- `densityDoubling` 0.06: local stalls per 1000 actions rise 12 → 64 and hits 0 → 12 between 12 % and 35 %.
- Tier split: T1 alone produced 70–93 % of verdicts, so T1/T2 were each split in two. T3 buys almost nothing over T2b; T4's value is the probability display (hits at 30 % drop from 6.7 to 2.0 per 1000 cells).
- Override rate stays ≤ 2 % (spec threshold 5 %). FAIR interventions never trigger for bots (they only guess on open frontiers); they exist for humans in enclosed pockets.
