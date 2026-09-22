import type { EconConfig } from '../config';

/**
 * Economy state (spec §9, reworked 2026-09-22). Settlement is still the only
 * moment money comes from flags; nothing here reacts to placing or removing a
 * flag (INV-2).
 *
 * Points (user decision 2026-09-22): every opened cell earns `tilePoints` and
 * every base a settlement creates earns `basePoints`, x the point multiplier
 * (`baseMult` from the active bases x the streak x prestige). Points land in
 * `unbanked`, which holds at most `capacity` (the main-base level raises it);
 * a full pool blocks openings until `cashOut()` banks it into `credits`.
 * Stepping on a mine or having a wrong flag settled burns a fraction of
 * `unbanked` (Sapper-style). Bases no longer produce anything by themselves.
 * `baseMult` and `capacity` are written by `Bases.recompute()`.
 */
export interface OwnedMine {
  /** Per-turn production of the retired economy (older saves only). */
  income?: number;
  /** Credits this base produced under the retired economy (older saves only). */
  produced?: number;
  /** Knocked out by a mine explosion: not a base until repaired. */
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
  cores = 0;
  /** Point multiplier from the active bases (1 + multPerBase x their weight). */
  baseMult = 1;
  /** Most the unbanked pool holds (storageBase x storageGrowth^(main-base level - 1)). */
  capacity = Infinity;
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

  streakMult(): number {
    return Math.min(this.cfg.streakMultCap + this.streakCapBonus, 1 + this.streak * this.cfg.streakMultPerClick);
  }

  /** Everything a point is multiplied by: bases x streak x prestige. */
  pointMult(): number {
    return this.baseMult * this.streakMult() * this.prestigeMult();
  }

  /** The unbanked pool is full: nothing more can be opened until Cash Out. */
  full(): boolean {
    return this.unbanked >= this.capacity;
  }

  /** Add `points` x the point multiplier to the unbanked pool, up to its capacity. Returns what was added. */
  gain(points: number): number {
    if (points <= 0) return 0;
    const add = Math.min(points * this.pointMult(), Math.max(0, this.capacity - this.unbanked));
    this.unbanked += add;
    if (this.unbanked > this.lifetime.bestUnbanked) this.lifetime.bestUnbanked = this.unbanked;
    return add;
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
   * Settle a claim batch. `mines` are the correct flags (they become bases,
   * `basePoints` each); `wrong` flags burn part of the pool.
   * Returns the points paid and the money lost to wrong flags.
   */
  onSettlement(mines: Array<{ key: number; density: number }>, wrong: number): { payout: number; loss: number } {
    for (const m of mines) this.owned.set(m.key, { dm: this.densityMultiplier(m.density) });
    const payout = this.gain(mines.length * this.cfg.basePoints);
    this.lifetime.settlements++;
    this.lifetime.minesOwned += mines.length;
    const loss = this.onWrongFlags(wrong);
    return { payout, loss };
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
      cores: this.cores,
      owned: [...this.owned.entries()].map(([k, v]) => [k, { ...v }] as [number, OwnedMine]),
      lifetime: { ...this.lifetime },
    };
  }

  restore(s: EconSnapshot): void {
    this.credits = s.credits;
    this.unbanked = s.unbanked;
    this.streak = s.streak;
    this.cores = s.cores;
    this.owned.clear();
    for (const [k, v] of s.owned) this.owned.set(k, { ...v });
    this.lifetime = { ...emptyLifetime(), ...s.lifetime };
  }
}
