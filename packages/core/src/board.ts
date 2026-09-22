import { cellKey, wrapX } from './key';

/** Player-visible cell states, stored one byte per cell in 16x16 chunks. */
export const CellState = {
  Unknown: 0,
  Flag: 1,
  /** Settled, correct flag: an owned mine (a base). */
  Owned: 2,
  /** A mine that was stepped on. Lost. */
  Exploded: 3,
  /** A real mine whose claim batch contained a wrong flag: forfeited, not a base. */
  Lost: 4,
  /** Terrain walls: no tile, never a mine, no number. Never stored; `Board.terrain` supplies them. */
  Mountain: 5,
  Water: 6,
  RevealedBase: 16,
} as const;

export function isRevealed(s: number): boolean {
  return s >= CellState.RevealedBase;
}
export function numberOf(s: number): number {
  return s - CellState.RevealedBase;
}
export function isKnownMine(s: number): boolean {
  return s === CellState.Owned || s === CellState.Exploded || s === CellState.Lost;
}
export function isWall(s: number): boolean {
  return s === CellState.Mountain || s === CellState.Water;
}
export function revealedState(n: number): number {
  return CellState.RevealedBase + n;
}

export const CHUNK = 16;

export class Board {
  readonly chunks = new Map<number, Uint8Array>();
  revealedCount = 0;
  flagCount = 0;
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;
  private touched = false;
  /** Terrain lookup (World.terrain): the state of a cell nothing was stored in. */
  terrain: ((x: number, y: number) => number) | null = null;
  /** Columns after which the world repeats (World.wrap); 0: no wrap. Any x is accepted and stored canonically. */
  wrap = 0;

  get(x: number, y: number): number {
    if (this.wrap) x = wrapX(x, this.wrap);
    const c = this.chunks.get(cellKey(x >> 4, y >> 4));
    const s = c ? c[((y & 15) << 4) | (x & 15)] : 0;
    return s === 0 && this.terrain ? this.terrain(x, y) : s;
  }

  set(x: number, y: number, s: number): void {
    if (this.wrap) x = wrapX(x, this.wrap);
    const ck = cellKey(x >> 4, y >> 4);
    let c = this.chunks.get(ck);
    if (!c) {
      c = new Uint8Array(CHUNK * CHUNK);
      this.chunks.set(ck, c);
    }
    const i = ((y & 15) << 4) | (x & 15);
    const prev = c[i];
    if (prev === s) return;
    if (isRevealed(prev)) this.revealedCount--;
    if (isRevealed(s)) this.revealedCount++;
    if (prev === CellState.Flag) this.flagCount--;
    if (s === CellState.Flag) this.flagCount++;
    c[i] = s;
    if (!this.touched) {
      this.touched = true;
      this.minX = this.maxX = x;
      this.minY = this.maxY = y;
    } else {
      if (x < this.minX) this.minX = x;
      if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
    }
  }

  /**
   * Visit every non-zero cell inside the rect (inclusive), touching only existing
   * chunks. On a wrapping board the rect may cross the seam; cells are reported
   * with canonical coordinates, each once.
   */
  forEachInRect(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number, s: number) => void): void {
    const w = this.wrap;
    if (w && (x0 < 0 || x1 >= w)) {
      if (x1 - x0 + 1 >= w) return this.forEachInRect(0, y0, w - 1, y1, fn);
      const a = wrapX(x0, w);
      const b = wrapX(x1, w);
      if (a <= b) return this.forEachInRect(a, y0, b, y1, fn);
      this.forEachInRect(a, y0, w - 1, y1, fn);
      return this.forEachInRect(0, y0, b, y1, fn);
    }
    for (let cy = y0 >> 4; cy <= y1 >> 4; cy++) {
      for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
        const c = this.chunks.get(cellKey(cx, cy));
        if (!c) continue;
        const bx = cx * CHUNK;
        const by = cy * CHUNK;
        for (let i = 0; i < 256; i++) {
          const s = c[i];
          if (s === 0) continue;
          const x = bx + (i & 15);
          const y = by + (i >> 4);
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
          fn(x, y, s);
        }
      }
    }
  }

  forEachCell(fn: (x: number, y: number, s: number) => void): void {
    if (!this.touched) return;
    this.forEachInRect(this.minX, this.minY, this.maxX, this.maxY, fn);
  }

  clone(): Board {
    const b = new Board();
    for (const [k, c] of this.chunks) b.chunks.set(k, new Uint8Array(c));
    b.revealedCount = this.revealedCount;
    b.flagCount = this.flagCount;
    b.minX = this.minX;
    b.minY = this.minY;
    b.maxX = this.maxX;
    b.maxY = this.maxY;
    b.touched = this.touched;
    b.terrain = this.terrain;
    b.wrap = this.wrap;
    return b;
  }

  /** Restore counters/bounds after chunks were loaded from a save. */
  recount(): void {
    this.revealedCount = 0;
    this.flagCount = 0;
    this.touched = false;
    for (const [k, c] of this.chunks) {
      for (let i = 0; i < 256; i++) {
        const s = c[i];
        if (s === 0) continue;
        const x = (Math.floor(k / (1 << 26)) - (1 << 25)) * CHUNK + (i & 15);
        const y = ((k % (1 << 26)) - (1 << 25)) * CHUNK + (i >> 4);
        if (isRevealed(s)) this.revealedCount++;
        if (s === CellState.Flag) this.flagCount++;
        if (!this.touched) {
          this.touched = true;
          this.minX = this.maxX = x;
          this.minY = this.maxY = y;
        } else {
          if (x < this.minX) this.minX = x;
          if (x > this.maxX) this.maxX = x;
          if (y < this.minY) this.minY = y;
          if (y > this.maxY) this.maxY = y;
        }
      }
    }
  }
}
