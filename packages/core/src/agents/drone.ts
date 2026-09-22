import { CellState } from '../board';
import type { DroneConfig } from '../config';
import { hash01 } from '../hash';
import { cellKey, chebyshev, inDisc, keyX, keyY } from '../key';
import { Verdict, type SolveResult } from '../solver';

/**
 * Drones (spec §8.2, §10, INV-3).
 *
 * A drone is throughput, never judgement: it applies the purchased solver
 * tiers to the *belief* constraints around it, reveals SAFE verdicts and
 * flags MINE verdicts, and stops the moment nothing is determined. It never
 * guesses. Because it believes the player's flags, a wrong flag propagates
 * through its deductions until a reveal explodes (§10).
 *
 * A drone lives on an Owned mine (its anchor) and works inside a tile-rounded
 * disc around it. Every action is physical:
 *   extend - a line grows tile by tile to the target cell, from where the
 *            previous action left it (`tip`) or from the anchor;
 *   work   - once the line touches the target, `acc` fills 0 -> 1 and the
 *            action executes (verdict re-checked first);
 *   travel - when the anchor's disc has nothing determined, the line goes to
 *            another Owned mine whose disc does, and the drone rides it there.
 * Hops are leashed: the new anchor must lie within the radius of `home`, the
 * mine the drone was placed on, so a drone never roams further than 2r.
 * When neither a cell nor a hop is available the drone stalls.
 */
export type DroneStatus = 'idle' | 'working' | 'stalled' | 'halted';
export type DronePhase = 'extend' | 'work' | 'travel';

export interface StallComponent {
  size: number;
  undetermined: number;
  /** Lowest P(mine) among undetermined cells, when probabilities are available. */
  minProb: number | null;
  /** Expected number of mines still hidden in the component, when available. */
  estValue: number | null;
  cells: number[];
}

export interface DroneState {
  id: number;
  /** Anchor cell (an Owned mine). Meaningless while `placed` is false. */
  x: number;
  y: number;
  /** Mine the drone was placed on; hops stay within the radius of it. */
  hx: number;
  hy: number;
  placed: boolean;
  /** 'idle' = no Owned mine to stand on yet. */
  status: DroneStatus;
  safeMode: boolean;
  /** Paused while the player drags it. Not saved. */
  held: boolean;
  phase: DronePhase | null;
  /** Cell the pending action applies to (key), or null when none is chosen yet. */
  target: number | null;
  targetKind: 'reveal' | 'flag' | 'move' | null;
  /**
   * Cell the line currently ends on after the last action (key), or null for
   * the anchor. The next job is searched from here and its line grows from
   * here, instead of retracting to the anchor first. Not saved.
   */
  tip: number | null;
  /** King-move path from the line's start (tip or anchor) to the target, both ends included. */
  path: number[] | null;
  /** Tiles of `path` covered by the line (0..path.length-1). */
  line: number;
  /** Tiles of `path` the drone has ridden while travelling. */
  ride: number;
  /** Progress of the pending action once the line has arrived, 0..1. */
  acc: number;
  stall: StallComponent[] | null;
  actions: number;
  explosions: number;
  /** Last explosion basis: nearby flags the deduction relied on (keys). */
  lastBasis: number[] | null;
}

/** The slice of Game a drone needs. Kept as an interface to avoid a cycle. */
export interface DroneHost {
  cellState(x: number, y: number): number;
  analyze(x0: number, y0: number, x1: number, y1: number, mode: 'belief' | 'public'): SolveResult;
  reveal(x: number, y: number, actor: { kind: 'drone'; id: number }, basis?: number[]): { hit: boolean };
  setFlag(x: number, y: number, on: boolean, actor: { kind: 'drone'; id: number }): void;
  hasProbabilities(): boolean;
  droneRadius(): number;
  droneActionsPerSec(): number;
  droneMoveSpeed(): number;
  ownedKeys(): Iterable<number>;
  seed(): number;
}

/** King-move path from a to b, both included: diagonal steps first, then straight (at most one bend). */
export function linePath(ax: number, ay: number, bx: number, by: number): number[] {
  const sx = Math.sign(bx - ax);
  const sy = Math.sign(by - ay);
  const out: number[] = [cellKey(ax, ay)];
  let x = ax;
  let y = ay;
  while (x !== bx || y !== by) {
    if (x !== bx) x += sx;
    if (y !== by) y += sy;
    out.push(cellKey(x, y));
  }
  return out;
}

/** Seconds between automatic placement attempts of an idle drone. */
const PLACE_RETRY_SEC = 1;
/** Neighbourhood (Chebyshev) used to score how much Unknown surrounds an Owned mine. */
const PLACE_SCORE_R = 3;
/** Automatic placement picks randomly among this many best-scoring Owned mines. */
const PLACE_TOP = 8;

export class DroneManager {
  drones: DroneState[] = [];
  private nextId = 1;
  private placeTimer = 0;
  private placeCount = 0;

  constructor(private cfg: DroneConfig) {}

  ensureCount(n: number): void {
    while (this.drones.length < n) {
      this.drones.push({
        id: this.nextId++,
        x: 0,
        y: 0,
        hx: 0,
        hy: 0,
        placed: false,
        status: 'idle',
        safeMode: false,
        held: false,
        phase: null,
        target: null,
        targetKind: null,
        tip: null,
        path: null,
        line: 0,
        ride: 0,
        acc: 0,
        stall: null,
        actions: 0,
        explosions: 0,
        lastBasis: null,
      });
    }
    this.placeTimer = PLACE_RETRY_SEC;
  }

  get(id: number): DroneState | undefined {
    return this.drones.find((d) => d.id === id);
  }

  /** Another drone already stands on (x, y). */
  occupied(x: number, y: number, except?: number): boolean {
    return this.drones.some((d) => d.id !== except && d.placed && d.x === x && d.y === y);
  }

  /** Move a drone onto an Owned mine. The caller checks that the cell is Owned. */
  place(id: number, x: number, y: number): boolean {
    const d = this.get(id);
    if (!d || this.occupied(x, y, id)) return false;
    d.x = x;
    d.y = y;
    d.hx = x;
    d.hy = y;
    d.placed = true;
    d.held = false;
    if (d.status !== 'halted') d.status = 'working';
    d.stall = null;
    this.clearTarget(d);
    return true;
  }

  /** Pause (drag in progress) or release a drone. Releasing re-plans from scratch. */
  hold(id: number, on: boolean): void {
    const d = this.get(id);
    if (!d) return;
    d.held = on;
    this.clearTarget(d);
  }

  resume(id: number): void {
    const d = this.get(id);
    if (!d) return;
    d.status = d.placed ? 'working' : 'idle';
    d.stall = null;
  }

  /** Drop the pending action; the line restarts from the anchor unless `tip` is given. */
  private clearTarget(d: DroneState, tip: number | null = null): void {
    d.phase = null;
    d.target = null;
    d.targetKind = null;
    d.tip = tip;
    d.path = null;
    d.line = 0;
    d.ride = 0;
    d.acc = 0;
  }

  /** Wake stalled drones whose reach (anchor disc plus hop range) was touched. */
  notify(changes: Array<{ x: number; y: number; state: number }>, radius: number): void {
    for (const c of changes) if (c.state === CellState.Owned) this.placeTimer = PLACE_RETRY_SEC;
    for (const d of this.drones) {
      if (d.status !== 'stalled') continue;
      for (const c of changes) {
        if (chebyshev(c.x, c.y, d.x, d.y) <= 2 * radius + 1) {
          d.status = 'working';
          d.stall = null;
          break;
        }
      }
    }
  }

  tick(dt: number, host: DroneHost): void {
    this.placeTimer += dt;
    const aps = host.droneActionsPerSec();
    const mps = host.droneMoveSpeed();
    for (const d of this.drones) {
      if (d.held || d.status === 'halted') continue;
      if (d.placed && host.cellState(d.x, d.y) !== CellState.Owned) {
        d.placed = false;
        d.status = 'idle';
        this.clearTarget(d);
      }
      if (!d.placed) {
        if (this.placeTimer >= PLACE_RETRY_SEC) this.autoPlace(d, host);
        if (!d.placed) continue;
      }
      if (d.status !== 'working') continue;
      let left = dt;
      let guard = 0;
      while (left > 0 && d.status === 'working' && guard++ < 50) {
        if (d.phase === null && !this.choose(d, host)) break;
        left = this.advance(d, host, left, aps, mps);
      }
    }
    if (this.placeTimer >= PLACE_RETRY_SEC) this.placeTimer = 0;
  }

  /** Spend up to `dt` seconds on the current phase; returns the unspent time. */
  private advance(d: DroneState, host: DroneHost, dt: number, aps: number, mps: number): number {
    const path = d.path!;
    const len = path.length - 1;
    const k = d.target!;
    if (d.phase === 'extend') {
      // The target may have been resolved by someone else while the line grew.
      const s = host.cellState(keyX(k), keyY(k));
      if (d.targetKind === 'move' ? s !== CellState.Owned || this.occupied(keyX(k), keyY(k), d.id) : s !== CellState.Unknown) {
        this.clearTarget(d, d.targetKind === 'move' ? null : d.tip);
        return dt;
      }
      const need = (len - d.line) / mps;
      if (dt < need) {
        d.line += dt * mps;
        return 0;
      }
      d.line = len;
      d.phase = d.targetKind === 'move' ? 'travel' : 'work';
      return dt - need;
    }
    if (d.phase === 'travel') {
      const need = (len - d.ride) / mps;
      if (dt < need) {
        d.ride += dt * mps;
        return 0;
      }
      d.x = keyX(k);
      d.y = keyY(k);
      this.clearTarget(d);
      return dt - need;
    }
    // work
    const need = (1 - d.acc) / aps;
    if (dt < need) {
      d.acc += dt * aps;
      return 0;
    }
    this.execute(d, host);
    return dt - need;
  }

  /** One immediate deduction step (choose + execute), skipping the line and gauge. */
  act(d: DroneState, host: DroneHost): boolean {
    if (d.phase === null && !this.choose(d, host)) return false;
    if (d.targetKind === 'move') {
      d.x = keyX(d.target!);
      d.y = keyY(d.target!);
      this.clearTarget(d);
      return true;
    }
    this.execute(d, host);
    return true;
  }

  /** Carry out the pending action if its verdict still holds; otherwise re-plan without acting. */
  private execute(d: DroneState, host: DroneHost): void {
    const k = d.target;
    const kind = d.targetKind;
    // The line stays where it arrived; the next search starts from there.
    this.clearTarget(d, k);
    if (k === null) return;
    const x = keyX(k);
    const y = keyY(k);
    if (host.cellState(x, y) !== CellState.Unknown) return;
    if (!inDisc(x - d.x, y - d.y, host.droneRadius())) return;
    const v = this.analyzeReach(d, host).verdicts.get(k);
    if (kind === 'reveal' && v === Verdict.Safe) {
      const basis = this.nearbyFlags(host, x, y);
      d.actions++;
      const out = host.reveal(x, y, { kind: 'drone', id: d.id }, basis);
      if (out.hit) {
        d.tip = null;
        d.status = 'halted';
        d.explosions++;
        d.lastBasis = basis;
      }
    } else if (kind === 'flag' && v === Verdict.Mine) {
      d.actions++;
      host.setFlag(x, y, true, { kind: 'drone', id: d.id });
    }
  }

  /** Solve everything a hop could reach: the anchor's disc plus the discs of Owned mines inside it. */
  private analyzeReach(d: DroneState, host: DroneHost): SolveResult {
    const r = 2 * host.droneRadius();
    return host.analyze(d.x - r, d.y - r, d.x + r, d.y + r, d.safeMode ? 'public' : 'belief');
  }

  /**
   * Pick the next job: the determined cell in the anchor's disc nearest to
   * the line's tip (safe cells first), else a hop to the Owned mine nearest to
   * a determined cell it can reach. Stalls and returns false when there is neither.
   */
  private choose(d: DroneState, host: DroneHost): boolean {
    const r = host.droneRadius();
    const res = this.analyzeReach(d, host);
    const ox = d.tip === null ? d.x : keyX(d.tip);
    const oy = d.tip === null ? d.y : keyY(d.tip);

    let bestSafe: number | null = null;
    let bestSafeD = Infinity;
    let bestMine: number | null = null;
    let bestMineD = Infinity;
    const far: number[] = [];
    for (const [k, v] of res.verdicts) {
      if (v !== Verdict.Safe && v !== Verdict.Mine) continue;
      const x = keyX(k);
      const y = keyY(k);
      if (host.cellState(x, y) !== CellState.Unknown) continue;
      const dx = x - d.x;
      const dy = y - d.y;
      if (!inDisc(dx, dy, r)) {
        far.push(k);
        continue;
      }
      const dist = (x - ox) ** 2 + (y - oy) ** 2;
      if (v === Verdict.Safe && dist < bestSafeD) {
        bestSafeD = dist;
        bestSafe = k;
      } else if (v === Verdict.Mine && dist < bestMineD) {
        bestMineD = dist;
        bestMine = k;
      }
    }
    const job = bestSafe ?? bestMine;
    if (job !== null) {
      this.setTarget(d, job, job === bestSafe ? 'reveal' : 'flag');
      return true;
    }

    // Hop: the free Owned mine in reach (and on the leash) that brings the nearest determined cell into its disc.
    let hop: number | null = null;
    let hopScore = Infinity;
    if (far.length) {
      for (let y = d.y - r; y <= d.y + r; y++) {
        for (let x = d.x - r; x <= d.x + r; x++) {
          if ((x === d.x && y === d.y) || !inDisc(x - d.x, y - d.y, r) || !inDisc(x - d.hx, y - d.hy, r)) continue;
          if (host.cellState(x, y) !== CellState.Owned || this.occupied(x, y, d.id)) continue;
          for (const k of far) {
            const dx = keyX(k) - x;
            const dy = keyY(k) - y;
            if (!inDisc(dx, dy, r)) continue;
            const score = Math.hypot(x - d.x, y - d.y) + Math.hypot(dx, dy);
            if (score < hopScore) {
              hopScore = score;
              hop = cellKey(x, y);
            }
          }
        }
      }
    }
    // A hop is ridden from the anchor, so the line starts over from there.
    d.tip = null;
    if (hop !== null) {
      this.setTarget(d, hop, 'move');
      return true;
    }

    // Nothing determined in reach: stall and describe what blocks us (triage input).
    d.status = 'stalled';
    d.stall = [];
    for (const c of res.components) {
      if (c.undetermined === 0) continue;
      const inRange = c.cells.filter((k) => inDisc(keyX(k) - d.x, keyY(k) - d.y, r));
      if (inRange.length === 0) continue;
      let minProb: number | null = null;
      let est: number | null = null;
      if (host.hasProbabilities()) {
        for (const k of c.cells) {
          const p = res.probabilities.get(k);
          if (p === undefined) continue;
          if (minProb === null || p < minProb) minProb = p;
          est = (est ?? 0) + p;
        }
      }
      d.stall.push({ size: c.size, undetermined: c.undetermined, minProb, estValue: est, cells: c.cells });
    }
    return false;
  }

  private setTarget(d: DroneState, k: number, kind: 'reveal' | 'flag' | 'move'): void {
    d.target = k;
    d.targetKind = kind;
    const sx = d.tip === null ? d.x : keyX(d.tip);
    const sy = d.tip === null ? d.y : keyY(d.tip);
    d.path = linePath(sx, sy, keyX(k), keyY(k));
    d.phase = 'extend';
    d.line = 0;
    d.ride = 0;
    d.acc = 0;
  }

  /**
   * Put an unplaced drone on a free Owned mine with a lot of Unknown around it,
   * chosen at random (deterministically from the seed) among the best few.
   */
  private autoPlace(d: DroneState, host: DroneHost): void {
    const scored: Array<{ k: number; n: number }> = [];
    for (const k of host.ownedKeys()) {
      const x = keyX(k);
      const y = keyY(k);
      if (host.cellState(x, y) !== CellState.Owned || this.occupied(x, y, d.id)) continue;
      let n = 0;
      for (let dy = -PLACE_SCORE_R; dy <= PLACE_SCORE_R; dy++) {
        for (let dx = -PLACE_SCORE_R; dx <= PLACE_SCORE_R; dx++) {
          if (host.cellState(x + dx, y + dy) === CellState.Unknown) n++;
        }
      }
      if (n > 0) scored.push({ k, n });
    }
    if (!scored.length) return;
    scored.sort((a, b) => b.n - a.n || a.k - b.k);
    const top = scored.slice(0, PLACE_TOP);
    const pick = top[Math.floor(hash01(host.seed(), d.id, this.placeCount++) * top.length)];
    this.place(d.id, keyX(pick.k), keyY(pick.k));
  }

  /** Flags within distance 2 of a cell: the claims a local deduction can depend on. */
  private nearbyFlags(host: DroneHost, x: number, y: number): number[] {
    const out: number[] = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (host.cellState(x + dx, y + dy) === CellState.Flag) out.push(cellKey(x + dx, y + dy));
      }
    }
    return out;
  }

  snapshot(): DroneState[] {
    return this.drones.map((d) => ({ ...d, stall: null, path: d.path ? d.path.slice() : null }));
  }

  /** Pending actions are not saved; older saves (follow-mode drones) get re-placed on an Owned mine. */
  restore(list: Array<Partial<DroneState> & { id: number; x: number; y: number }>): void {
    this.drones = list.map((d) => ({
      id: d.id,
      x: d.x,
      y: d.y,
      hx: d.hx ?? d.x,
      hy: d.hy ?? d.y,
      placed: d.placed ?? false,
      status: d.status === 'halted' ? 'halted' : d.placed ? 'working' : 'idle',
      safeMode: d.safeMode ?? false,
      held: false,
      phase: null,
      target: null,
      targetKind: null,
      tip: null,
      path: null,
      line: 0,
      ride: 0,
      acc: 0,
      stall: null,
      actions: d.actions ?? 0,
      explosions: d.explosions ?? 0,
      lastBasis: d.lastBasis ?? null,
    }));
    this.nextId = Math.max(0, ...this.drones.map((d) => d.id)) + 1;
    this.placeTimer = PLACE_RETRY_SEC;
  }

  reset(): void {
    this.drones = [];
    this.nextId = 1;
  }
}
