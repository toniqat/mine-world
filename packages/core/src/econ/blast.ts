import type { BlastConfig } from '../config';
import { hash01 } from '../hash';

/**
 * Mine explosions (user decision 2026-09-21). Stepping on a mine sets off a
 * circular blast centred on it that disables every base inside (the main base
 * is immune). The radius is rolled in the range of the mine's mining tier
 * (`radiusByTier`), so mines in higher tiers blast wider.
 *
 * A disabled base does not count towards the multiplier and is not a base for the network until it
 * is repaired; repairs cost more the more of the world is opened.
 */
export interface BlastRange {
  tier: number;
  min: number;
  max: number;
}

export function blastRange(cfg: BlastConfig, tier: number): BlastRange {
  const t = cfg.radiusByTier;
  const [min, max] = t[Math.max(0, Math.min(t.length - 1, tier - 1))];
  return { tier, min, max };
}

/** Radius of the blast at (x, y) in `tier`: uniform in the range, stable for the same seed, cell and hit count. */
export function blastRadius(cfg: BlastConfig, tier: number, seed: number, x: number, y: number, n: number): number {
  const r = blastRange(cfg, tier);
  return r.min + (r.max - r.min) * hash01(seed ^ 0x6b1a57, x + 131 * n, y - 197 * n);
}

/** Is the cell at offset (dx, dy) from the blast centre inside a blast of radius r? */
export function inBlast(dx: number, dy: number, r: number): boolean {
  return dx * dx + dy * dy <= r * r;
}

export function repairCost(cfg: BlastConfig, openedCells: number): number {
  return Math.round(cfg.repairCostBase + cfg.repairCostPerTile * openedCells);
}
