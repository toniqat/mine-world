import type { WorldConfig } from './config';
import { CellState } from './board';
import { clamp, fbm, hash01 } from './hash';
import { cellKey } from './key';

/**
 * World = base layer (stateless hash) + override layer (sparse, authoritative).
 *
 * Consistency invariant maintained by the whole engine:
 *   `truth(x, y)` over all cells is a full assignment consistent with every
 *   revealed number. Base values are stateless, overrides never change (INV-4),
 *   and debt pressure is frozen per chunk on first touch, so the assignment is
 *   stable. Interventions (§5) commit a whole alternative solution of one
 *   component, which keeps the invariant.
 */
export class World {
  readonly overrides = new Map<number, 0 | 1>();
  /** Density-debt pressure frozen per chunk when the chunk is first observed. */
  readonly chunkPressure = new Map<number, number>();
  densityDebt = 0;
  interventions = 0;
  /**
   * Centre of the mine-free start area and of the distance ramp: the first
   * cell opened. It can move until any truth has been observed.
   */
  startX = 0;
  startY = 0;
  started = false;

  static readonly CHUNK = 16;
  /** Terrain per 16x16 chunk (CellState.Mountain / Water / 0), filled lazily once the start is set. */
  private readonly terrainChunks = new Map<number, Uint8Array>();

  constructor(public cfg: WorldConfig, public seed: number) {}

  /** Move the start area onto (x, y). Ignored once any truth was observed. */
  setStart(x: number, y: number): void {
    if (this.started) return;
    this.startX = x;
    this.startY = y;
    this.started = true;
  }

  /**
   * Coordinates the noise and hashes read: relative to the start cell when
   * `startRelative`, so the map does not depend on where the main base went.
   */
  private nx(x: number): number {
    return this.cfg.startRelative ? x - this.startX : x;
  }
  private ny(y: number): number {
    return this.cfg.startRelative ? y - this.startY : y;
  }

  /** Prior mine density at a cell (§3.1 / §3.3). */
  density(x: number, y: number): number {
    const w = this.cfg;
    const r = Math.hypot(x - this.startX, y - this.startY);
    if (r < w.startSafeRadius) return 0;
    if (w.uniformDensity !== null) return w.uniformDensity;
    let n = fbm(this.seed, this.nx(x), this.ny(y), w.biomeNoiseScale, w.biomeOctaves);
    n = clamp((n - 0.5) * w.biomeContrast + 0.5, 0, 1);
    let d = w.densityMin + (w.densityMax - w.densityMin) * n;
    d += Math.min(w.distanceRampCap, w.distanceRamp * r);
    d = clamp(d, w.densityMin, w.densityMax);
    if (w.riverEnabled && r > (w.riverMinRadius ?? 60)) {
      const rv = fbm(this.seed ^ 0x5bd1e995, x, y, w.riverNoiseScale, 2);
      if (Math.abs(rv - 0.5) < w.riverWidth) d = w.riverDensity ?? 0.9;
    }
    const fadeR = w.startSafeRadius * 3;
    if (r < fadeR) d *= (r - w.startSafeRadius) / (fadeR - w.startSafeRadius);
    return d;
  }

  isMineBase(x: number, y: number): boolean {
    return hash01(this.seed, this.nx(x), this.ny(y)) < this.density(x, y);
  }

  /**
   * Terrain wall at a cell (CellState.Mountain / Water), or 0. Stateless from the
   * seed and the start cell; nothing before the start is set, nothing near it.
   */
  terrain(x: number, y: number): number {
    if (!this.cfg.terrainEnabled || !this.started) return 0;
    const ck = cellKey(x >> 4, y >> 4);
    let c = this.terrainChunks.get(ck);
    if (!c) {
      c = new Uint8Array(World.CHUNK * World.CHUNK);
      const bx = (x >> 4) * World.CHUNK;
      const by = (y >> 4) * World.CHUNK;
      for (let i = 0; i < c.length; i++) c[i] = this.terrainAt(bx + (i & 15), by + (i >> 4));
      this.terrainChunks.set(ck, c);
    }
    return c[((y & 15) << 4) | (x & 15)];
  }

  private terrainAt(ax: number, ay: number): number {
    const w = this.cfg;
    if (Math.hypot(ax - this.startX, ay - this.startY) < w.terrainMinRadius) return 0;
    const x = this.nx(ax);
    const y = this.ny(ay);
    if (fbm(this.seed ^ 0x2f6b1d3a, x, y, w.mountainNoiseScale, 3) > w.mountainThreshold) return CellState.Mountain;
    const rv = fbm(this.seed ^ 0x5bd1e995, x, y, w.riverNoiseScale, 2);
    if (Math.abs(rv - 0.5) < w.riverWidth && fbm(this.seed ^ 0x6c8e9cf5, x, y, w.fordNoiseScale, 1) >= w.fordThreshold) return CellState.Water;
    return 0;
  }

  committed(key: number): 0 | 1 | undefined {
    return this.overrides.get(key);
  }

  /** INV-4: a committed value is never rewritten. */
  commit(key: number, v: 0 | 1): void {
    const prev = this.overrides.get(key);
    if (prev !== undefined) {
      if (prev !== v) throw new Error(`INV-4 violation: override ${key} is ${prev}, tried ${v}`);
      return;
    }
    this.overrides.set(key, v);
  }

  private pressureFor(x: number, y: number): number {
    const ck = cellKey(x >> 4, y >> 4);
    const p = this.chunkPressure.get(ck);
    if (p !== undefined) return p;
    let np = 0;
    if (this.densityDebt > 0) {
      const cx = (x >> 4) * World.CHUNK + 8;
      const cy = (y >> 4) * World.CHUNK + 8;
      const d = Math.max(this.density(cx, cy), 0.01);
      const area = World.CHUNK * World.CHUNK;
      np = Math.min(this.cfg.debtPressureMax, this.densityDebt / (area * d));
      this.densityDebt -= area * d * np;
      if (this.densityDebt < 0) this.densityDebt = 0;
    }
    this.chunkPressure.set(ck, np);
    return np;
  }

  /**
   * Authoritative truth of a cell: override if committed, otherwise the base
   * layer with frozen debt pressure. Deterministic and stable once observed.
   */
  truth(x: number, y: number): 0 | 1 {
    this.started = true;
    if (this.terrain(x, y)) return 0;
    const ov = this.overrides.get(cellKey(x, y));
    if (ov !== undefined) return ov;
    const d = this.density(x, y);
    const h = hash01(this.seed, this.nx(x), this.ny(y));
    if (h < d) return 1;
    const p = this.pressureFor(x, y);
    return p > 0 && h < d * (1 + p) ? 1 : 0;
  }
}
