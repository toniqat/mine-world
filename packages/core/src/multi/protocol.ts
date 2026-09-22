import type { DeepPartial, GameConfig } from '../config';

/**
 * Earth multiplayer (user decisions 2026-09-22): the Earth map is always
 * played online. A Node server (packages/server) holds each session's
 * authoritative `Session`; clients send actions and mirror the board
 * (`MirrorGame`). Everything both sides must agree on lives here.
 */

/** Signature colours: every player in a session gets a different one. */
export const SIGNATURE_COLORS: readonly number[] = [
  0xe5484d, // red
  0xf76b15, // orange
  0xd4a106, // gold
  0x7cb518, // lime
  0x30a46c, // green
  0x12a594, // teal
  0x05a2c2, // cyan
  0x3e63dd, // blue
  0x6e56cf, // violet
  0xab4aba, // purple
  0xd6409f, // pink
  0x8d6e5a, // brown
];

export const MULTI = {
  /** A session holds fewer than 12 players (user decision). */
  maxPlayers: 11,
  /**
   * New players only join sessions with less than this share of the land
   * opened (user decision: 60 %). The share can drop again (a game over turns
   * land back to Unknown), and the session is joinable again; nobody is told.
   */
  joinMaxUnlock: 0.6,
  /**
   * The session is complete once this share of the land is opened (user
   * decision: 75 %; with ~23 % of the land mined, about all the safe land plus
   * a few bases). Whoever leads then wins; the board is frozen.
   */
  endUnlock: 0.75,
  /** From this share on the client shows the session's progress towards `endUnlock`. */
  progressFrom: 0.7,
  /** A player offline this long leaves the session; their land stays, uncoloured (user decision: 10 min). */
  idleKickMs: 10 * 60_000,
  /**
   * The first click makes the square of this radius (Chebyshev) around it
   * mine-free, so it always opens a patch; no opened cell may lie within
   * `startRadius + 1` of it (a number there would already have seen the square).
   */
  startRadius: 2,
  /** Wire protocol version; a client with another one is refused. */
  version: 2,
} as const;

/**
 * Game config of a multiplayer session (server and mirror alike): the Earth
 * map, no fog, no tiers, no pool cap, and no start-centred density (every
 * player has a start of their own; the first click clears its own square).
 */
export function multiConfig(seed: number): DeepPartial<GameConfig> {
  return {
    seed,
    world: { map: 'earth', startSafeRadius: 0, distanceRamp: 0 },
    fog: { enabled: false },
    tiers: { enabled: false },
    econ: { storageBase: Infinity },
  };
}

/** A player as the scoreboard shows them. `main`: key of their main base, null before their first click. */
export interface PlayerInfo {
  color: number;
  score: number;
  online: boolean;
  main: number | null;
}

/** Why an action was refused. */
export type MultiError = 'water' | 'tooClose' | 'version' | 'full';

// ------------------------------------------------------------ client -> server

export type ClientMsg =
  /**
   * First message. `token` resumes a player that is still in a session;
   * `leave` (a new game over a kept seat) removes that player first, their
   * land staying uncoloured, and seats a new one.
   */
  | { t: 'hello'; v: number; token?: string; leave?: string }
  | { t: 'reveal'; x: number; y: number }
  | { t: 'chord'; x: number; y: number }
  | { t: 'flag'; x: number; y: number; on: boolean }
  | { t: 'ping' };

// ------------------------------------------------------------ server -> client

/**
 * Cell changes, flattened: x, y, state, owner (colour + 1, 0 = none), from
 * (key of the cell a cascade started at, or -1) per cell.
 */
export type WireCells = number[];

export interface WelcomeMsg {
  t: 'welcome';
  token: string;
  session: string;
  seed: number;
  you: number;
  players: PlayerInfo[];
  /** Board chunks: [chunk key, states (256 bytes, base64), owners (256 bytes, base64)]. */
  chunks: Array<[number, string, string]>;
  /** Your flags (keys): flags are private. */
  flags: number[];
  /** Share of the land opened (`Session.unlockRatio`). */
  unlock: number;
  /** The final standings once the session is complete, else null. */
  final: PlayerInfo[] | null;
}

export type ServerMsg =
  | WelcomeMsg
  /** `unlock`: the share of the land opened after these changes. */
  | { t: 'cells'; by: number; cells: WireCells; unlock: number }
  | { t: 'blast'; x: number; y: number; r: number; color: number }
  | { t: 'settle'; color: number; x: number; y: number; cells: number[]; correct: number; wrong: number; payout: number }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'gameover'; score: number }
  /** The session is complete: the final standings (by score, the winner first). */
  | { t: 'finished'; players: PlayerInfo[] }
  | { t: 'error'; code: MultiError }
  | { t: 'pong' };
