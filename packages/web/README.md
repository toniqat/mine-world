# @mine/web

Browser client. Vite + TypeScript + PixiJS (WebGL) for the board, plain DOM for the chrome. No framework.

## Files

| File | Responsibility |
|---|---|
| `index.html` | Shell: `#stage` (Pixi canvas), `#hud`, `#panel`, `#statusbar`, `#toasts`, `#modal`. |
| `src/main.ts` | Boot: load save from IndexedDB, create `App`. |
| `src/demo.ts` | `DemoPlayer`: the title-screen demo. A throwaway `Game` (never saved) played by a small bot: solves the window around its last cell with every tier, works through the nearest verdicts, guesses the least likely mine when stuck, and starts a new world after 600 actions. |
| `src/app.ts` | Orchestrator: owns `Game`, camera, renderer, input, HUD, panels, the title screen (plays the demo with the camera following it, HUD and input off; Start / Continue / New game fade the demo out, swap in the player's world and run the tile intro, then bring the HUD and input back; the start hint until the first cell opens), base selection (clicking a base opens the Base panel; clicking the main base, the HUD main-base button or `U` opens the same main-base panel), repairs, hit feedback (toasts + tile blast), grand complex formation (effect + toast), drone drag and drop onto Owned mines (only matters once drones are equipped), autosave, prestige and new-game flows. A new world opens nothing by itself: the view centres on the start cell and the player's first click opens it. Chords ripple from the chorded number (`BoardView.rippleFrom`). |
| `src/render/textures.ts` | Vector-drawn cell atlas per theme (tiles, flag + bare flag glyph, owned base dot (plus translucent isolated and struck-through disabled) / lost / exploded marks, single-colour digits). `CELL = 32`. |
| `src/render/camera.ts` | World/screen transform, zoom-at-cursor, visible cell range. |
| `src/render/boardView.ts` | Chunked sprite renderer (one centred sprite per cell, culled per 16×16 chunk, digits hidden below 50 % zoom, numbers dim to 25 % opacity once only unsettled flags are left next to them and fade out once neither Unknown nor unsettled flag is) + overlays: complexes of two or more bases (member tiles plus the rectangles between members within reach tinted faintly with the accent, and a faint round-cornered border traced around the group), the base network (edge paths as tile strips a sixth of a tile wide at 10 % opacity, built from non-overlapping pieces), the selected base's route to the main base and its complex, a large diamond on the main base, probabilities, drone work discs (tint on Unknown cells only), drop targets while dragging, scanner boxes, targeting preview, highlights, density heatmap. Per-frame effects: shipments (a stretch at most 45 % opaque with a smooth fade-in front and fading tail, moving along the network towards the main base, hidden inside complexes of two or more bases so goods seem to leave and enter through the complex border; when one arrives or hands over to the next edge its trail stays as an afterimage and fades out in place), blasts (every tile inside the blast radius flashes hot, pops and cools to red in a wave from the centre with a little jitter, then a faint scorch fades), grand complex formation (`grand()`: member pulse, two rings spreading from the complex's centre, a label rising and fading), flag pop-in/out, reveal flip (the cover folds to an edge while darkening, then the number unfolds; ripples out from the clicked cell), tile intro (`intro()`: tiles pop in in a diagonal wave from the top-left of the screen, overlays fade in after), drone lines (grow to the target, ride to another mine, abandoned lines shrink back; a line the next one continues from shrinks towards its end), clock-wipe on the target, settlement pulse ripple. |
| `src/input.ts` | Pointer/touch/keyboard (`enabled` off during the title and intro): click vs drag, object grab (`grab` / `grabMove` / `grabEnd`, used for drones), long-press flag, wheel/pinch zoom, inertia, WASD/arrow pan. |
| `src/ui/hud.ts` | Top bar (credits, income, unbanked, streak, Cash Out; buttons: home, main base (same diamond as on the board), log, stats, settings) and status bar (mode, coords, density, zoom, seed). |
| `src/ui/panels.ts` | Side panel: Log, Stats (+ Liquidation), Settings, and the Base panel. Main base: title with its level, level-up cost and button in the header; network production, active / isolated / disabled base counts, next level's multiplier, and the upgrades (transport speed, streak cap). Other bases: isolation notice, production /s and /h, produced so far, main-base level, complex size and output, grand complex bonus, route to the main base in tiles / hops / travel time, bases routed through, next hop. Disabled bases: notice, repair cost and Repair button. |
| `src/ui/title.ts` | `TitleScreen` (MINEWORLD logo, Start or Continue + New game, film layer: generated grain tile, scanlines, flicker, vignette; `leave()` slides it away) and `StartHint`. |
| `src/ui/toast.ts` | Toasts and confirm dialog. |
| `src/ui/dom.ts` | `el()` helper, icons. |
| `src/theme.ts` | VS Code Light Modern / Dark Modern palettes for CSS and Pixi. |
| `src/style.css` | Chrome styling (flat, 1 px borders, single accent), title screen and film layer, HUD / status bar slide-out while `#app` is `.titling` or `.intro`. |
| `src/i18n.ts` | `t()` with Korean and English tables. |
| `src/format.ts` | Number / time formatting. |
| `src/storage.ts` | IndexedDB save (`SaveData` structured clone), localStorage settings. |

## Controls

- Title: Start (or Enter) begins; with a save, Continue resumes and New game replaces the world (cores are kept).
- Drag / wheel / pinch: pan and zoom. WASD or arrows also pan. `H` returns to the start cell (the first cell opened).
- Click a base (Owned mine) to open its panel; a disabled base (grey dot, struck through) is repaired there. The main base (start cell, large diamond), the HUD diamond button and `U` all open the main-base panel, where it is levelled up and the upgrades are bought.
- Classic mode: left-click opens, right-click or long-press flags, clicking a number chords.
- Toggle mode (Settings): the status-bar mode button or `F` switches open/flag for taps.
- `Space` cashes out. `U` / `L` open the main base / Log. `Esc` closes.

## Scripts

```
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run typecheck
```
