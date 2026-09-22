import { CellState, isRevealed, numberOf } from '../board';
import type { BaseConfig } from '../config';
import { hash01 } from '../hash';
import { cellKey, deltaX, keyX, keyY, wrapX } from '../key';
import type { Econ } from './income';

/**
 * Bases (user decisions 2026-09-21). Every Owned mine is a base; the start
 * cell (the first cell opened) is the main base. Bases produce nothing by
 * themselves (user decision 2026-09-22): every active base raises the point
 * multiplier (`econ.baseMult` = 1 + multPerBase x the active bases, grand
 * complex members counting their bonus), and the main-base level raises the
 * unbanked pool's capacity (`econ.capacity`).
 *
 * Disabled: a base knocked out by a mine explosion (econ/blast.ts) does not
 * count and is not a base for anything below (complexes, network) until it
 * is repaired. The main base is never disabled.
 *
 * Complexes: a base is *settled* when its 8 neighbours hold no Unknown or
 * flag and every number among them has faded out (no Unknown or flag next to
 * it either). Settled bases within 2 tiles of each other (Chebyshev, so
 * diagonals and one-tile gaps count; chained) form one complex, which acts
 * as a single node; an unsettled base is a complex of its own. Goods move
 * between members instantly; the complex holding the main base is the main
 * complex and pays at once. A complex's hub is its member closest to the
 * main base (Manhattan, then the smaller key). A complex of at least
 * `grandMinBases` bases is a grand complex: each member counts
 * x(1 + `grandBonusPerBase` x members) towards the base multiplier.
 *
 * Network: a tree of complexes rooted at the main complex, with no range
 * limit. Edges are tile paths (4-neighbourhood) that never cross an Unknown
 * or flagged cell; every other cell stays passable for good (opened cells,
 * terrain walls, bases, lost and exploded mines), so a path never breaks. A complex's
 * parent is the complex it reaches over the shortest such path among those
 * whose hub is strictly closer (Manhattan) to the main base; ties go to the
 * parent whose hub is closer to the main base, then the smaller entry key.
 * The path runs from the child's exit member to the parent's entry member
 * and prefers going straight (few bends).
 *
 * Isolation: a complex with no chain of parents to the main complex (walled
 * in by Unknown cells) is isolated. It does not count towards the
 * multiplier and is not linked. Opening a way out lifts isolation.
 *
 * Shipments are only a picture of the link: every linked complex keeps
 * sending one down its edge every `shipIntervalSec` on its own clock (the
 * phase comes from its hub, so complexes do not tick together), travelling
 * edge by edge at `speed()` tiles per second (one arriving at an intermediate
 * complex continues at once, joining its outgoing shipment if it has barely
 * left). They carry nothing.
 *
 * Only the main base is levelled. Its level raises the pool's capacity.
 */
export interface BaseInfo {
  key: number;
  x: number;
  y: number;
  main: boolean;
  /** Main-base level (the network level). */
  level: number;
  /** Entry base of the next hop towards the main base (null for the main complex and isolated ones). */
  parent: number | null;
  /** Complexes whose next hop is this base's complex. */
  children: number;
  /** Route length to the main base in tiles. */
  route: number;
  /** Edges on the route to the main base. */
  hops: number;
  /** What this base adds to the base multiplier (0 for the main base, isolated and disabled bases). */
  multShare: number;
  /** No path to the main base avoiding Unknown cells: does not count, no link. */
  isolated: boolean;
  /** Knocked out by an explosion: does not count, no link, until repaired. */
  disabled: boolean;
  /** Bases in this base's complex (1 when alone). */
  complexSize: number;
  /** Weight multiplier of a grand complex (1 otherwise). */
  complexBonus: number;
}

/** Settled bases within 2 tiles of each other (chained); one network node. */
export interface Complex {
  /** Member closest to the main base; the main base for the main complex. */
  hub: number;
  members: number[];
  isolated: boolean;
  /** At least `grandMinBases` members. */
  grand: boolean;
  /** Weight multiplier from being a grand complex (1 otherwise). */
  bonus: number;
  /** Hub of the next complex towards the main base; null for the main complex and isolated ones. */
  parent: number | null;
  /** Member the outgoing edge leaves from. */
  exit: number;
  /** Member of the parent complex the outgoing edge arrives at. */
  entry: number;
  /** Cells of the outgoing edge from `exit` to `entry` (4-neighbour steps); [hub] when there is none. */
  path: number[];
  /** Weight of the members towards the base multiplier (0 when isolated). */
  weight: number;
}

/** A (cosmetic) shipment on the edge `path` (exit -> entry), `d` tiles from its start. */
export interface Shipment {
  path: number[];
  len: number;
  d: number;
}

/** A complex that has just become grand. */
export interface GrandFormed {
  hub: number;
  members: number[];
  /** Centre of the members' bounding box (tile units, cell centres at +0.5). */
  cx: number;
  cy: number;
  bonus: number;
}

export interface BasesSnapshot {
  mainLevel: number;
  /** Goods not yet delivered in saves from before per-turn production; credited on load. */
  inTransit?: number;
}

/** A shipment arriving at a complex joins its outgoing one if that is less than this many tiles along. */
const JOIN_TILES = 1;
/** Complex members may be this many tiles apart (Chebyshev). */
const COMPLEX_REACH = 2;

/** Manhattan distance between two cells; across the seam on a world wrapping every `w` columns. */
export function manhattan(a: number, b: number, w = 0): number {
  return Math.abs(deltaX(keyX(a), keyX(b), w)) + Math.abs(keyY(a) - keyY(b));
}

/**
 * Cell-centre point `s` tiles along a path of 4-neighbour steps (fractional
 * between cells). On a wrapping world (`w`) a step across the seam stays one
 * step: x may then leave [0, w) (it continues from the path's previous cell).
 */
export function pathAt(path: number[], s: number, w = 0): { x: number; y: number } {
  const n = path.length - 1;
  const t = Math.max(0, Math.min(n, s));
  const i = Math.min(Math.max(0, n - 1), Math.floor(t));
  const j = Math.min(n, i + 1);
  const f = t - i;
  return { x: keyX(path[i]) + deltaX(keyX(path[j]), keyX(path[i]), w) * f, y: keyY(path[i]) + (keyY(path[j]) - keyY(path[i])) * f };
}

export class Bases {
  mainLevel = 1;
  /** Key of the main base, or null before the first cell is opened. */
  main: number | null = null;
  /** Active bases weighted by their complex bonus (linked, not disabled, not the main base). */
  weight = 0;
  /** Hub -> complex. */
  readonly complexes = new Map<number, Complex>();
  /** Base key -> hub of its complex. */
  readonly complexOf = new Map<number, number>();
  /** Keys of the bases in isolated complexes. */
  readonly isolated = new Set<number>();
  /** Keys of Owned mines knocked out by an explosion. */
  readonly disabled = new Set<number>();
  /** Shipments on screen (cosmetic). */
  readonly shipments: Shipment[] = [];
  /** Complexes that became grand in the last `recompute` (never on the first one after construction or load). */
  formed: GrandFormed[] = [];
  /** Hub -> its latest outgoing shipment, which arrivals may join. */
  private lastOut = new Map<number, Shipment>();
  /** Hub -> seconds until its complex sends the next shipment. */
  private clock = new Map<number, number>();
  private routes = new Map<number, number>();
  /** Members of grand complexes after the last rebuild, to spot new ones. */
  private grandKeys = new Set<number>();
  private primed = false;

  constructor(
    public cfg: BaseConfig,
    private econ: Econ,
    /** Board state of a cell (`CellState`). */
    private state: (x: number, y: number) => number,
    /** Columns after which the world repeats (World.wrap); 0: no wrap. */
    private wrap = 0,
  ) {
    this.econ.capacity = this.capacity();
  }

  isBase(key: number): boolean {
    if (key === this.main) return true;
    const m = this.econ.owned.get(key);
    return m !== undefined && !m.disabled;
  }

  /** Unbanked pool capacity at a main-base level. */
  capacity(level = this.mainLevel): number {
    const c = this.econ.cfg;
    return c.storageBase * Math.pow(c.storageGrowth, level - 1);
  }

  /** Weight multiplier of a complex with `n` members (grand complexes only). */
  grandBonus(n: number): number {
    return n >= this.cfg.grandMinBases ? 1 + this.cfg.grandBonusPerBase * n : 1;
  }

  /** Shipment animation speed in tiles per second. */
  speed(): number {
    return this.cfg.transportTilesPerSec;
  }

  upgradeCost(): number {
    return Math.round(this.cfg.mainCostBase * Math.pow(this.cfg.mainCostGrowth, this.mainLevel - 1));
  }

  maxed(): boolean {
    return this.mainLevel >= this.cfg.maxLevel;
  }

  /** Can a network edge cross this cell? Everything but Unknown and flagged cells (terrain walls count as opened). */
  passable(x: number, y: number): boolean {
    const s = this.state(x, y);
    return s !== CellState.Unknown && s !== CellState.Flag;
  }

  /** No Unknown or flag among the 8 neighbours (walls count as resolved), and every number among them has faded out (none next to it either). */
  settled(key: number): boolean {
    const x = keyX(key), y = keyY(key);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const s = this.state(x + dx, y + dy);
        if (s === CellState.Unknown || s === CellState.Flag) return false;
        if (!isRevealed(s) || numberOf(s) === 0) continue;
        for (let ey = -1; ey <= 1; ey++) {
          for (let ex = -1; ex <= 1; ex++) {
            const t = this.state(x + dx + ex, y + dy + ey);
            if (t === CellState.Unknown || t === CellState.Flag) return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * Rebuild complexes, the tree and isolation; sets `econ.baseMult`,
   * `econ.capacity` and `formed`. Shipments in flight keep going.
   */
  recompute(main: number | null): void {
    this.main = main;
    this.complexes.clear();
    this.complexOf.clear();
    this.isolated.clear();
    this.disabled.clear();
    this.routes.clear();
    this.lastOut.clear();

    for (const [k, m] of this.econ.owned) {
      if (!m.disabled) continue;
      this.disabled.add(k);
    }
    this.buildComplexes();
    if (main !== null) this.link(main);
    for (const hub of this.clock.keys()) if (!this.complexes.has(hub)) this.clock.delete(hub);

    let total = 0;
    for (const c of this.complexes.values()) {
      c.weight = 0;
      if (c.isolated) continue;
      for (const k of c.members) if (k !== main) c.weight += c.bonus;
      total += c.weight;
    }
    this.weight = total;
    this.econ.baseMult = 1 + this.econ.cfg.multPerBase * total;
    this.econ.capacity = this.capacity();

    // A grand complex none of whose members was in one before has just formed.
    this.formed = [];
    const grand = new Set<number>();
    for (const c of this.complexes.values()) {
      if (!c.grand) continue;
      if (this.primed && !c.members.some((k) => this.grandKeys.has(k))) {
        // Unwrapped from the first member, so a complex across the seam gets its real centre.
        const x0 = keyX(c.members[0]);
        const xs = c.members.map((k) => x0 + deltaX(keyX(k), x0, this.wrap)), ys = c.members.map(keyY);
        const cx = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
        this.formed.push({ hub: c.hub, members: c.members, cx: this.wrap ? wrapX(cx, this.wrap) : cx, cy: (Math.min(...ys) + Math.max(...ys) + 1) / 2, bonus: c.bonus });
      }
      for (const k of c.members) grand.add(k);
    }
    this.grandKeys = grand;
    this.primed = true;
  }

  /** Group settled bases within `COMPLEX_REACH` tiles of each other (chained) into complexes. */
  private buildComplexes(): void {
    const main = this.main;
    const all: number[] = [];
    for (const [k, m] of this.econ.owned) if (!m.disabled && k !== main) all.push(k);
    if (main !== null) all.push(main);
    const settled = new Set<number>();
    for (const k of all) if (this.settled(k)) settled.add(k);
    const seen = new Set<number>();
    for (const start of all) {
      if (seen.has(start)) continue;
      seen.add(start);
      const members = [start];
      for (let i = 0; i < members.length && settled.has(start); i++) {
        const x = keyX(members[i]), y = keyY(members[i]);
        for (let dy = -COMPLEX_REACH; dy <= COMPLEX_REACH; dy++) {
          for (let dx = -COMPLEX_REACH; dx <= COMPLEX_REACH; dx++) {
            const n = cellKey(wrapX(x + dx, this.wrap), y + dy);
            if (settled.has(n) && !seen.has(n)) {
              seen.add(n);
              members.push(n);
            }
          }
        }
      }
      let hub = members[0];
      if (main !== null) {
        for (const k of members) {
          const dk = manhattan(k, main, this.wrap), dh = manhattan(hub, main, this.wrap);
          if (dk < dh || (dk === dh && k < hub)) hub = k;
        }
      } else {
        for (const k of members) if (k < hub) hub = k;
      }
      members.sort((a, b) => a - b);
      const bonus = this.grandBonus(members.length);
      this.complexes.set(hub, { hub, members, isolated: main === null, grand: bonus > 1, bonus, parent: null, exit: hub, entry: hub, path: [hub], weight: 0 });
      for (const k of members) this.complexOf.set(k, hub);
    }
    if (main === null) for (const k of this.complexOf.keys()) this.isolated.add(k);
  }

  /** Pick each complex's parent and path (see the class comment), then isolate the ones cut off from the main complex. */
  private link(main: number): void {
    for (const c of this.complexes.values()) if (c.hub !== main) this.findParent(c, main);
    // Linked when the chain of parents reaches the main complex.
    const linked = new Map<number, boolean>([[main, true]]);
    const isLinked = (hub: number): boolean => {
      const known = linked.get(hub);
      if (known !== undefined) return known;
      const p = this.complexes.get(hub)!.parent;
      const ok = p !== null && isLinked(p);
      linked.set(hub, ok);
      return ok;
    };
    for (const c of this.complexes.values()) {
      if (isLinked(c.hub)) continue;
      c.isolated = true;
      c.parent = null;
      c.exit = c.entry = c.hub;
      c.path = [c.hub];
      for (const k of c.members) this.isolated.add(k);
    }
  }

  /**
   * Breadth-first search over passable cells from every member of `c`,
   * layer by layer, until a layer holds a member of a complex whose hub is
   * strictly closer to the main base; the best of that layer (parent hub
   * closer to the main base, then the smaller key) is the entry. The path is
   * walked back from the entry, keeping its direction where it can.
   */
  private findParent(c: Complex, main: number): void {
    const dc = manhattan(c.hub, main, this.wrap);
    const dist = new Map<number, number>();
    let layer: number[] = [];
    for (const k of c.members) {
      dist.set(k, 0);
      layer.push(k);
    }
    let entry = -1;
    let bestH = Infinity;
    for (let d = 0; layer.length && entry < 0; d++) {
      const next: number[] = [];
      for (const k of layer) {
        const hub = this.complexOf.get(k);
        if (hub !== undefined && hub !== c.hub) {
          const h = manhattan(hub, main, this.wrap);
          if (h < dc && (h < bestH || (h === bestH && k < entry))) ((entry = k), (bestH = h));
        }
        const x = keyX(k), y = keyY(k);
        for (const [nx, ny] of [[wrapX(x + 1, this.wrap), y], [wrapX(x - 1, this.wrap), y], [x, y + 1], [x, y - 1]]) {
          const n = cellKey(nx, ny);
          if (dist.has(n) || !this.passable(nx, ny)) continue;
          dist.set(n, d + 1);
          next.push(n);
        }
      }
      layer = next;
    }
    if (entry < 0) return;
    const path = [entry];
    let k = entry;
    let dx = 0, dy = 0;
    for (let d = dist.get(entry)!; d > 0; d--) {
      const x = keyX(k), y = keyY(k);
      for (const [ex, ey] of [[dx, dy], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
        if (!ex && !ey) continue;
        const n = cellKey(wrapX(x + ex, this.wrap), y + ey);
        if (dist.get(n) !== d - 1) continue;
        k = n;
        dx = ex;
        dy = ey;
        break;
      }
      path.push(k);
    }
    path.reverse();
    c.exit = path[0];
    c.entry = entry;
    c.path = path;
    c.parent = this.complexOf.get(entry)!;
  }

  /** Route length in tiles from `key`'s complex to the main base. */
  route(key: number): number {
    const hub = this.complexOf.get(key);
    if (hub === undefined || hub === this.main) return 0;
    const hit = this.routes.get(hub);
    if (hit !== undefined) return hit;
    const c = this.complexes.get(hub)!;
    if (c.parent === null) return 0;
    const r = c.path.length - 1 + this.route(c.parent);
    this.routes.set(hub, r);
    return r;
  }

  /** Edge paths from `key`'s complex to the main complex. */
  routePaths(key: number): number[][] {
    const out: number[][] = [];
    for (let c = this.complexes.get(this.complexOf.get(key) ?? NaN); c && c.parent !== null; c = this.complexes.get(c.parent)) out.push(c.path);
    return out;
  }

  /** Move the shipments (animation only). */
  tick(dt: number): void {
    // Every linked complex sends one on its own clock.
    const every = this.cfg.shipIntervalSec;
    const main = this.main;
    for (const c of this.complexes.values()) {
      if (c.hub === main || c.weight <= 0 || c.parent === null) continue;
      let left = (this.clock.get(c.hub) ?? hash01(0x5f1a, keyX(c.hub), keyY(c.hub)) * every) - dt;
      if (left <= 0) {
        this.ship(c.hub);
        left = Math.max(left + every, 0);
      }
      this.clock.set(c.hub, left);
    }
    const step = this.speed() * dt;
    const list = this.shipments;
    let n = 0;
    const arrived: Shipment[] = [];
    for (const s of list) {
      s.d += step;
      if (s.d >= s.len) arrived.push(s);
      else list[n++] = s;
    }
    list.length = n;
    for (const s of arrived) {
      const from = this.complexOf.get(s.path[0]);
      if (from !== undefined && this.lastOut.get(from) === s) this.lastOut.delete(from);
      const to = this.complexOf.get(s.path[s.path.length - 1]);
      if (to !== undefined && to !== this.main) this.ship(to);
    }
  }

  /** Send a shipment from the complex `hub` towards its parent. */
  private ship(hub: number): void {
    const c = this.complexes.get(hub);
    if (!c || c.parent === null) return;
    const last = this.lastOut.get(hub);
    if (last && last.path === c.path && last.d < JOIN_TILES) return;
    const s: Shipment = { path: c.path, len: c.path.length - 1, d: 0 };
    this.shipments.push(s);
    this.lastOut.set(hub, s);
  }


  info(key: number): BaseInfo | null {
    const main = key === this.main;
    const m = this.econ.owned.get(key);
    if (!main && !m) return null;
    const disabled = !main && m!.disabled === true;
    const hub = disabled ? undefined : this.complexOf.get(key);
    const c = hub === undefined ? undefined : this.complexes.get(hub);
    let children = 0;
    if (c) for (const o of this.complexes.values()) if (o.parent === c.hub) children++;
    return {
      key,
      x: keyX(key),
      y: keyY(key),
      main,
      level: this.mainLevel,
      parent: c && c.parent !== null ? c.entry : null,
      children,
      route: disabled ? 0 : this.route(key),
      hops: disabled ? 0 : this.routePaths(key).length,
      multShare: main || disabled || !c || c.isolated ? 0 : this.econ.cfg.multPerBase * c.bonus,
      isolated: c?.isolated ?? false,
      disabled,
      complexSize: c?.members.length ?? 1,
      complexBonus: c?.bonus ?? 1,
    };
  }

  /** Each network edge's path once. */
  *edges(): IterableIterator<number[]> {
    for (const c of this.complexes.values()) if (c.parent !== null) yield c.path;
  }

  snapshot(): BasesSnapshot {
    return { mainLevel: this.mainLevel };
  }

  /** Call after `econ.restore`: undelivered goods of older saves are credited at once. Grand complexes existing at load do not count as newly formed. */
  restore(s: BasesSnapshot | undefined): void {
    this.mainLevel = s?.mainLevel ?? 1;
    this.econ.capacity = this.capacity();
    this.primed = false;
    if (s?.inTransit) {
      this.econ.credits += s.inTransit;
      this.econ.lifetime.earned += s.inTransit;
    }
  }
}
