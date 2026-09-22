import { CHUNK } from './board';
import type { FogConfig } from './config';
import { cellKey, keyX, keyY, wrapX } from './key';

/**
 * Fog of war (user decision 2026-09-21). Every closed cell is hidden until a
 * vision source has seen it: Unknown cells and terrain walls under fog look
 * alike (mountain and river cannot be told apart) and cannot be opened or
 * flagged. Before the start is set the whole world is fogged. Sources: the
 * main base (disc of `mainRadius`), every base (disc of `baseRadius`) and
 * every opened cell (square of `openedRadius`). Radii are fixed. Fog never
 * returns: the seen set only grows, and it follows from the sources alone,
 * so nothing of it is saved.
 */
export class Fog {
  /** Seen cells, one byte per cell in 16x16 chunks. */
  private readonly seen = new Map<number, Uint8Array>();
  /** Disc sources (main base and bases) already rasterised. */
  private readonly drawn = new Set<number>();
  /** Cells that became visible since the last `take()`. */
  private lifted: number[] = [];

  constructor(
    readonly cfg: FogConfig,
    /** Columns after which the world repeats (World.wrap); 0: no wrap. */
    readonly wrap = 0,
  ) {}

  isSeen(x: number, y: number): boolean {
    if (this.wrap) x = wrapX(x, this.wrap);
    const c = this.seen.get(cellKey(x >> 4, y >> 4));
    return c !== undefined && c[((y & 15) << 4) | (x & 15)] === 1;
  }

  /** Rasterise the discs of sources not seen before. Returns true when any cell was lifted. */
  update(main: number | null, bases: Iterable<number>): boolean {
    const before = this.lifted.length;
    if (main !== null) this.source(main, this.cfg.mainRadius);
    for (const k of bases) if (k !== main) this.source(k, this.cfg.baseRadius);
    return this.lifted.length > before;
  }

  /** An opened cell sees `openedRadius` tiles around it. Returns true when any cell was lifted. */
  opened(x: number, y: number): boolean {
    const before = this.lifted.length;
    const r = this.cfg.openedRadius;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.mark(x + dx, y + dy);
    return this.lifted.length > before;
  }

  /** Cells lifted since the last call (keys), for the renderer. */
  take(): number[] {
    const out = this.lifted;
    this.lifted = [];
    return out;
  }

  clear(): void {
    this.seen.clear();
    this.drawn.clear();
    this.lifted = [];
  }

  private source(key: number, r: number): void {
    if (this.drawn.has(key)) return;
    this.drawn.add(key);
    this.disc(keyX(key), keyY(key), r);
  }

  private disc(cx: number, cy: number, r: number): void {
    const n = Math.floor(r + 0.5);
    const r2 = (r + 0.5) * (r + 0.5);
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) if (dx * dx + dy * dy <= r2) this.mark(cx + dx, cy + dy);
    }
  }

  private mark(x: number, y: number): void {
    if (this.wrap) x = wrapX(x, this.wrap);
    const ck = cellKey(x >> 4, y >> 4);
    let c = this.seen.get(ck);
    if (!c) {
      c = new Uint8Array(CHUNK * CHUNK);
      this.seen.set(ck, c);
    }
    const i = ((y & 15) << 4) | (x & 15);
    if (c[i]) return;
    c[i] = 1;
    this.lifted.push(cellKey(x, y));
  }
}
