import { Board, CellState, isKnownMine, isRevealed, isWall, numberOf } from './board';
import { cellKey, forEachNeighbor, keyX, keyY } from './key';
import type { World } from './world';

/**
 * Constraint extraction and component discovery (spec §4.1, §4.2, §6).
 *
 * Constraints are built on demand from board state, so nothing accumulates:
 * a numbered cell whose neighbours are all resolved simply yields no
 * constraint (it is "sealed", §6). The active constraint set is therefore
 * proportional to the perimeter of the explored area, never its size.
 *
 * Terrain walls count as known safe cells in every mode: like the edge of a
 * finite board, they take cells out of a number's constraint.
 *
 * Modes (INV-1):
 *   engine  - revealed numbers + committed overrides. Flags are NOT mines.
 *   public  - revealed numbers only. What any observer can know for certain.
 *   belief  - public + flags treated as mines. Used by drones and player hints.
 */
export type Mode = 'engine' | 'public' | 'belief';

export interface Constraint {
  /** Unknown cells (keys) covered by this constraint. */
  cells: number[];
  /** Exactly this many of `cells` are mines. */
  n: number;
  /** Key of the numbered cell that produced it, or -(id+1) for a scanner. */
  src: number;
}

export interface ScannerInfo {
  id: number;
  cx: number;
  cy: number;
  r: number;
  /** Total mines inside the (2r+1)^2 box. */
  n: number;
}

export interface CspContext {
  board: Board;
  world: World;
  scanners: ScannerInfo[];
}

export interface Component {
  cells: Set<number>;
  constraints: Constraint[];
  /** Keys of numbered cells contributing constraints. */
  sources: Set<number>;
  capped: boolean;
}

/** 0 = unknown, 1 = known mine, 2 = known safe. */
export function classify(ctx: CspContext, mode: Mode, x: number, y: number): 0 | 1 | 2 {
  const s = ctx.board.get(x, y);
  if (isRevealed(s) || isWall(s)) return 2;
  if (isKnownMine(s)) return 1;
  if (s === CellState.Flag && mode === 'belief') return 1;
  if (mode === 'engine') {
    const c = ctx.world.committed(cellKey(x, y));
    if (c === 1) return 1;
    if (c === 0) return 2;
  }
  return 0;
}

/** Constraint of a revealed numbered cell, or null when it is sealed / not a number. */
export function constraintFor(ctx: CspContext, mode: Mode, x: number, y: number): Constraint | null {
  const s = ctx.board.get(x, y);
  if (!isRevealed(s)) return null;
  let n = numberOf(s);
  const cells: number[] = [];
  forEachNeighbor(x, y, (nx, ny) => {
    const cl = classify(ctx, mode, nx, ny);
    if (cl === 0) cells.push(cellKey(nx, ny));
    else if (cl === 1) n--;
  });
  if (cells.length === 0) return null;
  return { cells, n, src: cellKey(x, y) };
}

export function scannerConstraintFor(ctx: CspContext, mode: Mode, sc: ScannerInfo): Constraint | null {
  let n = sc.n;
  const cells: number[] = [];
  for (let y = sc.cy - sc.r; y <= sc.cy + sc.r; y++) {
    for (let x = sc.cx - sc.r; x <= sc.cx + sc.r; x++) {
      const cl = classify(ctx, mode, x, y);
      if (cl === 0) cells.push(cellKey(x, y));
      else if (cl === 1) n--;
    }
  }
  if (cells.length === 0) return null;
  return { cells, n, src: -(sc.id + 1) };
}

function scannersCovering(ctx: CspContext, x: number, y: number): ScannerInfo[] {
  const out: ScannerInfo[] = [];
  for (const sc of ctx.scanners) {
    if (Math.abs(x - sc.cx) <= sc.r && Math.abs(y - sc.cy) <= sc.r) out.push(sc);
  }
  return out;
}

/**
 * BFS the component reachable from the seeds (numbered cells or unknown cells).
 * Stops with `capped = true` once more than `cap` cells have been gathered.
 */
export function collectComponent(
  ctx: CspContext,
  mode: Mode,
  seeds: number[],
  cap: number,
  includeScanners = true,
): Component {
  const cells = new Set<number>();
  const sources = new Set<number>();
  const constraints: Constraint[] = [];
  const queue: number[] = [];
  let capped = false;

  const addConstraint = (c: Constraint) => {
    constraints.push(c);
    sources.add(c.src);
    for (const k of c.cells) {
      if (!cells.has(k)) {
        cells.add(k);
        queue.push(k);
      }
    }
  };

  for (const k of seeds) {
    const x = keyX(k);
    const y = keyY(k);
    const s = ctx.board.get(x, y);
    if (isRevealed(s)) {
      if (sources.has(k)) continue;
      const c = constraintFor(ctx, mode, x, y);
      if (c) addConstraint(c);
      else sources.add(k);
    } else if (classify(ctx, mode, x, y) === 0 && !cells.has(k)) {
      cells.add(k);
      queue.push(k);
    }
  }

  while (queue.length) {
    if (cells.size > cap) {
      capped = true;
      break;
    }
    const k = queue.pop()!;
    const x = keyX(k);
    const y = keyY(k);
    forEachNeighbor(x, y, (nx, ny) => {
      const ns = ctx.board.get(nx, ny);
      if (!isRevealed(ns)) return;
      const nk = cellKey(nx, ny);
      if (sources.has(nk)) return;
      const c = constraintFor(ctx, mode, nx, ny);
      if (c) addConstraint(c);
      else sources.add(nk);
    });
    if (includeScanners && ctx.scanners.length) {
      for (const sc of scannersCovering(ctx, x, y)) {
        const src = -(sc.id + 1);
        if (sources.has(src)) continue;
        const c = scannerConstraintFor(ctx, mode, sc);
        if (c) addConstraint(c);
        else sources.add(src);
      }
    }
  }
  return { cells, constraints, sources, capped };
}

/** All constraints whose numbered cell lies inside the rect, plus intersecting scanners. */
export function collectRegion(
  ctx: CspContext,
  mode: Mode,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  includeScanners = true,
): Constraint[] {
  const out: Constraint[] = [];
  ctx.board.forEachInRect(x0, y0, x1, y1, (x, y, s) => {
    if (!isRevealed(s) || numberOf(s) === 0) return;
    const c = constraintFor(ctx, mode, x, y);
    if (c) out.push(c);
  });
  if (includeScanners) {
    for (const sc of ctx.scanners) {
      if (sc.cx + sc.r < x0 || sc.cx - sc.r > x1 || sc.cy + sc.r < y0 || sc.cy - sc.r > y1) continue;
      const c = scannerConstraintFor(ctx, mode, sc);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Number of active (non-sealed) constraints in the whole explored area. Used by tests/metrics. */
export function countActiveConstraints(ctx: CspContext, mode: Mode = 'public'): number {
  let n = 0;
  ctx.board.forEachCell((x, y, s) => {
    if (isRevealed(s) && numberOf(s) > 0 && constraintFor(ctx, mode, x, y)) n++;
  });
  return n;
}
