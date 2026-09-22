# @mine/server

Multiplayer server for the Earth mode: one WebSocket endpoint. Every session is an authoritative `Session` from `@mine/core` (`packages/core/src/multi`); clients only send actions and mirror the board. Node + `ws`, run through `tsx` (core is consumed as TypeScript source).

## Files

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point: HTTP server (plain-text status on `GET /`) with the WebSocket server on it (permessage-deflate for messages over 1 kB, 4 kB max client message), a ping every 30 s (sockets that miss one are dropped), the lobby sweep every 30 s, and a final save on SIGINT / SIGTERM. Env: `PORT` (8787), `DATA_DIR` (`packages/server/data`). |
| `src/lobby.ts` | `Lobby`: sessions and their connections. `hello` first removes the player a `leave` token names (a new game over a kept seat: their connections close, their land stays uncoloured), then resumes the player a token names (a second connection for the same token replaces the first), otherwise seats a new player (random free colour) in a random joinable session (not complete, fewer than `MULTI.maxPlayers` players and under `MULTI.joinMaxUnlock` (60 %) of the land opened; a session that drops back under it takes players again, silently), creating a session when none is. Actions (`reveal`, `chord`, `flag`) are validated (integer coordinates, a 40-per-second token bucket) and run on the session; a refused one answers `error`. Session events are broadcast to everyone in it; `gameover` goes to the player who hit the mine, whose connection is then detached. A closed connection marks its player offline; `sweep` drops players offline longer than `MULTI.idleKickMs` (their land stays, uncoloured), deletes empty sessions nobody can join any more (complete, or past the join limit) and saves every session that changed. |
| `src/store.ts` | `Store`: one JSON file per session (`<id>.json`, `Session.toSave()`), written through a temp file; `loadAll` at start-up (players come back offline). |

## Protocol

JSON messages, types in `packages/core/src/multi/protocol.ts` (`ClientMsg`, `ServerMsg`). The client says `hello` (protocol version, optional token, optional `leave` token) and gets `welcome` (token, session, seed, its colour, the scoreboard, every board chunk with its owners, its own flags, the opened share `unlock`, the final standings `final` or null). After that the server pushes `cells` (flattened changes with owners, and the opened share `unlock`), `finished` (the session is complete at `MULTI.endUnlock`: final standings), `players` (scoreboard), `blast`, `settle`, `gameover` and `error`.

## Scripts

```
npm run server        # from the repo root: listen on :8787
npm run server:dev    # restart on changes
PORT=9000 DATA_DIR=/var/lib/mineworld npm -w @mine/server run start
```

The web client connects to `VITE_MINE_SERVER` (set when building, e.g. `wss://mine.example.com`) or, without it, to port 8787 on the page's host. The GitHub Pages build has no server of its own: set `VITE_MINE_SERVER` in the workflow once one is deployed.
