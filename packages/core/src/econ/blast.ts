import type { BlastConfig } from '../config';
import { hash01 } from '../hash';

/**
 * Mine explosions (user decision 2026-09-21). Stepping on a mine sets off a
 * circular blast centred on it that disables every base inside (the main base
 * is immune). The radius is rolled in a range that grows with the distance
 * from the main base, one step per `bandTiles`: the minimum and the maximum
 * rise in turn so they never get closer than one tile apart
 * (band 0: 3-5, 1: 4-5, 2: 4-6, 3: 5-6, ...).
 *
 * A disabled base produces nothing and is not a base for the network until it
 * is repaired; repairs cost more the more of the world is opened.
 */
export interface BlastRange {
  band: number;
  min: number;
  max: number;
}

export function blastRange(cfg: BlastConfig, distance: number): BlastRange {
  const band = Math.max(0, Math.floor(distance / cfg.bandTiles));
  return { band, min: cfg.minRadius + Math.ceil(band / 2), max: cfg.maxRadius + Math.floor(band / 2) };
}

/** Radius of the blast at (x, y): uniform in the range, stable for the same seed, cell and hit count. */
export function blastRadius(cfg: BlastConfig, distance: number, seed: number, x: number, y: number, n: number): number {
  const r = blastRange(cfg, distance);
  return r.min + (r.max - r.min) * hash01(seed ^ 0x6b1a57, x + 131 * n, y - 197 * n);
}

/** Is the cell at offset (dx, dy) from the blast centre inside a blast of radius r? */
export function inBlast(dx: number, dy: number, r: number): boolean {
  return dx * dx + dy * dy <= r * r;
}

export function repairCost(cfg: BlastConfig, openedCells: number): number {
  return Math.round(cfg.repairCostBase + cfg.repairCostPerTile * openedCells);
}
