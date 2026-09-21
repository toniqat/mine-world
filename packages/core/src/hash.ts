/**
 * Deterministic coordinate hashing and biome noise (spec §3.1).
 * Stateless: the same (seed, x, y) always yields the same value.
 */

/** 32-bit coordinate hash with murmur-style finalisation. No chunk artefacts. */
export function hash32(seed: number, x: number, y: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ Math.imul(x | 0, 0x27d4eb2d), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ Math.imul(y | 0, 0x165667b1), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (h >>> 7), 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Uniform value in [0, 1). */
export function hash01(seed: number, x: number, y: number): number {
  return hash32(seed, x, y) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth value noise on a lattice of `scale` cells. Output in [0, 1]. */
export function valueNoise(seed: number, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const a = hash01(seed, x0, y0);
  const b = hash01(seed, x0 + 1, y0);
  const c = hash01(seed, x0, y0 + 1);
  const d = hash01(seed, x0 + 1, y0 + 1);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/** Fractional Brownian motion over valueNoise. Output in [0, 1], centred near 0.5. */
export function fbm(seed: number, x: number, y: number, scale: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let ampSum = 0;
  let s = scale;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(seed + i * 1013, x + i * 17, y - i * 31, s);
    ampSum += amp;
    amp *= 0.5;
    s /= 2;
  }
  return sum / ampSum;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
