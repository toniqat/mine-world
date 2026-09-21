import type { EconConfig } from '../config';

/**
 * Economy state (spec §9). Settlement is the only moment money is created
 * from flags; nothing here reacts to placing or removing a flag (INV-2).
 *
 * Sapper-style push-your-luck layer (user decision): settlement payouts land
 * in `unbanked` and grow with the click streak; stepping on a mine or having a
 * wrong flag settled burns a fraction of `unbanked`. `cashOut()` banks it.
 * Passive income from bases is credited by `Bases.tick` when it reaches the
 * main base. `incomeRate` (nominal) is written by `Bases.recompute()`.
 */
export interface OwnedMine {
  /** Base income per second, before the main-base level multiplier (see Bases). */
  income: number;
  /** Credits this base has produced (absent in older saves). */
  produced?: number;
  /** Knocked out by a mine explosion: produces nothing and is not a base until repaired. */
  disabled?: boolean;
  /** densityMultiplier at the time of settlement (prestige input). */
  dm: number;
}

export interface Lifetime {
  earned: number;
  banked: number;
  lostToHits: number;
  hits: number;
  settlements: number;
  minesOwned: number;
  wrongFlags: number;
  cellsRevealed: number;
  bestStreak: number;
  bestUnbanked: number;
  prestiges: number;
  clicks: number;
}

export interface EconSnapshot {
  credits: number;
  unbanked: number;
  streak: number;
  incomeRate: number;
  cores: number;
  owned: [number, OwnedMine][];
  lifetime: Lifetime;
}

export function emptyLifetime(): Lifetime {
  return {
    earned: 0,
    banked: 0,
    lostToHits: 0,
    hits: 0,
    settlements: 0,
    minesOwned: 0,
    wrongFlags: 0,
    cellsRevealed: 0,
    bestStreak: 0,
    bestUnbanked: 0,
    prestiges: 0,
    clicks: 0,
  };
}

export class Econ {
  credits = 0;
  unbanked = 0;
  streak = 0;
  incomeRate = 0;
  cores = 0;
  /** Added to `streakMultCap` (the `streak_cap` upgrade). */
  streakCapBonus = 0;
  readonly owned = new Map<number, OwnedMine>();
  lifetime: Lifetime = emptyLifetime();

  constructor(
    public cfg: EconConfig,
    private densityMin: number,
  ) {}

  prestigeMult(): number {
    return 1 + this.cores * this.cfg.prestigeBonusPerCore;
  }

  /** Exponential growth axis (§9.3). */
  densityMultiplier(d: number): number {
    return Math.pow(2, (Math.max(d, this.densityMin) - this.densityMin) / this.cfg.densityDoubling);
  }

  mineValue(d: number): number {
    return this.cfg.baseValue * this.densityMultiplier(d) * this.prestigeMult();
  }

  streakMult(): number {
    return Math.min(this.cfg.streakMultCap + this.streakCapBonus, 1 + this.streak * this.cfg.streakMultPerClick);
  }

  onSafeClick(): void {
    this.streak++;
    this.lifetime.clicks++;
    if (this.streak > this.lifetime.bestStreak) this.lifetime.bestStreak = this.streak;
  }

  /** Returns the amount lost. */
  onHit(): number {
    const loss = this.unbanked * this.cfg.mineHitLossFraction;
    this.unbanked -= loss;
    this.streak = 0;
    this.lifetime.hits++;
    this.lifetime.lostToHits += loss;
    return loss;
  }

  onWrongFlags(count: number): number {
    if (count <= 0) return 0;
    const keep = Math.pow(1 - this.cfg.wrongFlagLossFraction, count);
    const loss = this.unbanked * (1 - keep);
    this.unbanked -= loss;
    this.streak = 0;
    this.lifetime.wrongFlags += count;
    this.lifetime.lostToHits += loss;
    return loss;
  }

  /**
   * Settle a closed component. `mines` are (key, density) pairs of correct flags.
   * Returns payout, income added, and money lost to wrong flags.
   */
  onSettlement(mines: Array<{ key: number; density: number }>, wrong: number): { payout: number; income: number; loss: number } {
    let payout = 0;
    let income = 0;
    const sm = this.streakMult();
    for (const m of mines) {
      const v = this.mineValue(m.density);
      payout += v * this.cfg.settlementPayoutMult * sm;
      const inc = v * this.cfg.incomePerSecondMult;
      income += inc;
      this.owned.set(m.key, { income: inc, dm: this.densityMultiplier(m.density), produced: 0 });
    }
    this.unbanked += payout;
    this.lifetime.settlements++;
    this.lifetime.minesOwned += mines.length;
    if (this.unbanked > this.lifetime.bestUnbanked) this.lifetime.bestUnbanked = this.unbanked;
    const loss = this.onWrongFlags(wrong);
    return { payout, income, loss };
  }

  cashOut(): number {
    const amt = this.unbanked;
    this.credits += amt;
    this.unbanked = 0;
    this.streak = 0;
    this.lifetime.banked += amt;
    this.lifetime.earned += amt;
    return amt;
  }

  canAfford(cost: number): boolean {
    return this.credits >= cost;
  }

  spend(cost: number): boolean {
    if (this.credits < cost) return false;
    this.credits -= cost;
    return true;
  }

  /** Prestige gain (§12 A). */
  prestigeGain(): number {
    let sum = 0;
    for (const m of this.owned.values()) sum += m.dm;
    return Math.floor(sum / this.cfg.prestigeDivisor);
  }

  snapshot(): EconSnapshot {
    return {
      credits: this.credits,
      unbanked: this.unbanked,
      streak: this.streak,
      incomeRate: this.incomeRate,
      cores: this.cores,
      owned: [...this.owned.entries()].map(([k, v]) => [k, { ...v }] as [number, OwnedMine]),
      lifetime: { ...this.lifetime },
    };
  }

  restore(s: EconSnapshot): void {
    this.credits = s.credits;
    this.unbanked = s.unbanked;
    this.streak = s.streak;
    this.incomeRate = s.incomeRate;
    this.cores = s.cores;
    this.owned.clear();
    for (const [k, v] of s.owned) this.owned.set(k, { ...v });
    this.lifetime = { ...emptyLifetime(), ...s.lifetime };
  }
}
