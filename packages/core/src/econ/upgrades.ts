/**
 * Upgrade tree (spec §8, cut down 2026-09-21). For now the game keeps only
 * the basic incremental axes: the streak cap here, and
 * production through the main-base level (econ/bases.ts), plus the mining
 * technology (`tech`: one levelled upgrade, level n opens tier n + 1). Solver tiers,
 * drones and consumables are no longer sold; drones stay in core for the
 * planned equipment items (see `Game.equipDrones`).
 *
 * Costs: TODO(play).
 */
export type UpgradeGroup = 'misc' | 'tech';

export interface UpgradeDef {
  id: string;
  group: UpgradeGroup;
  /** 1 = one-shot, N = levelled. */
  maxLevel: number;
  baseCost: number;
  growth: number;
  /** Explicit price per level (index = current level); overrides baseCost x growth^level. */
  costs?: number[];
  requires?: string;
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'streak_cap', group: 'misc', maxLevel: 5, baseCost: 500, growth: 2.5 },
  // Mining technology: level n opens tier n + 1 (config.tiers). Rough estimate for the point
  // economy (2026-09-22, not simulated): clearing tier 1 earns ~20-50k points, tier 2 ~0.3M,
  // tier 3 ~3M, tier 4 ~15M, as the base multiplier grows with the bases; each level costs about
  // half of what the tier before it pays. TODO(play)
  { id: 'mining', group: 'tech', maxLevel: 4, baseCost: 10_000, growth: 1, costs: [10_000, 150_000, 1_500_000, 6_000_000] },
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgradeDef(id: string): UpgradeDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown upgrade ${id}`);
  return d;
}

export class Upgrades {
  readonly levels = new Map<string, number>();

  level(id: string): number {
    return this.levels.get(id) ?? 0;
  }

  has(id: string): boolean {
    return this.level(id) > 0;
  }

  cost(id: string): number {
    const d = upgradeDef(id);
    const l = this.level(id);
    if (d.costs) return d.costs[Math.min(d.costs.length - 1, l)];
    return Math.round(d.baseCost * Math.pow(d.growth, l));
  }

  /** Reason the upgrade cannot be bought, or null when it can (ignoring money). */
  blocked(id: string): 'maxed' | 'requires' | null {
    const d = upgradeDef(id);
    if (this.level(id) >= d.maxLevel) return 'maxed';
    if (d.requires && !this.has(d.requires)) return 'requires';
    return null;
  }

  /** Record a purchase (money is handled by the caller). */
  apply(id: string): void {
    upgradeDef(id);
    this.levels.set(id, this.level(id) + 1);
  }

  snapshot(): [string, number][] {
    return [...this.levels.entries()];
  }

  /** Upgrades no longer sold (older saves) are dropped; the old one-shot `mining_t<n>` become `mining` level n - 1. */
  restore(entries: [string, number][]): void {
    this.levels.clear();
    for (const [k, v] of entries) {
      const old = /^mining_t(\d+)$/.exec(k);
      if (old && v > 0) this.levels.set('mining', Math.max(this.level('mining'), Number(old[1]) - 1));
      else if (BY_ID.has(k)) this.levels.set(k, v);
    }
  }
}
