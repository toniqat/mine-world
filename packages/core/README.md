# @mine/core

Pure game logic. No DOM, canvas or framework imports (spec INV-6). Consumed as TypeScript source by `web`, `sim` and the tests.

## Files

| File | Responsibility |
|---|---|
| `src/config.ts` | `GameConfig` and `DEFAULT_CONFIG` (spec §15). Every tunable lives here; `makeConfig()` merges partial overrides. |
| `src/key.ts` | Cell key encoding `(x, y) → number`, neighbour iteration, Chebyshev distance, `inDisc` (drone work area). |
| `src/hash.ts` | `hash32` / `hash01` coordinate hash, value noise, fBm (§3.1). |
| `src/world.ts` | `World`: base layer + override layer + per-chunk density-debt pressure. `truth(x, y)` is the authoritative, stable mine assignment; `commit()` enforces INV-4. `setStart()` centres the mine-free start area on the first cell opened (locked once any truth is observed). |
| `src/board.ts` | `Board`: player-visible cell states in 16×16 `Uint8Array` chunks (`CellState`: Unknown, Flag, Owned, Exploded, Lost, Revealed+n). |
| `src/csp.ts` | Constraint extraction per numbered cell, three modes (`engine` / `public` / `belief`, INV-1), component BFS, region collection, scanner constraints (§4.1, §4.2, §6). |
| `src/solver.ts` | `solve()`: tiers T1a/T1b/T2a/T2b/T3/T4 with per-verdict tier attribution, density-weighted probabilities (§4.4), `enumerate()` backtracking with solution/node caps. |
| `src/resolve.ts` | Lazy resolution and intervention policies STRICT / FAIR / FORGIVING (§5). An intervention commits an alternative solution of the whole component. |
| `src/game.ts` | `Game`: reveal / chord / flag / cash-out / buy (`transport_speed`, `streak_cap`, pushed into `Bases` / `Econ` by `applyUpgrades`) / bases (`baseInfo`, `upgradeMainBase`, `repairBase`, `repairCost`; rebuilt when a mine is owned, a base is disabled or repaired, or a cell stops being closed (opened, owned, lost, exploded; not a flag toggle) while bases exist; newly formed grand complexes are emitted as `grand` events) / tick / prestige / save. A hit sets off a blast (`explode`: radius from `blastRadius`, every Owned mine inside is disabled, never the main base; `HitEvent.blast`). Drones are not sold: `equipDrones(loadout)` is the hook for future equipment (`droneLoadout`: count, solver tiers, radius / speed levels, safe mode; saved). Scanner / probe / audit remain as core methods with a caller-given price but are not offered in the game. Settlement batches (§9), event emitter, log. Cascade reveals carry `CellChange.from` (the start cell) for the client's ripple. |
| `src/econ/income.ts` | `Econ`: credits, unbanked funds, streak multiplier (cap + `streakCapBonus`), nominal income rate (set by `Bases`, which also credits passive income), owned mines (base income, produced counter, `disabled` flag), lifetime stats, prestige gain. |
| `src/econ/bases.ts` | `Bases`: every Owned mine is a base, the start cell is the main base. The main base produces nothing; its level scales every base (`levelMult`, ×`levelProdGrowth` per level). **Disabled** bases (knocked out by a blast, `disabled`) are not bases at all until repaired: no production, not in any complex, not linked. A base is **settled** (`settled`) when its 8 neighbours hold no Unknown or flag and every number among them has faded out; settled bases within 2 tiles (Chebyshev, chained) form a **complex** (`complexes`, `complexOf`), one network node: goods move inside it instantly and the main complex pays at once; an unsettled base is a complex of its own. **Grand complex** (≥ `grandMinBases` members): each member ×(1 + `grandBonusPerBase` × members) (`grandBonus`, `Complex.bonus`); newly formed ones are listed in `formed` after a rebuild (never on the first one after construction / load). Network tree (parent: the complex reached by the shortest BFS path over `passable` cells, i.e. not Unknown or flagged, among those whose hub is closer (Manhattan) to the main base; the edge `path` runs `exit` -> `entry`, preferring straight runs). A complex whose chain of parents does not reach the main complex is **isolated** (`isolated`): rate 0, not linked. `route()` / `routePaths()`, `pathAt` (point along a path), per-base production (`income × levelMult`), transport (`tick`: complex stock → `shipments` every `shipInterval`, moving at `speed()` = `transportTilesPerSec` + the `transport_speed` level edge by edge; credits added on arrival at the main complex), main-base level / upgrade cost. `recompute()` rebuilds everything (called whenever bases change or a cell stops being closed while bases exist; flags do not count, the network treats them like Unknown) and writes `econ.incomeRate`; the stock of a complex whose hub was disabled is lost. |
| `src/econ/blast.ts` | Mine explosions: `blastRange(distance)` (bands of `bandTiles` from the main base; the minimum and the maximum rise in turn: 3-5, 4-5, 4-6, 5-6, ...), `blastRadius` (uniform in the range, hashed from seed / cell / hit count), `inBlast` (circle test), `repairCost(openedCells)` (`repairCostBase + repairCostPerTile × opened cells`). |
| `src/econ/upgrades.ts` | Upgrade definitions and price curves (§8, cut down): `transport_speed` (network) and `streak_cap` (misc). Upgrades no longer sold are dropped from older saves. |
| `src/econ/contamination.ts` | Audit / Audit+ (§10.3); not offered in the game at the moment. |
| `src/agents/drone.ts` | `DroneManager` (dormant until drones are equipped, see `Game.equipDrones`): belief-solver automation that stalls instead of guessing (INV-3), stall reports for triage, contamination basis. A drone stands on an Owned mine (auto-placed, draggable via `Game.placeDrone` / `holdDrone`) and works a disc around it. Phases: `extend` (line grows along `path` to the target, starting from `tip`, the cell the previous action left the line on, or from the anchor), `work` (`acc` fills, verdict re-checked, execute), `travel` (ride a line to another Owned mine within the radius of `home`). `linePath` builds the king-move path. |
| `src/events.ts` | Typed emitter. |
| `src/save.ts` | `SaveData` (structured-clone friendly). |
| `src/index.ts` | Barrel export. |
| `test/solver.test.ts` | T-SOLVE, INV-5. |
| `test/bases.test.ts` | Main base from the first click (produces nothing itself), complexes (settled bases within 2 tiles) and the next-hop rule / route length with paths over passable cells only, isolation (no path avoiding Unknown: no production or link until a way opens, the path then detours), settling (an Unknown two tiles away splits a base off), grand complexes (bonus, `formed` only on new ones), main-complex bases pay at once, deterministic rebuild, income = sum of base rates, credits only on arrival (steady state: credited + in transit = production), main-base upgrade, save round-trip (in-transit goods credited on load), transport speed / streak cap upgrades, blast radius bands, a hit disabling exactly the bases inside the blast (out of complexes and network, no production), repair cost and repair, disabled bases surviving a save. |
| `test/invariants.test.ts` | INV-1..4, consistency (T-SETTLE generalised), T-SEAL, drones/contamination (§13.3 Phase 3 acceptance, drones equipped through `equipDrones`), drone anchoring / line / drag, save round-trip (upgrades, drone loadout), scanner, start area follows the first click. |

## Key ideas

- **Truth is stable without commits.** Base values are stateless; debt pressure is frozen per chunk on first observation; overrides only change a cell once. So every revealed number stays valid forever and settlement can simply read `world.truth()`.
- **Constraints are derived on demand** from board state; a numbered cell with no hidden neighbours yields none (sealed). Active constraint count ∝ perimeter.
- **Three solver inputs**: engine (numbers + committed overrides), public (numbers only), belief (numbers + flags). Drones use belief (or public in safe mode); the player's probability overlay uses belief; the engine uses engine mode to decide whether a mine may be moved.

## Testing

```
npm test            # from repo root
npx vitest --root packages/core
```
