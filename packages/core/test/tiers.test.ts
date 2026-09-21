import { describe, expect, it } from 'vitest';
import { CellState, Econ, Game, isRevealed, makeConfig, upgradeDef } from '../src';

const RADII = [6, 12];

function tierGame(seed = 1): Game {
  const g = new Game({
    seed,
    fog: { enabled: false },
    tiers: { radii: RADII },
    world: { uniformDensity: 0.12, terrainEnabled: false },
    play: { cascadeRadius: 40, cascadeCap: 100000 },
  } as never);
  g.reveal(0, 0);
  g.econ.credits = 1e12;
  return g;
}

/** A tier-`t` Unknown cell with truth 0, or null. */
function safeCellOfTier(g: Game, t: number): [number, number] | null {
  for (let r = 0; r < 30; r++) for (let x = -r; x <= r; x++) for (const y of [-r, r]) {
    if (g.tierAt(x, y) === t && g.cellState(x, y) === CellState.Unknown && g.world.truth(x, y) === 0) return [x, y];
  }
  return null;
}

describe('mining tiers (T-TIER)', () => {
  it('tiers are rings around the main base', () => {
    const g = tierGame();
    expect(g.tierAt(0, 0)).toBe(1);
    expect(g.tierAt(5, 0)).toBe(1);
    expect(g.tierAt(6, 0)).toBe(2);
    expect(g.tierAt(11, 3)).toBe(2);
    expect(g.tierAt(12, 0)).toBe(3);
    expect(g.tierAt(100, 100)).toBe(3);
    expect(g.miningTier()).toBe(1);
  });

  it('locked cells cannot be opened, flagged or marked, and cascades stop at them', () => {
    const g = tierGame();
    g.board.forEachCell((x, y, s) => {
      if (isRevealed(s)) expect(g.tierAt(x, y)).toBe(1);
    });
    const [x, y] = safeCellOfTier(g, 2)!;
    expect(g.locked(x, y)).toBe(true);
    expect(g.reveal(x, y).revealed).toBe(0);
    expect(g.toggleFlag(x, y)).toBe(false);
    g.cycleMark(x, y);
    expect(g.cellState(x, y)).toBe(CellState.Unknown);
    expect(g.questioned(x, y)).toBe(false);
  });

  it('each mining level unlocks one more tier', () => {
    const g = tierGame();
    const techs: number[] = [];
    g.events.on('tech', (t) => techs.push(t));
    expect(g.buy('mining').ok).toBe(true);
    expect(g.miningTier()).toBe(2);
    expect(techs).toEqual([2]);
    const [x, y] = safeCellOfTier(g, 2)!;
    expect(g.locked(x, y)).toBe(false);
    expect(g.reveal(x, y).revealed).toBeGreaterThan(0);
    expect(g.locked(20, 0)).toBe(true);
    expect(g.buy('mining').ok).toBe(true);
    expect(g.miningTier()).toBe(3);
    expect(g.locked(20, 0)).toBe(false);
    expect(techs).toEqual([2, 3]);
    // The level survives a save.
    expect(Game.fromSave(structuredClone(g.toSave())).miningTier()).toBe(3);
  });

  it('mining costs follow its price table and max out at the last tier', () => {
    const g = tierGame();
    const def = upgradeDef('mining');
    const paid: number[] = [];
    for (let l = 0; l < def.maxLevel; l++) {
      paid.push(g.upgrades.cost('mining'));
      expect(g.buy('mining').ok).toBe(true);
    }
    expect(paid).toEqual(def.costs);
    expect(g.buy('mining')).toEqual({ ok: false, reason: 'maxed' });
  });

  it('old saves: the one-shot mining_t<n> technologies become a mining level', () => {
    const g = tierGame();
    const save = structuredClone(g.toSave());
    save.upgrades = [['mining_t2', 1], ['mining_t3', 1], ['streak_cap', 2]];
    const h = Game.fromSave(save);
    expect(h.upgrades.level('mining')).toBe(2);
    expect(h.miningTier()).toBe(3);
    expect(h.upgrades.level('streak_cap')).toBe(2);
  });

  it('higher tiers are worth more and blast wider', () => {
    const g = tierGame();
    const mult = g.cfg.tiers.valueMult;
    const d = (x: number) => g.econ.mineValue(g.world.density(x, 0));
    expect(g.mineValueAt(3, 0)).toBeCloseTo(d(3) * mult[0]);
    expect(g.mineValueAt(8, 0)).toBeCloseTo(d(8) * mult[1]);
    expect(g.mineValueAt(30, 0)).toBeCloseTo(d(30) * mult[2]);
    const b = g.cfg.blast.radiusByTier;
    expect([g.blastRangeAt(3, 0), g.blastRangeAt(8, 0), g.blastRangeAt(30, 0)].map((r) => [r.min, r.max])).toEqual([b[0], b[1], b[2]]);
  });

  it('every default tier has a mining level, a value multiplier and a blast range', () => {
    const cfg = makeConfig({} as never);
    const tiers = cfg.tiers.radii.length + 1;
    expect(cfg.tiers.valueMult).toHaveLength(tiers);
    expect(cfg.blast.radiusByTier).toHaveLength(tiers);
    expect(upgradeDef('mining').maxLevel).toBe(tiers - 1);
    expect(upgradeDef('mining').costs).toHaveLength(tiers - 1);
  });

  it('settlement pays and produces with the tier multiplier', () => {
    const cfg = makeConfig({} as never);
    const a = new Econ(cfg.econ, cfg.world.densityMin);
    const b = new Econ(cfg.econ, cfg.world.densityMin);
    const ra = a.onSettlement([{ key: 1, density: 0.2 }], 0);
    const rb = b.onSettlement([{ key: 1, density: 0.2, mult: 4 }], 0);
    expect(rb.payout).toBeCloseTo(ra.payout * 4);
    expect(rb.income).toBeCloseTo(ra.income * 4);
  });
});

describe('start-relative map', () => {
  it('the map around the main base does not depend on where it was placed', () => {
    const cfg = { seed: 11, fog: { enabled: false }, tiers: { enabled: false } } as never;
    const a = new Game(cfg);
    const b = new Game(cfg);
    a.reveal(0, 0);
    b.reveal(137, -52);
    for (let y = -30; y <= 30; y++) for (let x = -30; x <= 30; x++) {
      expect(b.world.truth(x + 137, y - 52)).toBe(a.world.truth(x, y));
      expect(b.cellState(x + 137, y - 52)).toBe(a.cellState(x, y));
    }
  });
});
