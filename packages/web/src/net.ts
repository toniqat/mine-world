import { MULTI, type ClientMsg, type MultiError, type ServerMsg, type WelcomeMsg } from '@mine/core';

/** The server does not answer `hello` within this long: give up. */
const CONNECT_TIMEOUT_MS = 8000;
const TOKEN_KEY = 'mineworld.token';

/**
 * Multiplayer server address: `VITE_MINE_SERVER` at build time (e.g.
 * wss://mine.example.com), otherwise port 8787 on the page's host (the dev
 * setup: `npm run server` next to `npm run dev`).
 */
export function serverUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MINE_SERVER;
  if (env) return env;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
  return `${secure ? 'wss' : 'ws'}://${host}:8787`;
}

/** The token that resumes my player (kept until game over). */
export function savedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

export class ConnectError extends Error {
  constructor(readonly code: MultiError | 'unreachable') {
    super(code);
  }
}

/**
 * One WebSocket to the server. `connect` resolves once the server welcomed
 * us; after that every message goes to `onMessage`, and `onClose` fires when
 * the connection drops (not after `close()`).
 */
export class NetClient {
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;

  private constructor(private ws: WebSocket) {}

  /** `leave`: a kept seat to give up before a new one is taken (a new game). */
  static connect(url: string, token: string | null, leave: string | null = null): Promise<{ net: NetClient; welcome: WelcomeMsg }> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        return reject(new ConnectError('unreachable'));
      }
      const net = new NetClient(ws);
      let settled = false;
      const fail = (code: MultiError | 'unreachable') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        net.closed = true;
        ws.close();
        reject(new ConnectError(code));
      };
      const timer = setTimeout(() => fail('unreachable'), CONNECT_TIMEOUT_MS);
      ws.onopen = () => net.send({ t: 'hello', v: MULTI.version, ...(token ? { token } : {}), ...(leave ? { leave } : {}) });
      ws.onerror = () => fail('unreachable');
      ws.onclose = () => {
        if (!settled) return fail('unreachable');
        if (!net.closed) {
          net.closed = true;
          net.onClose();
        }
      };
      ws.onmessage = (e) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(String(e.data)) as ServerMsg;
        } catch {
          return;
        }
        if (!settled) {
          if (m.t === 'error') return fail(m.code);
          if (m.t !== 'welcome') return;
          settled = true;
          clearTimeout(timer);
          return resolve({ net, welcome: m });
        }
        net.onMessage(m);
      };
    });
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}
