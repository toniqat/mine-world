/**
 * Upgrade tree (spec §8, cut down 2026-09-21). For now the game keeps only
 * the basic incremental axes: shipment speed and the streak cap here, and
 * production through the main-base level (econ/bases.ts). Solver tiers,
 * drones and consumables are no longer sold; drones stay in core for the
 * planned equipment items (see `Game.equipDrones`).
 *
 * Costs: TODO(play).
 */
export type UpgradeGroup = 'network' | 'misc';

export interface UpgradeDef {
  id: string;
  group: UpgradeGroup;
  /** 1 = one-shot, N = levelled. */
  maxLevel: number;
  baseCost: number;
  growth: number;
  requires?: string;
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'transport_speed', group: 'network', maxLevel: 20, baseCost: 80, growth: 1.7 },
  { id: 'streak_cap', group: 'misc', maxLevel: 5, baseCost: 500, growth: 2.5 },
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
    return Math.round(d.baseCost * Math.pow(d.growth, this.level(id)));
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

  /** Upgrades no longer sold (older saves) are dropped. */
  restore(entries: [string, number][]): void {
    this.levels.clear();
    for (const [k, v] of entries) if (BY_ID.has(k)) this.levels.set(k, v);
  }
}
