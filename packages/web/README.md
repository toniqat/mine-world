# @mine/web

Browser client. Vite + TypeScript + PixiJS (WebGL) for the board, plain DOM for the chrome. No framework.

## Files

| File | Responsibility |
|---|---|
| `index.html` | Shell: `#stage` (Pixi canvas), `#hud`, `#panel`, `#statusbar`, `#toasts`, `#modal`. |
| `src/main.ts` | Boot: load save from IndexedDB, create `App`. |
| `src/app.ts` | Orchestrator: owns `Game`, camera, renderer, input, HUD, panels, chords (`chordAt`: the number's actionable Unknown neighbours that stay closed get the press effect), base selection (clicking a base opens the Base panel; clicking the main base, the HUD main-base button or `U` opens the same main-base panel), repairs, hit feedback (toasts + tile blast), grand complex formation (effect + toast), fog lifting (`fog` event -> `liftFog`), mining technology learned (`tech` event -> `refreshAll` + toast), a toast naming the mining level a locked cell needs, the tier in the status-bar coordinates, drone drag and drop onto Owned mines (only matters once drones are equipped), autosave, prestige and new-game flows. A new world is all fog: the view centres on the start cell, a toast says to click anywhere, and the first click places the main base (and opens the start area). |
| `src/render/textures.ts` | Vector-drawn cell atlas per theme (tiles, "?" mark tile (and its hover), flag + bare flag glyph, owned base dot (plus translucent isolated and struck-through disabled) / lost / exploded marks, single-colour digits, terrain walls: full-bleed mountain / water fills with a faint glyph so neighbouring walls merge, fog of war: a faint tile with a dashed outline that hides whether a wall lies under it; closed tiles per mining tier (`tiers`, `tierTextures`: Unknown, hover, flag, locked with a padlock)). `CELL = 32`. |
| `src/render/camera.ts` | World/screen transform, zoom-at-cursor, visible cell range. |
| `src/render/boardView.ts` | Chunked sprite renderer (one sprite per cell, culled per 16×16 chunk, all chunks repainted once the first click sets the start so terrain appears, digits hidden below 50 % zoom, fogged cells painted with the fog tile, `liftFog()` repaints cells the fog lifted from under a fog cover fading out over 600 ms with a little jitter, Unknown / flagged cells painted with the plain tile, or the locked tile (`cellLocked` + padlock) while their tier is locked, `refreshAll()` after a technology, no hover on fogged (except before the start) or locked cells, an opened cell's cover is the tile it showed, "?"-marked Unknown cells painted with the "?" tile (hover refreshed after every change), numbers dim to 25 % opacity once only unsettled flags are left next to them and fade out once neither Unknown nor unsettled flag is) + overlays: complexes of two or more bases (member tiles plus the rectangles between members within reach tinted faintly with the accent, and a faint round-cornered border traced around the group), the base network (edge paths as tile strips a sixth of a tile wide at 10 % opacity, built from non-overlapping pieces), the selected base's route to the main base and its complex, a large diamond on the main base, probabilities, drone work discs (tint on Unknown cells only), drop targets while dragging, scanner boxes, targeting preview, highlights, density heatmap. Per-frame effects: press (`press()`: clicking a number shrinks its closed neighbours' tiles about their centres and springs them back), shipments (cosmetic, a stretch at most 45 % opaque with a smooth fade-in front and fading tail, moving along the network towards the main base, hidden inside complexes of two or more bases so goods seem to leave and enter through the complex border; when one arrives or hands over to the next edge its trail stays as an afterimage and fades out in place), blasts (every tile inside the blast radius flashes hot, pops and cools to red in a wave from the centre with a little jitter, then a faint scorch fades), grand complex formation (`grand()`: member pulse, two rings spreading from the complex's centre, a label rising and fading), flag pop-in/out, reveal fade (cascades ripple out from their start cell), drone lines (grow to the target, ride to another mine, abandoned lines shrink back; a line the next one continues from shrinks towards its end), clock-wipe on the target, settlement pulse ripple. |
| `src/input.ts` | Pointer/touch/keyboard: click vs drag, object grab (`grab` / `grabMove` / `grabEnd`, used for drones), long-press flag, wheel/pinch zoom, inertia, WASD/arrow pan. |
| `src/ui/hud.ts` | Top bar (credits, income, unbanked, streak, Cash Out; buttons: home, main base (same diamond as on the board), log, stats, settings) and status bar (mode, coords, density, zoom, seed). |
| `src/ui/panels.ts` | Side panel: Log, Stats (+ Liquidation), Settings, and the Base panel. Main base: title with its level, level-up cost and button in the header; network production per turn, active / isolated / disabled base counts, next level's multiplier, the upgrades (streak cap) and a Mining technology section (one levelled `mining` row: the highest tier minable now, and where the next tier begins, its mine value and blast range). Other bases: isolation notice, production per turn, produced so far, main-base level, complex size and output, grand complex bonus, route to the main base in tiles / hops, bases routed through, next hop. Disabled bases: notice, repair cost and Repair button. |
| `src/ui/toast.ts` | Toasts and confirm dialog. |
| `src/ui/dom.ts` | `el()` helper, icons. |
| `src/theme.ts` | VS Code Light Modern / Dark Modern palettes for CSS and Pixi (plus `cellMountain` / `cellWater`, the fog tile outline `cellFog` and the locked-tier tile colour `cellLocked`). |
| `src/style.css` | Chrome styling (flat, 1 px borders, single accent). |
| `src/i18n.ts` | `t()` with Korean and English tables. |
| `src/format.ts` | Number / time formatting. |
| `src/storage.ts` | IndexedDB save (`SaveData` structured clone), localStorage settings. |

## Controls

- Drag / wheel / pinch: pan and zoom. WASD or arrows also pan. `H` returns to the start cell (the first cell opened).
- Click a base (Owned mine) to open its panel; a disabled base (grey dot, struck through) is repaired there. The main base (start cell, large diamond), the HUD diamond button and `U` all open the main-base panel, where it is levelled up and the upgrades are bought.
- A new world is all fog; the first click places the main base there. Fogged tiles (dashed outline) cannot be opened or flagged; the main base sees 16 tiles, a base 9, and every opened cell 2 around it.
- Coloured tiles with a padlock are in a mining tier the mining technology (main-base panel, *Mining technology*) does not reach yet; levelling it up turns them into plain tiles.
- Classic mode: left-click opens, right-click or long-press cycles flag -> "?" -> clear (a "?" is only a note), clicking a number chords. Every action that changes tiles (an opening, a chord that opens something, placing a flag) is one turn: linked bases produce once. Lifting a flag (flag -> "?"), clearing a "?", clicking a number that opens nothing and selecting a base are not turns. Flags settle (become bases) on the next opening, never by themselves.
- Toggle mode (Settings): the status-bar mode button or `F` switches open/flag for taps.
- `Space` cashes out. `U` / `L` open the main base / Log. `Esc` closes.

## Scripts

```
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run typecheck
```
