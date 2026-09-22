import { DroneManager, type DroneState } from './agents/drone';
import { Board, CellState, isKnownMine, isRevealed, isWall, numberOf, revealedState } from './board';
import { type GameConfig, makeConfig } from './config';
import { collectRegion, type CspContext, type Mode, type ScannerInfo } from './csp';
import { Bases, type BaseInfo, type GrandFormed } from './econ/bases';
import { blastRadius, blastRange, inBlast, repairCost, type BlastRange } from './econ/blast';
import { audit, type AuditResult } from './econ/contamination';
import { Econ } from './econ/income';
import { Upgrades } from './econ/upgrades';
import { Emitter } from './events';
import { Fog } from './fog';
import { cellKey, chebyshev, deltaX, forEachNeighbor, keyX, keyY, wrapX } from './key';
import { resolveReveal } from './resolve';
import type { SaveData } from './save';
import { ALL_TIERS, NO_TIERS, solve, type SolveOptions, type SolveResult, type TierSet } from './solver';
import { World } from './world';

/**
 * Game = reveal / flag / settle transactions (spec §13.1 core/game.ts).
 * Pure logic: no DOM, no renderer (INV-6). UI subscribes to `events`.
 */
export type Actor = { kind: 'player' } | { kind: 'drone'; id: number } | { kind: 'system' };
export const PLAYER: Actor = { kind: 'player' };

export interface CellChange {
  x: number;
  y: number;
  state: number;
  /** For cells opened by a cascade: key of the cell the cascade started from. */
  from?: number;
}

export interface RevealResult {
  hit: boolean;
  revealed: number;
  intervened: boolean;
  /** Nothing opened because the unbanked pool is full (Cash Out first). */
  full?: boolean;
}

export interface HitEvent {
  x: number;
  y: number;
  actor: Actor;
  loss: number;
  blast: BlastEvent;
}

/**
 * The explosion a hit sets off: every base within `r` of the mine is disabled
 * (never the main base) and every flag inside is lifted; a flag that sat on a
 * mine goes off too (`chain`), with a blast of its own.
 */
export interface BlastEvent {
  r: number;
  /** Bases disabled by this blast and its chain. */
  disabled: number[];
  /** Flags lifted from safe cells by this blast and its chain. */
  cleared: number;
  /** Flagged mines set off in a chain, in the order they went off, with their blast radii. */
  chain: Array<{ x: number; y: number; r: number }>;
}

/**
 * Drone equipment. Drones are not sold at the moment; the logic stays for the
 * planned equipment items, which will set this through `equipDrones`.
 */
export interface DroneLoadout {
  count: number;
  /** Solver tiers drones (and the probability overlay) use. */
  tiers: TierSet;
  radiusLevel: number;
  speedLevel: number;
  /** Drones may be switched to public-only deduction. */
  safeMode: boolean;
}


export function emptyLoadout(): DroneLoadout {
  return { count: 0, tiers: { ...NO_TIERS }, radiusLevel: 0, speedLevel: 0, safeMode: false };
}

export interface SettlementEvent {
  x: number;
  y: number;
  correct: number;
  wrong: number;
  payout: number;
  loss: number;
  cells: number[];
}

export type LogKind =
  | 'hit'
  | 'settlement'
  | 'drone_explode'
  | 'audit'
  | 'scanner'
  | 'probe'
  | 'prestige'
  | 'cashout'
  | 'purchase'
  | 'repair'
  | 'info';

export interface LogEntry {
  id: number;
  t: number;
  kind: LogKind;
  x?: number;
  y?: number;
  data: Record<string, unknown>;
}

export type GameEvents = {
  cells: CellChange[];
  hit: HitEvent;
  settlement: SettlementEvent;
  econ: Econ;
  log: LogEntry;
  scanners: ScannerInfo[];
  drones: DroneState[];
  /** Bases, the base network or the main-base level changed. */
  bases: Bases;
  /** A complex just became grand (at least `grandMinBases` bases). */
  grand: GrandFormed;
  /** Cells the fog of war just lifted from (keys). */
  fog: number[];
  /** The mining technology levelled up: the highest tier that can now be mined. */
  tech: number;
  reset: { seed: number };
};

const LOG_LIMIT = 300;

export class Game {
  cfg: GameConfig;
  world!: World;
  board!: Board;
  scanners: ScannerInfo[] = [];
  ctx!: CspContext;
  econ!: Econ;
  private _bases!: Bases;
  fog!: Fog;
  /** Unknown cells the player marked with "?": a plain note, no game effect (not a flag, never settled). */
  questions = new Set<number>();
  upgrades!: Upgrades;
  drones!: DroneManager;
  droneLoadout: DroneLoadout = emptyLoadout();
  log: LogEntry[] = [];
  time = 0;
  rescues = { left: 0 };
  stats: Record<string, number> = {};
  readonly events = new Emitter<GameEvents>();

  private changed: CellChange[] = [];
  private nextLogId = 1;
  private nextScannerId = 1;
  private inAction = 0;
  /** The bases changed (new Owned mine, or a cell opened next to an isolated base). */
  private basesDirty = true;
  /** Flags placed since the last opening; they (and flags around them) settle on the next one (see `afterAction`). */
  private deferred = new Set<number>();
  /** The player opened something in the current action: a turn passes when it ends. */
  private turnPending = false;
  /** Inside `chord`: its reveals are never rescued. */
  private chording = false;

  constructor(cfg: Partial<GameConfig> | GameConfig = {}) {
    this.cfg = makeConfig(cfg as GameConfig);
    this.initState(this.cfg.seed);
  }

  private initState(seed: number): void {
    this.cfg.seed = seed;
    this.world = new World(this.cfg.world, seed);
    this.board = new Board();
    this.board.terrain = (x, y) => this.world.terrain(x, y);
    this.board.wrap = this.world.wrap;
    this.scanners = [];
    this.ctx = { board: this.board, world: this.world, scanners: this.scanners };
    const cores = this.econ?.cores ?? 0;
    const lifetime = this.econ?.lifetime;
    this.econ = new Econ(this.cfg.econ, this.cfg.world.densityMin);
    this.econ.cores = cores;
    if (lifetime) this.econ.lifetime = lifetime;
    this._bases = new Bases(this.cfg.bases, this.econ, (x, y) => this.board.get(x, y), this.world.wrap);
    this.basesDirty = true;
    this.fog = new Fog(this.cfg.fog, this.world.wrap);
    this.questions = new Set();
    this.upgrades = new Upgrades();
    this.applyUpgrades();
    this.drones = new DroneManager(this.cfg.drones);
    this.droneLoadout = emptyLoadout();
    this.log = [];
    this.time = 0;
    this.rescues = { left: this.cfg.resolve.forgivingRescues };
    this.stats = { interventions: 0, minesMoved: 0, closures: 0, forfeited: 0 };
    this.changed = [];
    this.deferred = new Set();
    this.turnPending = false;
    this.nextScannerId = 1;
  }

  // ------------------------------------------------------------------ queries

  /** The base network, rebuilt on access when bases changed since the last read (so bursts of actions rebuild once). */
  get bases(): Bases {
    if (this.basesDirty || this.mainBaseKey() !== this._bases.main) this.syncBases();
    return this._bases;
  }

  cellState(x: number, y: number): number {
    return this.board.get(x, y);
  }

  /**
   * Columns after which the world repeats (the Earth mode's map width), 0 when
   * it does not wrap. Every method takes any x; cells in events, keys and saves
   * are canonical (0 <= x < wrap).
   */
  get wrap(): number {
    return this.world.wrap;
  }

  /** Canonical column of `x` (see `wrap`). */
  wx(x: number): number {
    return wrapX(x, this.world.wrap);
  }

  /**
   * Hidden by the fog of war: a closed cell (Unknown, flag or wall) no vision
   * source has seen yet. It cannot be opened or flagged, and walls under it
   * look like any other fogged cell. Before the start is set everything is
   * fogged; the first click places the main base anyway (see `reveal`).
   */
  fogged(x: number, y: number): boolean {
    if (!this.cfg.fog.enabled || (this.world.started && this.fog.isSeen(x, y))) return false;
    const s = this.board.get(x, y);
    return s === CellState.Unknown || s === CellState.Flag || isWall(s);
  }

  /** Mining tier of a cell: 1 + the number of `tiers.radii` rings its distance from the main base has passed. */
  tierAt(x: number, y: number): number {
    const c = this.cfg.tiers;
    if (!c.enabled || !this.world.started) return 1;
    const d = this.world.distFromStart(x, y);
    let t = 1;
    for (const r of c.radii) if (d >= r) t++;
    return t;
  }

  /** Highest tier the mining technology allows: 1 + its level. */
  miningTier(): number {
    return 1 + this.upgrades.level('mining');
  }

  /** In a tier the mining technology does not reach yet: cannot be opened, flagged or chorded into. */
  locked(x: number, y: number): boolean {
    return this.cfg.tiers.enabled && this.tierAt(x, y) > this.miningTier();
  }

  densityAt(x: number, y: number): number {
    return this.world.density(x, y);
  }

  /** The unbanked pool is full: nothing can be opened until Cash Out. */
  full(): boolean {
    return this.econ.full();
  }

  /** Played online (`MirrorGame`): the server decides every opening and settlement. */
  get online(): boolean {
    return false;
  }

  /** Online: signature colour index of the player owning an opened cell or base; -1 for nobody (always offline). */
  cellOwner(_x: number, _y: number): number {
    return -1;
  }

  /** Online: every player's main base and colour index. Offline the main base is `bases.main`. */
  mainBases(): Array<{ key: number; color: number }> {
    return [];
  }

  /** Solver tiers of the drone equipment (none unless equipped). */
  playerTiers(): TierSet {
    return this.droneLoadout.tiers;
  }

  hasProbabilities(): boolean {
    return this.droneLoadout.tiers.t4;
  }

  droneRadius(): number {
    return this.cfg.drones.baseRadius + this.cfg.drones.radiusPerLevel * this.droneLoadout.radiusLevel;
  }

  droneActionsPerSec(): number {
    return this.cfg.drones.baseActionsPerSec + this.cfg.drones.speedPerLevel * this.droneLoadout.speedLevel;
  }

  /** Tiles per second a drone's line grows (and the drone rides it). */
  droneMoveSpeed(): number {
    return this.cfg.drones.baseMoveTilesPerSec + this.cfg.drones.moveSpeedPerLevel * this.droneLoadout.speedLevel;
  }

  /** Radius range of a blast at (x, y): wider in higher mining tiers. */
  blastRangeAt(x: number, y: number): BlastRange {
    return blastRange(this.cfg.blast, this.tierAt(x, y));
  }

  /** Credits a repair costs now: grows with the number of opened cells. */
  repairCost(): number {
    return repairCost(this.cfg.blast, this.board.revealedCount);
  }

  /** Key of the main base (the start cell), or null before the first cell is opened. */
  mainBaseKey(): number | null {
    return this.world.started ? cellKey(this.world.startX, this.world.startY) : null;
  }

  /** Base at (x, y): an Owned mine or the main base. */
  baseInfo(x: number, y: number): BaseInfo | null {
    return this.bases.info(cellKey(this.wx(x), y));
  }

  ownedKeys(): Iterable<number> {
    return this.econ.owned.keys();
  }

  seed(): number {
    return this.cfg.seed;
  }

  /** Cell the world was started from (the first cell opened; (0, 0) before that). */
  startCell(): { x: number; y: number } {
    return { x: this.world.startX, y: this.world.startY };
  }

  solveOptions(tiers: TierSet = ALL_TIERS): SolveOptions {
    const s = this.cfg.solver;
    return {
      tiers,
      t3MaxCells: s.t3MaxCells,
      t4MaxCells: s.t4MaxCells,
      solutionCap: s.solutionCap,
      nodeBudget: s.nodeBudget,
      prior: (k) => this.world.density(keyX(k), keyY(k)),
    };
  }

  /** Solve the constraints inside a rect with the player's purchased tiers. */
  analyze(x0: number, y0: number, x1: number, y1: number, mode: Mode = 'belief', tiers?: TierSet): SolveResult {
    const cons = collectRegion(this.ctx, mode, x0, y0, x1, y1, true);
    return solve(cons, this.solveOptions(tiers ?? this.playerTiers()));
  }

  // ------------------------------------------------------------------ actions

  reveal(x: number, y: number, actor: Actor = PLAYER, basis?: number[]): RevealResult {
    x = this.wx(x);
    if (this.board.get(x, y) !== CellState.Unknown) return { hit: false, revealed: 0, intervened: false };
    // The world starts all Unknown and fogged. The first click places the main
    // base there (fog or not) and opens the mine-free start area around it.
    if (!this.world.started) {
      this.world.setStart(x, y);
      this.updateFog();
    }
    if (this.fogged(x, y) || this.locked(x, y)) return { hit: false, revealed: 0, intervened: false };
    if (this.econ.full()) return { hit: false, revealed: 0, intervened: false, full: true };
    this.inAction++;
    if (actor.kind === 'player') this.turnPending = true;
    const r = resolveReveal({ cfg: this.cfg, ctx: this.ctx, rescues: this.rescues }, x, y, !this.chording);
    if (r.intervened) {
      this.stats.interventions++;
      this.stats.minesMoved += r.movedMines;
    }
    let result: RevealResult;
    if (r.truth === 1) {
      this.setCell(x, y, CellState.Exploded);
      const loss = this.econ.onHit();
      const blast = this.explode(x, y);
      if (actor.kind === 'drone') {
        this.pushLog('drone_explode', x, y, { drone: actor.id, loss, basis: basis ?? [], disabled: blast.disabled.length });
      } else {
        this.pushLog('hit', x, y, { loss, r: blast.r, disabled: blast.disabled.length, chain: blast.chain.length, cleared: blast.cleared });
      }
      this.events.emit('hit', { x, y, actor, loss, blast });
      result = { hit: true, revealed: 0, intervened: false };
    } else {
      const n = this.cascade(x, y);
      if (actor.kind === 'player') this.econ.onSafeClick();
      this.econ.gain(n * this.cfg.econ.tilePoints);
      this.econ.lifetime.cellsRevealed += n;
      result = { hit: false, revealed: n, intervened: r.intervened };
    }
    this.inAction--;
    this.afterAction();
    return result;
  }

  /**
   * Reveal every unknown neighbour of a satisfied number (classic chord), as
   * one action (one turn). The reveals are never rescued: a chord trusts the
   * flags, so a wrong flag lets the real mine go off. It stops once the
   * unbanked pool fills up.
   */
  chord(x: number, y: number, actor: Actor = PLAYER): RevealResult {
    x = this.wx(x);
    const s = this.board.get(x, y);
    const out: RevealResult = { hit: false, revealed: 0, intervened: false };
    if (!isRevealed(s)) return out;
    const n = numberOf(s);
    let marked = 0;
    const targets: Array<[number, number]> = [];
    forEachNeighbor(x, y, (nx, ny) => {
      const ns = this.board.get(nx, ny);
      if (ns === CellState.Flag || isKnownMine(ns)) marked++;
      else if (ns === CellState.Unknown && !this.fogged(nx, ny) && !this.locked(nx, ny)) targets.push([nx, ny]);
    }, this.world.wrap);
    if (marked !== n || targets.length === 0) return out;
    if (this.econ.full()) return { ...out, full: true };
    this.inAction++;
    this.chording = true;
    for (const [tx, ty] of targets) {
      const r = this.reveal(tx, ty, actor);
      out.full = out.full || r.full;
      out.hit = out.hit || r.hit;
      out.revealed += r.revealed;
      out.intervened = out.intervened || r.intervened;
    }
    this.chording = false;
    this.inAction--;
    this.afterAction();
    return out;
  }

  /** Toggle a flag. Has no observable effect beyond the flag itself (INV-2) except component closure (§9.2). */
  toggleFlag(x: number, y: number, actor: Actor = PLAYER): boolean {
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (this.fogged(x, y) || this.locked(x, y)) return false;
    if (s === CellState.Unknown) return this.setFlag(x, y, true, actor), true;
    if (s === CellState.Flag) return this.setFlag(x, y, false, actor), false;
    return false;
  }

  /** Carries a "?" mark (see `cycleMark`). */
  questioned(x: number, y: number): boolean {
    return this.questions.size > 0 && this.questions.has(cellKey(this.wx(x), y));
  }

  /**
   * Right-click cycle: Unknown -> flag -> "?" -> Unknown. The "?" is only a
   * note for the player: the cell stays Unknown for every rule (it can be
   * opened, chorded into and is never settled).
   */
  cycleMark(x: number, y: number): void {
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (this.fogged(x, y) || this.locked(x, y)) return;
    const k = cellKey(x, y);
    if (s === CellState.Flag) {
      // Mark first: lifting the flag emits the cell change that repaints it.
      this.questions.add(k);
      this.setFlag(x, y, false);
    } else if (s === CellState.Unknown) {
      if (this.questions.delete(k)) this.events.emit('cells', [{ x, y, state: s }]);
      else this.setFlag(x, y, true);
    }
  }

  setFlag(x: number, y: number, on: boolean, actor: Actor = PLAYER): void {
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (on && (s !== CellState.Unknown || this.fogged(x, y) || this.locked(x, y))) return;
    if (!on && s !== CellState.Flag) return;
    this.inAction++;
    // Placing a flag is a player turn; lifting one (flag -> "?") is not.
    if (on && actor.kind === 'player') this.turnPending = true;
    this.setCell(x, y, on ? CellState.Flag : CellState.Unknown);
    this.inAction--;
    // A flag never settles anything by itself; the next opening does.
    this.afterAction(false);
  }

  cashOut(): number {
    const amt = this.econ.cashOut();
    this.pushLog('cashout', undefined, undefined, { amount: amt });
    this.events.emit('econ', this.econ);
    return amt;
  }

  buy(id: string): { ok: boolean; reason?: 'maxed' | 'requires' | 'money' } {
    const blocked = this.upgrades.blocked(id);
    if (blocked) return { ok: false, reason: blocked };
    const cost = this.upgrades.cost(id);
    if (!this.econ.spend(cost)) return { ok: false, reason: 'money' };
    this.upgrades.apply(id);
    this.applyUpgrades();
    this.pushLog('purchase', undefined, undefined, { id, cost, level: this.upgrades.level(id) });
    this.events.emit('econ', this.econ);
    if (id === 'mining') this.events.emit('tech', this.miningTier());
    return { ok: true };
  }

  /** Push upgrade levels into the systems they tune. */
  private applyUpgrades(): void {
    this.econ.streakCapBonus = this.cfg.econ.streakCapPerLevel * this.upgrades.level('streak_cap');
  }

  /**
   * A mine went off at (x, y): roll the blast radius for its mining tier,
   * disable every base inside (the main base is immune) and lift every flag
   * inside. A lifted flag that sat on a mine goes off as well (Exploded, not
   * repairable) and blasts in turn; only the first mine burns unbanked funds.
   */
  private explode(x: number, y: number): BlastEvent {
    const hits = this.econ.lifetime.hits;
    const ev: BlastEvent = { r: 0, disabled: [], cleared: 0, chain: [] };
    const queue: Array<[number, number]> = [[x, y]];
    for (let i = 0; i < queue.length; i++) {
      const [bx, by] = queue[i];
      const r = blastRadius(this.cfg.blast, this.tierAt(bx, by), this.cfg.seed, bx, by, hits + i);
      if (i === 0) ev.r = r;
      else ev.chain.push({ x: bx, y: by, r });
      for (const [k, m] of this.econ.owned) {
        if (m.disabled || !inBlast(deltaX(keyX(k), bx, this.world.wrap), keyY(k) - by, r)) continue;
        m.disabled = true;
        ev.disabled.push(k);
      }
      const n = Math.ceil(r);
      for (let dy = -n; dy <= n; dy++) {
        for (let dx = -n; dx <= n; dx++) {
          const fx = this.wx(bx + dx);
          const fy = by + dy;
          if (!inBlast(dx, dy, r) || this.board.get(fx, fy) !== CellState.Flag) continue;
          // What the blast shows (mine or not) is observed truth: pin it.
          const mine = this.world.truth(fx, fy) === 1;
          this.world.commit(cellKey(fx, fy), mine ? 1 : 0);
          if (mine) {
            this.setCell(fx, fy, CellState.Exploded);
            queue.push([fx, fy]);
          } else {
            this.setCell(fx, fy, CellState.Unknown);
            ev.cleared++;
          }
        }
      }
    }
    if (ev.disabled.length) this.basesDirty = true;
    return ev;
  }

  /** Bring a disabled base back for `repairCost()` credits. */
  repairBase(x: number, y: number): { ok: boolean; reason?: 'notDisabled' | 'money' } {
    x = this.wx(x);
    const m = this.econ.owned.get(cellKey(x, y));
    if (!m?.disabled) return { ok: false, reason: 'notDisabled' };
    const cost = this.repairCost();
    if (!this.econ.spend(cost)) return { ok: false, reason: 'money' };
    m.disabled = false;
    this.pushLog('repair', x, y, { cost });
    this.syncBases();
    this.events.emit('econ', this.econ);
    return { ok: true };
  }

  /** Level up the main base (the network level). */
  upgradeMainBase(): { ok: boolean; reason?: 'maxed' | 'money' | 'nobase' } {
    if (this.bases.main === null) return { ok: false, reason: 'nobase' };
    if (this.bases.maxed()) return { ok: false, reason: 'maxed' };
    const cost = this.bases.upgradeCost();
    if (!this.econ.spend(cost)) return { ok: false, reason: 'money' };
    this.bases.mainLevel++;
    this.pushLog('purchase', undefined, undefined, { id: 'main_base', cost, level: this.bases.mainLevel });
    this.syncBases();
    this.events.emit('econ', this.econ);
    return { ok: true };
  }

  /**
   * Equip drones (the hook for the planned equipment items; nothing in the
   * game calls it yet). New drones place themselves on an Owned mine on the
   * next tick.
   */
  equipDrones(loadout: Partial<Omit<DroneLoadout, 'tiers'>> & { tiers?: Partial<TierSet> }): void {
    this.droneLoadout = { ...this.droneLoadout, ...loadout, tiers: { ...this.droneLoadout.tiers, ...(loadout.tiers ?? {}) } };
    this.drones.ensureCount(this.droneLoadout.count);
    this.events.emit('drones', this.drones.drones);
  }

  /** Drones stand on Owned mines only, one per mine. */
  canPlaceDrone(id: number, x: number, y: number): boolean {
    x = this.wx(x);
    return this.board.get(x, y) === CellState.Owned && !this.drones.occupied(x, y, id);
  }

  placeDrone(id: number, x: number, y: number): boolean {
    if (!this.canPlaceDrone(id, x, y)) return false;
    this.drones.place(id, this.wx(x), y);
    this.events.emit('drones', this.drones.drones);
    return true;
  }

  /** Pause a drone while it is being dragged; releasing without a drop keeps its anchor. */
  holdDrone(id: number, on: boolean): void {
    this.drones.hold(id, on);
    this.events.emit('drones', this.drones.drones);
  }

  resumeDrone(id: number): void {
    this.drones.resume(id);
    this.events.emit('drones', this.drones.drones);
  }

  setDroneOptions(id: number, opts: { safeMode?: boolean }): void {
    const d = this.drones.get(id);
    if (!d) return;
    if (opts.safeMode !== undefined && this.droneLoadout.safeMode) d.safeMode = opts.safeMode;
    this.events.emit('drones', this.drones.drones);
  }

  /**
   * Scanner (§11): counts mines in a (2r+1)^2 box and adds a public constraint.
   * All undecided cells in the box are committed first so the count is a truth.
   * Not offered to the player at the moment (consumables were removed); kept
   * for future items, with the price passed by the caller.
   */
  useScanner(cx: number, cy: number, r: 1 | 2, cost = 0): ScannerInfo | null {
    cx = this.wx(cx);
    if (!this.econ.spend(cost)) return null;
    let n = 0;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const s = this.board.get(x, y);
        if (isKnownMine(s)) n++;
        else if (!isRevealed(s)) {
          const t = this.world.truth(x, y);
          this.world.commit(cellKey(this.wx(x), y), t);
          n += t;
        }
      }
    }
    const info: ScannerInfo = { id: this.nextScannerId++, cx, cy, r, n };
    this.scanners.push(info);
    this.pushLog('scanner', cx, cy, { r, n, cost });
    this.events.emit('scanners', this.scanners);
    this.events.emit('econ', this.econ);
    this.afterAction();
    return info;
  }

  /** Probe (§11): reveals one cell's truth. A mine becomes owned immediately; a safe cell opens. Not offered to the player at the moment. */
  useProbe(x: number, y: number, cost = 0): { mine: boolean } | null {
    x = this.wx(x);
    const s = this.board.get(x, y);
    if (s !== CellState.Unknown && s !== CellState.Flag) return null;
    if (!this.econ.spend(cost)) return null;
    this.inAction++;
    const t = this.world.truth(x, y);
    this.world.commit(cellKey(x, y), t);
    if (t === 1) {
      this.setCell(x, y, CellState.Owned);
      const r = this.econ.onSettlement([{ key: cellKey(x, y), density: this.world.density(x, y) }], 0);
      this.basesDirty = true;
      this.pushLog('probe', x, y, { mine: true, cost, payout: r.payout });
    } else {
      if (s === CellState.Flag) this.setCell(x, y, CellState.Unknown);
      const n = this.cascade(x, y);
      this.econ.lifetime.cellsRevealed += n;
      this.pushLog('probe', x, y, { mine: false, cost });
    }
    this.inAction--;
    this.events.emit('econ', this.econ);
    this.afterAction();
    return { mine: t === 1 };
  }

  /** Audit (§10.3). Not offered to the player at the moment. */
  runAudit(plus: boolean, cost = 0): AuditResult | null {
    if (!this.econ.spend(cost)) return null;
    const r = audit(this.board, this.world, plus);
    this.pushLog('audit', undefined, undefined, { plus, total: r.total, wrong: r.wrong, sectors: r.sectors, cost });
    this.events.emit('econ', this.econ);
    return r;
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    this.time += dt;
    this.bases.tick(dt);
    this.updateFog();
    if (this.drones.drones.length) {
      const sig = () => this.drones.drones.map((d) => `${d.status}${d.placed ? `@${d.x},${d.y}` : ''}`).join();
      const before = sig();
      this.drones.tick(dt, this);
      if (sig() !== before) this.events.emit('drones', this.drones.drones);
    }
  }

  /** Prestige A (§12): liquidate all owned mines into cores and start a new world. */
  prestigePreview(): { gain: number; allowed: boolean; owned: number } {
    const owned = this.econ.owned.size;
    return { gain: this.econ.prestigeGain(), allowed: owned >= this.cfg.econ.prestigeMinOwned, owned };
  }

  liquidate(): number | null {
    const p = this.prestigePreview();
    if (!p.allowed) return null;
    const lifetime = this.econ.lifetime;
    lifetime.prestiges++;
    const cores = this.econ.cores + p.gain;
    this.econ.cores = cores;
    this.initState(this.cfg.seed + 1);
    this.econ.cores = cores;
    this.econ.lifetime = lifetime;
    this.pushLog('prestige', undefined, undefined, { gain: p.gain, cores });
    this.events.emit('reset', { seed: this.cfg.seed });
    this.events.emit('econ', this.econ);
    return p.gain;
  }

  // ---------------------------------------------------------------- internals

  private setCell(x: number, y: number, s: number, from?: number): void {
    x = this.wx(x);
    this.board.set(x, y, s);
    // An opened cell sees around itself, so a cascade never runs into fog.
    if (isRevealed(s) && this.cfg.fog.enabled) this.fog.opened(x, y);
    if (s !== CellState.Unknown && this.questions.size) this.questions.delete(cellKey(x, y));
    this.changed.push(from === undefined ? { x, y, state: s } : { x, y, state: s, from });
  }

  /** Reveal a safe cell and flood-fill through zeros. Returns cells revealed. */
  private cascade(sx: number, sy: number): number {
    sx = this.wx(sx);
    const origin = cellKey(sx, sy);
    const stack: number[] = [origin];
    const { cascadeRadius, cascadeCap } = this.cfg.play;
    let count = 0;
    while (stack.length) {
      const k = stack.pop()!;
      const x = keyX(k);
      const y = keyY(k);
      if (this.board.get(x, y) !== CellState.Unknown) continue;
      if (count > 0 && (count >= cascadeCap || chebyshev(x, y, sx, sy, this.world.wrap) > cascadeRadius || this.fogged(x, y) || this.locked(x, y))) continue;
      let n = 0;
      forEachNeighbor(x, y, (nx, ny) => {
        const s = this.board.get(nx, ny);
        if (isKnownMine(s)) n++;
        else if (!isRevealed(s)) n += this.world.truth(nx, ny);
      }, this.world.wrap);
      this.setCell(x, y, revealedState(n), origin);
      count++;
      if (n === 0) {
        forEachNeighbor(x, y, (nx, ny) => {
          if (this.board.get(nx, ny) === CellState.Unknown) stack.push(cellKey(nx, ny));
        }, this.world.wrap);
      }
    }
    return count;
  }

  /**
   * Settlement detection (§9.2), the turn, then event flush. Re-entrant safe.
   *
   * A flag is settle-able once every revealed number next to it is sealed
   * (has no Unknown neighbour left): its constraints can never change again.
   * Settle-able flags linked through shared sealed numbers form one claim
   * batch and are judged together.
   *
   * Only an opening settles (`settle`; user decision 2026-09-21): a flag
   * action just remembers its cells, and the next opening anywhere settles
   * whatever became settle-able around them, so placing a flag never turns
   * flags into bases on the spot.
   */
  private afterAction(settle = true): void {
    if (this.inAction > 0) return;
    if (settle) {
      const done = new Set<number>();
      const settleAround = (cx: number, cy: number) => {
        const candidates: number[] = [];
        const consider = (x: number, y: number) => {
          if (!this.isSealedNumber(x, y)) return;
          forEachNeighbor(x, y, (fx, fy) => {
            const fk = cellKey(fx, fy);
            if (!done.has(fk) && this.board.get(fx, fy) === CellState.Flag && this.isSettleable(fx, fy)) candidates.push(fk);
          }, this.world.wrap);
        };
        consider(cx, cy);
        forEachNeighbor(cx, cy, consider, this.world.wrap);
        for (const fk of candidates) {
          if (done.has(fk)) continue;
          const batch = this.collectBatch(fk, done);
          if (batch.length) this.settle(batch);
        }
      };
      const deferred = [...this.deferred];
      this.deferred.clear();
      for (const k of deferred) settleAround(keyX(k), keyY(k));
      // settle() appends to `changed`, so the length is read every round.
      for (let i = 0; i < this.changed.length; i++) settleAround(this.changed[i].x, this.changed[i].y);
    } else {
      // Lifting a flag cannot make anything settle-able, so only placed flags are kept.
      for (const c of this.changed) {
        if (c.state === CellState.Flag) this.deferred.add(cellKey(c.x, c.y));
        else this.deferred.delete(cellKey(c.x, c.y));
      }
    }
    // A cell that stops being closed (opened, owned, lost, exploded) may settle
    // bases (complexes), open a shorter path or a way out for an isolated
    // complex; the rebuild waits for the next read of `bases`. Placing or
    // lifting a flag cannot: the network treats a flag exactly like Unknown.
    if (!this.basesDirty && this.econ.owned.size && this.changed.some((c) => c.state !== CellState.Unknown && c.state !== CellState.Flag)) this.basesDirty = true;
    // One player action that changes tiles (an opening, a chord that opens
    // something, placing a flag) is one turn. The point multiplier is read
    // from the network as it stood before the action (no forced rebuild: that
    // costs a full path search per action): new bases count from the next
    // rebuild. Shipments run on their own clocks (`Bases.tick`).
    if (this.turnPending) {
      this.turnPending = false;
      this.events.emit('econ', this.econ);
    }
    // Fog first, so the renderer lifts it before the opened cells fade in.
    this.flushFog();
    if (this.changed.length) {
      const list = this.changed;
      this.changed = [];
      if (this.drones.drones.length) this.drones.notify(list, this.droneRadius());
      this.events.emit('cells', list);
    }
  }

  /** Revealed number with no Unknown neighbour (flags count as resolved). */
  private isSealedNumber(x: number, y: number): boolean {
    const s = this.board.get(x, y);
    if (!isRevealed(s) || numberOf(s) === 0) return false;
    let sealed = true;
    forEachNeighbor(x, y, (nx, ny) => {
      if (this.board.get(nx, ny) === CellState.Unknown) sealed = false;
    }, this.world.wrap);
    return sealed;
  }

  /** Flag whose every numbered neighbour is sealed (and has at least one). */
  private isSettleable(x: number, y: number): boolean {
    let numbers = 0;
    let ok = true;
    forEachNeighbor(x, y, (nx, ny) => {
      const s = this.board.get(nx, ny);
      if (!isRevealed(s) || numberOf(s) === 0) return;
      numbers++;
      if (!this.isSealedNumber(nx, ny)) ok = false;
    }, this.world.wrap);
    return ok && numbers > 0;
  }

  /** Settle-able flags connected through shared sealed numbers. */
  private collectBatch(start: number, done: Set<number>): number[] {
    const batch: number[] = [];
    const queue = [start];
    done.add(start);
    const seenNumbers = new Set<number>();
    while (queue.length) {
      const fk = queue.pop()!;
      batch.push(fk);
      forEachNeighbor(keyX(fk), keyY(fk), (nx, ny) => {
        const nk = cellKey(nx, ny);
        if (seenNumbers.has(nk) || !this.isSealedNumber(nx, ny)) return;
        seenNumbers.add(nk);
        forEachNeighbor(nx, ny, (fx, fy) => {
          const k2 = cellKey(fx, fy);
          if (done.has(k2) || this.board.get(fx, fy) !== CellState.Flag || !this.isSettleable(fx, fy)) return;
          done.add(k2);
          queue.push(k2);
        }, this.world.wrap);
      }, this.world.wrap);
    }
    return batch;
  }

  /**
   * Judge a claim batch. Truth is the world's consistent assignment.
   * A batch is paid only when every flag in it is right; otherwise its real
   * mines are forfeited (Lost) and the wrong flags open (deviation from spec
   * §9.2, see CLAUDE.md "Settlement batches").
   */
  private settle(batch: number[]): void {
    const correct: Array<{ key: number; density: number }> = [];
    const wrong: number[] = [];
    let ax = 0;
    let ay = 0;
    // x is summed relative to the first flag, so a batch across the seam averages to its real centre.
    const x0 = keyX(batch[0]);
    for (const k of batch) {
      const x = keyX(k);
      const y = keyY(k);
      ax += deltaX(x, x0, this.world.wrap);
      ay += y;
      // Truth is stable without an override; the resulting board state encodes it.
      const t = this.world.truth(x, y);
      if (t === 1) correct.push({ key: k, density: this.world.density(x, y) });
      else wrong.push(k);
    }
    const tainted = wrong.length > 0;
    for (const m of correct) this.setCell(keyX(m.key), keyY(m.key), tainted ? CellState.Lost : CellState.Owned);
    for (const k of wrong) {
      const x = keyX(k);
      const y = keyY(k);
      this.setCell(x, y, CellState.Unknown);
      this.econ.lifetime.cellsRevealed += this.cascade(x, y);
    }
    const r = this.econ.onSettlement(tainted ? [] : correct, wrong.length);
    if (!tainted && correct.length) this.basesDirty = true;
    this.stats.closures++;
    if (tainted) this.stats.forfeited = (this.stats.forfeited ?? 0) + correct.length;
    const n = batch.length;
    const ev: SettlementEvent = {
      x: this.wx(x0 + Math.round(ax / n)),
      y: Math.round(ay / n),
      correct: correct.length,
      wrong: wrong.length,
      payout: r.payout,
      loss: r.loss,
      cells: batch,
    };
    this.pushLog('settlement', ev.x, ev.y, { correct: ev.correct, wrong: ev.wrong, payout: ev.payout, loss: ev.loss });
    this.events.emit('settlement', ev);
    this.events.emit('econ', this.econ);
  }

  /** Rebuild the base network, the base multiplier and the pool cap. */
  private syncBases(): void {
    this.basesDirty = false;
    this._bases.recompute(this.mainBaseKey());
    this.events.emit('bases', this._bases);
    for (const f of this._bases.formed) this.events.emit('grand', f);
    this.updateFog();
  }

  /** Register new disc sources (the main base, new bases); they see at once. */
  private updateFog(): void {
    if (!this.cfg.fog.enabled || !this.world.started) return;
    this.fog.update(this.mainBaseKey(), this.econ.owned.keys());
    if (this.inAction === 0) this.flushFog();
  }

  /** Emit the cells the fog lifted from since the last flush. */
  private flushFog(): void {
    const lifted = this.fog.take();
    if (lifted.length) this.events.emit('fog', lifted);
  }

  private pushLog(kind: LogKind, x: number | undefined, y: number | undefined, data: Record<string, unknown>): void {
    const e: LogEntry = { id: this.nextLogId++, t: this.time, kind, x, y, data };
    this.log.push(e);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.events.emit('log', e);
  }

  // ------------------------------------------------------------------ save

  toSave(): SaveData {
    const bases = this.bases.snapshot();
    return {
      version: 1,
      savedAt: Date.now(),
      cfg: this.cfg,
      time: this.time,
      world: {
        overrides: [...this.world.overrides.entries()],
        chunkPressure: [...this.world.chunkPressure.entries()],
        densityDebt: this.world.densityDebt,
        interventions: this.world.interventions,
        start: { x: this.world.startX, y: this.world.startY, started: this.world.started },
      },
      board: [...this.board.chunks.entries()].map(([k, c]) => [k, new Uint8Array(c)] as [number, Uint8Array]),
      scanners: this.scanners.map((s) => ({ ...s })),
      nextScannerId: this.nextScannerId,
      econ: this.econ.snapshot(),
      upgrades: this.upgrades.snapshot(),
      bases,
      questions: [...this.questions],
      deferred: [...this.deferred],
      drones: this.drones.snapshot(),
      droneLoadout: structuredClone(this.droneLoadout),
      log: this.log.slice(-LOG_LIMIT),
      nextLogId: this.nextLogId,
      rescuesLeft: this.rescues.left,
      stats: { ...this.stats },
    };
  }

  static fromSave(data: SaveData): Game {
    // Base, blast and fog tuning always come from the current defaults (older saves carry retired values).
    // Saves from before terrain carry no `terrainEnabled`: keep them wall-free (their rivers stay mine bands).
    // Saves from before start-relative maps keep their absolute noise. Tier tuning comes from the current defaults.
    const world = { ...data.cfg.world, terrainEnabled: data.cfg.world.terrainEnabled ?? false, startRelative: data.cfg.world.startRelative ?? false };
    const g = new Game(
      makeConfig({ ...data.cfg, world, bases: undefined, blast: undefined, fog: { enabled: data.cfg.fog?.enabled ?? true }, tiers: { enabled: data.cfg.tiers?.enabled ?? true } }),
    );
    g.time = data.time;
    for (const [k, v] of data.world.overrides) g.world.overrides.set(k, v);
    for (const [k, v] of data.world.chunkPressure) g.world.chunkPressure.set(k, v);
    g.world.densityDebt = data.world.densityDebt;
    g.world.interventions = data.world.interventions;
    for (const [k, c] of data.board) g.board.chunks.set(k, new Uint8Array(c));
    g.board.recount();
    const st = data.world.start;
    g.world.startX = st?.x ?? 0;
    g.world.startY = st?.y ?? 0;
    g.world.started = st?.started ?? (g.board.revealedCount > 0 || g.world.overrides.size > 0);
    g.scanners.push(...data.scanners.map((s) => ({ ...s })));
    g.nextScannerId = data.nextScannerId;
    g.econ.restore(data.econ);
    g.upgrades.restore(data.upgrades);
    g.applyUpgrades();
    g._bases.restore(data.bases);
    for (const k of data.questions ?? []) if (g.board.get(keyX(k), keyY(k)) === CellState.Unknown) g.questions.add(k);
    for (const k of data.deferred ?? []) g.deferred.add(k);
    // Fog is not saved: every opened cell sees around itself again, bases through syncBases.
    if (g.cfg.fog.enabled) g.board.forEachCell((x, y, s) => void (isRevealed(s) && g.fog.opened(x, y)));
    g.syncBases();
    g.fog.take();
    // Drones exist only with equipment; older saves' upgrade-bought drones are dropped.
    if (data.droneLoadout?.count) {
      g.droneLoadout = structuredClone(data.droneLoadout);
      g.drones.restore(data.drones);
    }
    g.log = data.log.slice();
    g.nextLogId = data.nextLogId;
    g.rescues.left = data.rescuesLeft;
    g.stats = { ...g.stats, ...data.stats };
    return g;
  }
}
