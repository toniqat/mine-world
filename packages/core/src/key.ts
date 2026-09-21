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

export function forEachNeighbor(x: number, y: number, fn: (nx: number, ny: number) => void): void {
  for (let i = 0; i < 8; i++) {
    const o = NEIGHBOR_OFFSETS[i];
    fn(x + o[0], y + o[1]);
  }
}

export function chebyshev(x0: number, y0: number, x1: number, y1: number): number {
  return Math.max(Math.abs(x0 - x1), Math.abs(y0 - y1));
}

/** Tile-rounded disc: true when the cell at offset (dx, dy) has its centre within r + 0.5 of the origin cell's centre. */
export function inDisc(dx: number, dy: number, r: number): boolean {
  return dx * dx + dy * dy <= r * r + r;
}
