import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby';
import { Store } from './store';

/**
 * Mine World multiplayer server (Earth mode): one WebSocket endpoint, sessions
 * kept in memory and saved to `DATA_DIR` (default packages/server/data).
 *   PORT       listen port (default 8787)
 *   DATA_DIR   where session saves live
 */
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
/** Idle players, finished sessions and saves are handled this often. */
const SWEEP_MS = 30_000;
/** Sockets that miss a ping for this long are dropped. */
const PING_MS = 30_000;

const lobby = new Lobby(new Store(DATA_DIR));

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`mine-world server · ${lobby.sessions.size} sessions\n`);
});

// Welcome messages carry whole boards: compress what is large.
const wss = new WebSocketServer({ server: http, perMessageDeflate: { threshold: 1024 }, maxPayload: 4096 });
const alive = new WeakMap<object, boolean>();

wss.on('connection', (ws) => {
  const conn = lobby.connect(ws);
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  ws.on('message', (data) => lobby.message(conn, data.toString()));
  ws.on('close', () => lobby.detach(conn));
  ws.on('error', () => ws.terminate());
});

const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, PING_MS);
const sweeper = setInterval(() => lobby.sweep(), SWEEP_MS);

http.listen(PORT, () => console.log(`mine-world server on :${PORT} · ${lobby.sessions.size} sessions loaded from ${DATA_DIR}`));

function shutdown(): void {
  clearInterval(pinger);
  clearInterval(sweeper);
  lobby.flush();
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  http.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
