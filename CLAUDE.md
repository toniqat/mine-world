# Mine World — command center

Open-world incremental minesweeper (web + Electron). Design spec: [minesweeper-incremental-spec.md](minesweeper-incremental-spec.md). Read the spec's §1 invariants before touching `packages/core`. The spec's `▶ 구현` blocks and §17 record where the implementation confirmed or changed the design; keep them in sync when behaviour changes.

Status (2026-09-22): Phases 0–4 implemented + bases + title screen; game cut down to the incremental basics (main-base level, transport speed, streak cap; no solver-tier automation, drones or consumables for sale); mine blasts disable bases. 36 core tests green, Phase 1 manual play-test still to do.

Code, comments and docs are English; the UI is Korean + English (i18n in `packages/web/src/i18n.ts`).

## Feature → folder map

| Feature | Folder | Notes |
|---|---|---|
| World generation, CSP, solver tiers, lazy resolution, game transactions, economy, drones, save format | [packages/core](packages/core/README.md) | Pure TypeScript, no DOM/renderer imports (INV-6). Vitest suite pins the invariants. |
| Phase 0 headless instrumentation (bots, metrics, CSV/markdown results) | [packages/sim](packages/sim/README.md) | `npm run sim`. Results in `packages/sim/results/phase0.md`. |
| Browser client: PixiJS board renderer, DOM HUD/panels, input, IndexedDB persistence, themes, i18n | [packages/web](packages/web/README.md) | Vite. `npm run dev`. |
| Standalone shell | [packages/electron](packages/electron/README.md) | `npm run electron:dev` (dev only; packaging deliberately not set up). |

## Commands (repo root)

```
npm install
npm run dev            # web client at http://localhost:5173
npm run electron:dev   # Vite dev server + Electron window
npm test               # core invariants (vitest)
npm run sim            # Phase 0 measurements (~3-5 min); add -- --quick for a short run
npm run typecheck      # all packages
npm run build          # packages/web/dist
```

Visual check without a human: build web, then in `packages/electron` run `npx electron . --exec=script.js --screenshot=out.png` (see its README; clear `ELECTRON_RUN_AS_NODE` if an IDE terminal set it).

## Decisions taken while implementing (deviations / refinements of the spec)

- **Consistency model.** The world's `truth(x, y)` (override ?? stateless base ?? frozen per-chunk debt pressure) is always a full assignment consistent with every revealed number. Safe reveals are therefore *not* committed (keeps overrides sparse, §3.2); only interventions, hits, scanner cells and probes write overrides. Interventions commit a whole alternative solution of the component (the spec's "optional optimisation" is mandatory for consistency). See `packages/core/src/world.ts` and `resolve.ts`.
- **Settlement unit = claim batch, not CSP component.** Flags in public mode chain through the whole frontier, so "component closed" almost never happened at ≥30 % density. A flag is settle-able once every revealed number next to it is sealed; settle-able flags linked through shared sealed numbers form one batch. Feedback still only happens at settlement (INV-2).
- **Wrong flags are punished.** A batch with any wrong flag forfeits all of its real mines (`CellState.Lost`), pays nothing, and burns a fraction of unbanked funds. Without this, flagging everything would be a free probe.
- **Mine hit = resource loss (Sapper-style), no HP.** Settlement payouts land in *unbanked* funds with a click-streak multiplier; stepping on a mine burns `mineHitLossFraction` of it; **Cash Out** banks it. Passive income from owned mines goes straight to credits.
- **Six solver tiers instead of four.** Phase 0 showed T1 alone producing 70–93 % of verdicts, so T1/T2 are split: T1a open, T1b flag, T2a subset, T2b overlap (no chained derived constraints), T3 enumeration ≤ 32 cells, T4 enumeration ≤ 48 cells + probabilities. They are no longer sold (see *Incremental basics only*); drones use whatever tiers their equipment grants.
- **Zero-cascades are bounded** (`play.cascadeRadius` / `cascadeCap`) because low densities percolate forever.
- **Density debt** is repaid by freezing a per-chunk pressure the first time a chunk is observed, which keeps truth stable without commits.
- **Drones are dormant.** Nothing in the game creates drones now; the logic stays for planned equipment items, which will go through `Game.equipDrones(loadout)` (count, tiers, radius / speed levels, safe mode; saved as `SaveData.droneLoadout`). The rules below still describe them. **Drones stand on Owned mines.** A new drone auto-places on a free Owned mine with a lot of Unknown around it; the player can drag it to another one (it pauses while held). Each action extends a line tile by tile to the target (`baseMoveTilesPerSec`), then fills `acc` and executes; the next target is the one nearest the line's end (`tip`) and the line continues from there instead of retracting to the anchor (reset to the anchor on stall, hop, drag or placement). When its tile-rounded disc (`inDisc`) has nothing determined it rides a line to another Owned mine, leashed to the radius of the mine it was placed on (reach ≤ 2r); otherwise it stalls (red). The old follow-the-player assistant is gone.
- **The world starts all Unknown.** Nothing is opened for the player; the first cell they open becomes the centre of the mine-free start area and the distance ramp (`World.setStart`, locked once any truth is observed, saved in `SaveData.world.start`). Home (`H`) goes there.
- **Finished numbers disappear.** A number with no Unknown neighbour dims to 25 % opacity while an unsettled flag is still next to it, and fades out once none is; opened tiles flip over (the cover folds away, then the number unfolds) in a ripple from the clicked cell (a cascade's start, `CellChange.from`, or the chorded number).
- **Bases.** Every Owned mine is a base (거점, small dot); the start cell is the main base (주 거점, large diamond). The main base produces nothing itself; each of its levels raises every active base ×1.15 (`levelProdGrowth`). Bases form a tree rooted at the main base with no range limit: a base's next hop is the nearest base (Manhattan) that is closer to the main base. Edges are 4-neighbour tile paths that never cross an Unknown or flagged cell (shortest by BFS, preferring straight runs), drawn a sixth of a tile wide at ~10 % opacity. Production is stocked at each base, shipped every `shipInterval` s and travels hop by hop at `transportTilesPerSec`; credits rise only when a shipment reaches the main base (undelivered goods are credited on load). No link bonus. Only the main base is levelled (`packages/core/src/econ/bases.ts`, `config.bases`). Clicking a base opens its side panel and highlights its route; clicking the main base and the HUD main-base button open the same panel (level-up in its header, upgrades below). A base is *settled* when its 8 neighbours hold no Unknown / flag and every number among them has faded out; settled bases within 2 tiles (Chebyshev, chained) form a **complex** that acts as one network node (instant inside; the main complex pays at once; drawn with a faint round-cornered border); an unsettled base is a complex of its own. A complex with no such path to the main complex is **isolated** (translucent, no production, no link) until a way opens. A complex of ≥ 5 bases is a **grand complex**: members produce ×(1 + 0.05 × members) (`grandMinBases`, `grandBonusPerBase`); forming one plays an effect at its centre (`grand` event). A shipment that arrives leaves its trail fading in place; inside a complex of two or more bases shipments are not drawn, so goods appear to leave and enter through its border.
- **Mine blasts disable bases.** Stepping on a mine (still burning unbanked funds) sets off a circular blast centred on it. Its radius is rolled uniformly in a range that grows with the distance from the main base in 5-tile bands, the minimum and maximum rising in turn (3–5, 4–5, 4–6, 5–6, …). The effect flashes every tile inside the blast in a wave from the centre (no ring). Every base inside is **disabled**: no production and not a base for complexes or the network (its complex's stock is lost). The main base is immune. Clicking a disabled base repairs it for `repairCostBase + repairCostPerTile × opened cells` credits (`packages/core/src/econ/blast.ts`, `config.blast`).
- **Incremental basics only (for now).** Upgrades are the main-base level (header of the main-base panel), `transport_speed` and `streak_cap`. Solver-tier automation, drones and consumables (audit, scanner, probe) are not sold and the probability overlay is gone; scanner / probe / audit stay as core methods with a caller-given price. Older saves drop the retired upgrades and their drones; base / blast tuning always comes from the current defaults.
- **Title screen.** Shown on every launch: MINEWORLD (top centre), a large Start button (bottom centre; with a save it is Continue plus a smaller New game that keeps cores after a confirm). Behind it a throwaway, never-saved world is played by a small bot (`packages/web/src/demo.ts`: every solver tier around its last cell, least likely mine when stuck) under a film layer (grain, scanlines, vignette, faint flicker; no REC label or timecode). Start slides the logo up and the buttons down while they fade, the demo fades out, then the player's world appears tile by tile in a diagonal wave from the top-left of the screen (`BoardView.intro`); HUD and input come back after. A world nobody has opened shows a "click anywhere to found the main base" hint until the first click.
- **Prestige A (liquidation)**.

## Parameters

All tunables live in `packages/core/src/config.ts`. Values derived from Phase 0 are commented with `sim:`; values still open are `TODO(play)`.

## Conventions

- Every package folder has a README describing its files; update it when files change.
- Core never imports from web/electron. Web talks to core only through `Game` methods and `game.events`.
- Tests: `packages/core/test`. Keep the invariant tests green before merging core changes.
