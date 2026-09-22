# @mine/electron

Standalone shell around the web client. Development run only; packaging (electron-builder) is intentionally not configured yet.

## Files

| File | Responsibility |
|---|---|
| `src/main.ts` | Creates the window. Loads `VITE_DEV_SERVER_URL` when set, else `packages/web/dist/index.html`. Opens external links in the system browser. |
| `src/preload.cjs` | Sandboxed preload exposing `window.desktop = { platform, isElectron }`. |
| `dist/` | Compiled output of `npm run build:main` (git-ignored). |

## Scripts

```
npm run electron:dev        # from repo root: Vite dev server + Electron window
npm -w @mine/electron run start   # build web dist, then run the packaged-style window
```

Game state is stored in the renderer's IndexedDB, the same as in the browser.

## Dev-only flags (visual checks without a human)

```
npx electron . --exec=script.js --screenshot=out.png
```

`--size=390x844` sets the window's content size and lifts the 720 × 480 minimum, for checking the phone layout (touch rules need a real coarse pointer and are not emulated). `--exec` runs a script in the page after load (the page exposes `window.mineWorld`, the `App` instance); `--screenshot` captures the window ~2.5 s later and quits. If `ELECTRON_RUN_AS_NODE=1` is inherited from an IDE terminal, prefix with `env -u ELECTRON_RUN_AS_NODE` (the npm scripts already clear it).
