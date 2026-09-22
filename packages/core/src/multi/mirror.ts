import { CellState, isKnownMine, isRevealed, numberOf } from '../board';
import { makeConfig } from '../config';
import { type Actor, type CellChange, Game, PLAYER, type RevealResult } from '../game';
import { cellKey, forEachNeighbor, keyX, keyY } from '../key';
import { base64Decode } from './codec';
import { multiConfig, type ClientMsg, type PlayerInfo, type WelcomeMsg, type WireCells } from './protocol';
import { OwnerLayer } from './session';

const NOTHING: RevealResult = { hit: false, revealed: 0, intervened: false };

/**
 * The client's copy of a multiplayer session: a `Game` whose board is written
 * by the server (`applyCells`), so the renderer and the input code work on it
 * as on a local game. Openings and chords are only sent (`send`); the server
 * answers with the cells they changed. Flags and "?" marks are private: they
 * live on this board only, and flags are also sent so the server can settle
 * them. Settlement, scoring and hits happen on the server.
 *
 * `world.started` means "my main base exists" (the start hint, `H`), and the
 * world's start cell is my main base.
 *
 * Once the session is complete (`final`) the board is frozen: nothing can be
 * opened, chorded, flagged or marked any more, but it can still be looked at.
 */
export class MirrorGame extends Game {
  readonly owners: OwnerLayer;
  readonly token: string;
  readonly session: string;
  /** My signature colour index. */
  readonly me: number;
  players: PlayerInfo[] = [];
  /** Share of the land opened, as the server last said. */
  unlock: number;
  /** Final standings once the session is complete, else null. */
  final: PlayerInfo[] | null;
  send: (m: ClientMsg) => void = () => {};

  constructor(w: WelcomeMsg) {
    super(makeConfig(multiConfig(w.seed)));
    this.owners = new OwnerLayer(this.world.wrap);
    this.token = w.token;
    this.session = w.session;
    this.me = w.you;
    this.unlock = w.unlock;
    this.final = w.final;
    for (const [ck, states, owners] of w.chunks) {
      this.board.chunks.set(ck, base64Decode(states));
      const o = base64Decode(owners);
      if (o.some((v) => v)) this.owners.chunks.set(ck, o);
    }
    this.board.recount();
    for (const k of w.flags) if (this.board.get(keyX(k), keyY(k)) === CellState.Unknown) this.board.set(keyX(k), keyY(k), CellState.Flag);
    this.setPlayers(w.players);
  }

  override get online(): boolean {
    return true;
  }

  override cellOwner(x: number, y: number): number {
    return this.owners.get(x, y) - 1;
  }

  override mainBases(): Array<{ key: number; color: number }> {
    const out: Array<{ key: number; color: number }> = [];
    for (const p of this.players) if (p.main !== null) out.push({ key: p.main, color: p.color });
    return out;
  }

  /** My entry on the scoreboard (absent once I left). */
  mine(): PlayerInfo | undefined {
    return this.players.find((p) => p.color === this.me);
  }

  /** The scoreboard changed: my main base becomes the world's start cell. */
  setPlayers(list: PlayerInfo[]): void {
    this.players = list;
    const main = this.mine()?.main ?? null;
    if (main !== null && (!this.world.started || this.world.startX !== keyX(main) || this.world.startY !== keyY(main))) {
      this.world.startX = keyX(main);
      this.world.startY = keyY(main);
      this.world.started = true;
    }
    this.events.emit('bases', this.bases);
  }

  /** Cells the server changed (flattened, see `WireCells`). */
  applyCells(wire: WireCells): void {
    const list: CellChange[] = [];
    for (let i = 0; i < wire.length; i += 5) {
      const x = wire[i];
      const y = wire[i + 1];
      const s = wire[i + 2];
      const from = wire[i + 4];
      // A flag of mine on a cell the server still has closed stays (the server keeps it too).
      if (s === CellState.Unknown && this.board.get(x, y) === CellState.Flag) {
        this.owners.set(x, y, 0);
        continue;
      }
      this.board.set(x, y, s);
      this.owners.set(x, y, wire[i + 3]);
      if (s !== CellState.Unknown) this.questions.delete(cellKey(x, y));
      list.push(from >= 0 ? { x, y, state: s, from } : { x, y, state: s });
    }
    if (list.length) this.events.emit('cells', list);
  }

  override reveal(x: number, y: number): RevealResult {
    if (this.final) return NOTHING;
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (s !== CellState.Unknown) return NOTHING;
    this.send({ t: 'reveal', x, y });
    return NOTHING;
  }

  override chord(x: number, y: number): RevealResult {
    if (this.final) return NOTHING;
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (!isRevealed(s)) return NOTHING;
    let marked = 0;
    let targets = 0;
    forEachNeighbor(x, y, (nx, ny) => {
      const ns = this.board.get(nx, ny);
      if (ns === CellState.Flag || isKnownMine(ns)) marked++;
      else if (ns === CellState.Unknown) targets++;
    }, this.wrap);
    if (marked === numberOf(s) && targets > 0) this.send({ t: 'chord', x, y });
    return NOTHING;
  }

  override cycleMark(x: number, y: number): void {
    if (!this.final) super.cycleMark(x, y);
  }

  /** Flags need a main base (the server ignores them before it). */
  override setFlag(x: number, y: number, on: boolean, actor: Actor = PLAYER): void {
    if (!this.world.started || this.final) return;
    x = this.wx(x);
    const before = this.board.get(x, y);
    super.setFlag(x, y, on, actor);
    if (this.board.get(x, y) !== before) this.send({ t: 'flag', x, y, on });
  }
}
