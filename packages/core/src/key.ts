/**
 * Cell keys: a single JS number encodes (x, y) for use in Map/Set.
 * Coordinates must stay within +-2^25 (33 million cells from the origin).
 */
const HALF = 1 << 25;
const MUL = 1 << 26;

export function cellKey(x: number, y: number): number {
  return (x + HALF) * MUL + (y + HALF);
}
export function keyX(k: number): number {
  return Math.floor(k / MUL) - HALF;
}
export function keyY(k: number): number {
  return (k % MUL) - HALF;
}

export const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/**
 * Horizontal wrap: a world with a map (the Earth mode) repeats every `w`
 * columns, so column w is column 0 again. `w` = 0 means no wrap. Core keeps
 * every stored or keyed coordinate canonical (0 <= x < w).
 */
export function wrapX(x: number, w: number): number {
  return w > 0 ? ((x % w) + w) % w : x;
}

/** Shortest signed horizontal offset from `b` to `a` (a - b) on a world wrapping every `w` columns. */
export function deltaX(a: number, b: number, w: number): number {
  const d = a - b;
  if (w <= 0) return d;
  const m = ((d % w) + w) % w;
  return m > w / 2 ? m - w : m;
}

/** The 8 neighbours, canonical on a wrapping world (`w`). */
export function forEachNeighbor(x: number, y: number, fn: (nx: number, ny: number) => void, w = 0): void {
  for (let i = 0; i < 8; i++) {
    const o = NEIGHBOR_OFFSETS[i];
    fn(w > 0 ? wrapX(x + o[0], w) : x + o[0], y + o[1]);
  }
}

export function chebyshev(x0: number, y0: number, x1: number, y1: number, w = 0): number {
  return Math.max(Math.abs(deltaX(x0, x1, w)), Math.abs(y0 - y1));
}

/** Tile-rounded disc: true when the cell at offset (dx, dy) has its centre within r + 0.5 of the origin cell's centre. */
export function inDisc(dx: number, dy: number, r: number): boolean {
  return dx * dx + dy * dy <= r * r + r;
}
