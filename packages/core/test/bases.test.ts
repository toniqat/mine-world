import { describe, expect, it } from 'vitest';
import { Bases, CellState, Econ, Game, blastRange, blastRadius, cellKey, forEachNeighbor, inBlast, isRevealed, keyX, keyY, makeConfig, manhattan, numberOf, revealedState } from '../src';

/** `storage`: the unbanked pool's base capacity (unlimited unless a test is about it). */
function game(seed = 3, strict = false, storage = Infinity): Game {
  const g = new Game({ seed, fog: { enabled: false }, tiers: { enabled: false }, world: { uniformDensity: 0.2, terrainEnabled: false }, econ: { storageBase: storage }, resolve: { interventionMode: strict ? 'STRICT' : 'FAIR' } } as never);
  g.reveal(0, 0);
  g.econ.credits = 1e12;
  return g;
}

/** Probe frontier mines until `want` bases exist (probes own a mine immediately). */
function ownMines(g: Game, want: number): number[] {
  const owned: number[] = [];
  g.board.forEachCell((x, y, s) => {
    if (owned.length >= want || !isRevealed(s) || numberOf(s) === 0) return;
    forEachNeighbor(x, y, (nx, ny) => {
      if (owned.length < want && g.cellState(nx, ny) === CellState.Unknown && g.world.truth(nx, ny) === 1) {
        g.useProbe(nx, ny);
        owned.push(cellKey(nx, ny));
      }
    });
  });
  return owned;
}

describe('bases', () => {
  it('the start cell is the main base; it adds nothing to the multiplier and nothing is produced over time', () => {
    const g = game();
    expect(g.bases.main).toBe(cellKey(0, 0));
    const info = g.baseInfo(0, 0)!;
    expect(info.main).toBe(true);
    expect(info.multShare).toBe(0);
    expect(g.econ.baseMult).toBe(1);
    const c0 = g.econ.credits;
    const u0 = g.econ.unbanked;
    g.tick(10);
    expect(g.econ.credits).toBe(c0);
    expect(g.econ.unbanked).toBe(u0);
  });

  it('settled bases within 2 tiles form a complex; edges avoid Unknown and hop to the nearest complex closer to the main base', () => {
    const g = game();
    expect(ownMines(g, 12).length).toBeGreaterThan(3);
    const b = g.bases;
    const main = b.main!;
    let sum = 0;
    for (const k of g.econ.owned.keys()) sum += b.info(k)!.multShare;
    expect(g.econ.baseMult).toBeCloseTo(1 + sum);
    const hubDist = (k: number) => manhattan(b.complexOf.get(k)!, main);
    const cheb = (a: number, c: number) => Math.max(Math.abs(keyX(a) - keyX(c)), Math.abs(keyY(a) - keyY(c)));
    for (const c of b.complexes.values()) {
      for (const k of c.members) {
        expect(b.complexOf.get(k)).toBe(c.hub);
        if (c.members.length > 1) expect(b.settled(k)).toBe(true);
        if (b.settled(k)) for (const o of b.complexOf.keys()) if (cheb(k, o) <= 2 && b.settled(o)) expect(b.complexOf.get(o)).toBe(c.hub);
      }
      if (c.hub === main || c.isolated) {
        expect(c.parent).toBeNull();
        continue;
      }
      expect(c.members).toContain(c.exit);
      expect(c.path[0]).toBe(c.exit);
      expect(c.path[c.path.length - 1]).toBe(c.entry);
      expect(b.complexOf.get(c.entry)).toBe(c.parent);
      expect(hubDist(c.entry)).toBeLessThan(hubDist(c.hub));
      for (let i = 0; i < c.path.length; i++) {
        const k = c.path[i];
        expect(b.passable(keyX(k), keyY(k))).toBe(true);
        if (i) expect(manhattan(k, c.path[i - 1])).toBe(1);
      }
      expect(b.route(c.hub)).toBe(c.path.length - 1 + b.route(c.entry));
    }
  });

  it('a complex with no path to the main base avoiding Unknown is isolated until a way opens; the path goes around Unknown cells', () => {
    const cfg = makeConfig({} as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    const open = new Set<number>();
    const state = (x: number, y: number) => (econ.owned.has(cellKey(x, y)) ? CellState.Owned : open.has(cellKey(x, y)) ? revealedState(0) : CellState.Unknown);
    const b = new Bases(cfg.bases, econ, state);
    for (let x = 0; x <= 3; x++) open.add(cellKey(x, 0));
    econ.owned.set(cellKey(10, 0), { income: 1, dm: 1, produced: 0 });
    econ.owned.set(cellKey(3, 1), { income: 1, dm: 1, produced: 0 });
    for (let x = 9; x <= 11; x++) open.add(cellKey(x, 1));
    b.recompute(cellKey(0, 0));
    expect(b.isolated.has(cellKey(10, 0))).toBe(true);
    expect(b.info(cellKey(10, 0))!.isolated).toBe(true);
    expect(b.info(cellKey(10, 0))!.multShare).toBe(0);
    expect(b.isolated.has(cellKey(3, 1))).toBe(false);
    expect(econ.baseMult).toBeCloseTo(1 + cfg.econ.multPerBase);

    // A corridor one row down (y = 2) links it; the straight line (y = 0/1) is still Unknown.
    for (let x = 3; x <= 9; x++) open.add(cellKey(x, 2));
    open.add(cellKey(9, 2));
    b.recompute(cellKey(0, 0));
    expect(b.isolated.size).toBe(0);
    const c = b.complexes.get(b.complexOf.get(cellKey(10, 0))!)!;
    expect(b.complexOf.get(c.entry)).toBe(cellKey(3, 1));
    for (const k of c.path) expect(b.passable(keyX(k), keyY(k))).toBe(true);
    expect(c.path.some((k) => keyY(k) === 2)).toBe(true);
    expect(b.route(cellKey(10, 0))).toBe(c.path.length - 1 + b.route(cellKey(3, 1)));
    expect(econ.baseMult).toBeCloseTo(1 + 2 * cfg.econ.multPerBase);
  });

  it('only settled bases join complexes (reach 2 tiles, diagonals too); five or more make a grand complex with a bonus per base', () => {
    const cfg = makeConfig({} as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    const unknown = new Set<number>();
    const state = (x: number, y: number) => (econ.owned.has(cellKey(x, y)) ? CellState.Owned : unknown.has(cellKey(x, y)) ? CellState.Unknown : revealedState(1));
    const b = new Bases(cfg.bases, econ, state);
    const own = (x: number, y: number) => econ.owned.set(cellKey(x, y), { income: 1, dm: 1, produced: 0 });
    own(10, 10);
    own(12, 12); // diagonal, 2 tiles apart
    own(14, 11); // one-tile gap
    own(20, 10); // too far
    b.recompute(cellKey(0, 0));
    const hub = b.complexOf.get(cellKey(10, 10));
    expect(b.complexOf.get(cellKey(12, 12))).toBe(hub);
    expect(b.complexOf.get(cellKey(14, 11))).toBe(hub);
    expect(b.complexOf.get(cellKey(20, 10))).not.toBe(hub);
    expect(b.formed.length).toBe(0); // first rebuild: nothing counts as newly formed

    // An Unknown cell two tiles from a base un-settles it (a number next to it still carries information).
    unknown.add(cellKey(16, 11));
    b.recompute(cellKey(0, 0));
    expect(b.settled(cellKey(14, 11))).toBe(false);
    expect(b.complexOf.get(cellKey(14, 11))).toBe(cellKey(14, 11));
    unknown.clear();

    own(11, 12);
    own(13, 10);
    b.recompute(cellKey(0, 0));
    const c = b.complexes.get(b.complexOf.get(cellKey(10, 10))!)!;
    expect(c.members.length).toBe(5);
    expect(c.grand).toBe(true);
    expect(c.bonus).toBeCloseTo(1 + cfg.bases.grandBonusPerBase * 5);
    expect(b.info(cellKey(10, 10))!.multShare).toBeCloseTo(cfg.econ.multPerBase * c.bonus);
    expect(b.info(cellKey(20, 10))!.multShare).toBeCloseTo(cfg.econ.multPerBase);
    expect(econ.baseMult).toBeCloseTo(1 + cfg.econ.multPerBase * (5 * c.bonus + 1));
    expect(b.info(cellKey(13, 10))!.complexBonus).toBeCloseTo(c.bonus);
    expect(b.formed.length).toBe(1);
    expect(b.formed[0].cx).toBeCloseTo(12.5);
    expect(b.formed[0].cy).toBeCloseTo(11.5);
    // Growing an existing grand complex is not a new one.
    own(15, 12);
    b.recompute(cellKey(0, 0));
    expect(b.formed.length).toBe(0);
    expect(b.complexes.get(b.complexOf.get(cellKey(10, 10))!)!.members.length).toBe(6);
  });

  it('bases next to the main base join the main complex and count at once; time pays nothing', () => {
    const cfg = makeConfig({} as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    const b = new Bases(cfg.bases, econ, (x, y) => (econ.owned.has(cellKey(x, y)) ? CellState.Owned : revealedState(0)));
    econ.owned.set(cellKey(1, 0), { dm: 1 });
    b.recompute(cellKey(0, 0));
    expect(b.complexOf.get(cellKey(1, 0))).toBe(cellKey(0, 0));
    expect(b.route(cellKey(1, 0))).toBe(0);
    expect(econ.baseMult).toBeCloseTo(1 + cfg.econ.multPerBase);
    const c0 = econ.credits;
    b.tick(10);
    expect(econ.credits).toBe(c0);
    expect(econ.unbanked).toBe(0);
    expect(b.shipments.length).toBe(0);
  });

  it('a rebuild is deterministic', () => {
    const g = game(5);
    expect(ownMines(g, 30).length).toBeGreaterThan(10);
    const edges = [...g.bases.edges()];
    const mult = g.econ.baseMult;
    g.bases.recompute(g.bases.main);
    expect(g.econ.baseMult).toBeCloseTo(mult, 9);
    expect([...g.bases.edges()]).toEqual(edges);
  });

  it('every opened cell earns tilePoints x the point multiplier into the pool; time, flags and "?" earn nothing', () => {
    const g = game(5);
    expect(ownMines(g, 20).length).toBeGreaterThan(5);
    const b = g.bases;
    expect(g.econ.baseMult).toBeGreaterThan(1);
    const credits = g.econ.credits;
    let start = g.econ.unbanked;
    let shipped = 0;
    for (let i = 0; i < 50; i++) {
      g.tick(0.1);
      shipped = Math.max(shipped, b.shipments.length);
    }
    // Linked complexes away from the main one keep sending (cosmetic) shipments on their own clocks.
    if ([...b.complexes.values()].some((c) => c.hub !== b.main && c.weight > 0)) expect(shipped).toBeGreaterThan(0);
    // Time alone produces nothing; shipments are only a picture.
    expect(g.econ.unbanked).toBe(start);
    const pick = (ok: (x: number, y: number) => boolean): [number, number] => {
      let at: [number, number] | null = null;
      // Unknown cells on the frontier (forEachCell skips Unknown).
      g.board.forEachCell((x, y, s) => {
        if (at || !isRevealed(s)) return;
        forEachNeighbor(x, y, (nx, ny) => void (!at && g.cellState(nx, ny) === CellState.Unknown && ok(nx, ny) && (at = [nx, ny])));
      });
      return at!;
    };
    const [fx, fy] = pick(() => true);
    // Placing, lifting and cycling flags earn nothing.
    g.toggleFlag(fx, fy);
    g.cycleMark(fx, fy);
    g.cycleMark(fx, fy);
    expect(g.questioned(fx, fy)).toBe(false);
    g.toggleFlag(fx, fy);
    g.toggleFlag(fx, fy);
    expect(g.econ.unbanked).toBe(start);
    // A chord that opens nothing earns nothing either.
    const nums: Array<[number, number]> = [];
    g.board.forEachCell((x, y, s) => void (isRevealed(s) && numberOf(s) > 0 && nums.push([x, y])));
    for (const [nx, ny] of nums) {
      const r = g.chord(nx, ny);
      if (r.revealed || r.hit) break;
      expect(g.econ.unbanked).toBe(start);
    }
    // One reveal pays every cell it opens, x bases x streak (after the click) x prestige.
    const [sx, sy] = pick((x, y) => g.world.truth(x, y) === 0);
    start = g.econ.unbanked;
    const r = g.reveal(sx, sy);
    expect(r.revealed).toBeGreaterThan(0);
    expect(g.econ.unbanked - start).toBeCloseTo(r.revealed * g.cfg.econ.tilePoints * g.econ.pointMult(), 6);
    // Nothing lands in credits until Cash Out.
    expect(g.econ.credits).toBe(credits);
  });

  it('a settlement pays basePoints per new base; the pool never holds more than its capacity', () => {
    const cfg = makeConfig({} as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    econ.baseMult = 2;
    const r = econ.onSettlement([{ key: 1, density: 0.2 }, { key: 2, density: 0.2 }, { key: 3, density: 0.2 }], 0);
    expect(r.payout).toBeCloseTo(3 * cfg.econ.basePoints * 2);
    expect(econ.owned.size).toBe(3);
    econ.capacity = 40;
    expect(econ.gain(100)).toBeCloseTo(10);
    expect(econ.unbanked).toBe(40);
    expect(econ.full()).toBe(true);
    expect(econ.gain(1)).toBe(0);
  });

  it('a full pool blocks openings and chords (not flags) until Cash Out banks it', () => {
    const g = game(3, false, 1000);
    expect(g.econ.capacity).toBe(1000);
    g.econ.unbanked = 1000;
    const credits = g.econ.credits;
    let safe: [number, number] | null = null;
    let flag: [number, number] | null = null;
    g.board.forEachCell((x, y, s) => {
      if (!isRevealed(s)) return;
      forEachNeighbor(x, y, (nx, ny) => {
        if (g.cellState(nx, ny) !== CellState.Unknown) return;
        if (!safe && g.world.truth(nx, ny) === 0) safe = [nx, ny];
        else if (!flag && (!safe || nx !== safe[0] || ny !== safe[1])) flag = [nx, ny];
      });
    });
    const [sx, sy] = safe!;
    const r = g.reveal(sx, sy);
    expect(r.full).toBe(true);
    expect(g.cellState(sx, sy)).toBe(CellState.Unknown);
    expect(g.toggleFlag(flag![0], flag![1])).toBe(true);
    expect(g.cashOut()).toBe(1000);
    expect(g.econ.credits).toBe(credits + 1000);
    expect(g.econ.unbanked).toBe(0);
    expect(g.reveal(sx, sy).full).toBeFalsy();
    expect(g.cellState(sx, sy)).not.toBe(CellState.Unknown);
  });

  it('upgrading the main base raises the pool capacity, costs credits, and survives a save', () => {
    const g = game(3, false, 1000);
    expect(ownMines(g, 8).length).toBeGreaterThan(3);
    const before = g.econ.capacity;
    const cost = g.bases.upgradeCost();
    const credits = g.econ.credits;
    expect(g.upgradeMainBase().ok).toBe(true);
    expect(g.econ.credits).toBeCloseTo(credits - cost);
    expect(g.bases.mainLevel).toBe(2);
    expect(g.econ.capacity).toBeCloseTo(before * g.cfg.econ.storageGrowth);
    expect(g.upgradeMainBase().ok).toBe(true);

    g.tick(5);
    const back = Game.fromSave(structuredClone(g.toSave()));
    expect(back.bases.mainLevel).toBe(3);
    expect(back.econ.capacity).toBeCloseTo(g.econ.capacity);
    expect(back.econ.baseMult).toBeCloseTo(g.econ.baseMult);
    expect(back.econ.credits).toBeCloseTo(g.econ.credits);
  });

  it('no main base (and no upgrade) before the first cell is opened', () => {
    const g = new Game({ seed: 1, fog: { enabled: false }, tiers: { enabled: false } } as never);
    g.econ.credits = 1e9;
    expect(g.bases.main).toBeNull();
    expect(g.upgradeMainBase().reason).toBe('nobase');
  });

  it('the streak cap upgrade applies and survives a save; transport speed is gone', () => {
    const g = game();
    expect(() => g.buy('transport_speed')).toThrow();
    const cap0 = g.econ.cfg.streakMultCap + g.econ.streakCapBonus;
    expect(g.buy('streak_cap').ok).toBe(true);
    expect(g.econ.cfg.streakMultCap + g.econ.streakCapBonus).toBeCloseTo(cap0 + g.cfg.econ.streakCapPerLevel);
    const back = Game.fromSave(structuredClone(g.toSave()));
    expect(back.econ.streakCapBonus).toBeCloseTo(g.econ.streakCapBonus);
  });
});

describe('blasts', () => {
  it('radius range follows the mining tier (the last entry covers higher tiers)', () => {
    const cfg = makeConfig({} as never).blast;
    const ranges = [1, 3, 5, 6].map((t) => blastRange(cfg, t)).map((r) => [r.min, r.max]);
    expect(ranges).toEqual([cfg.radiusByTier[0], cfg.radiusByTier[2], cfg.radiusByTier[4], cfg.radiusByTier[4]]);
    const [lo, hi] = cfg.radiusByTier[2];
    for (let n = 0; n < 50; n++) {
      const r = blastRadius(cfg, 3, 7, n, -n, n);
      expect(r).toBeGreaterThanOrEqual(lo);
      expect(r).toBeLessThanOrEqual(hi);
    }
  });

  it('a hit disables the bases inside the blast (never the main base); they stop counting and leave the network until repaired', () => {
    const g = game(5, true);
    expect(ownMines(g, 20).length).toBeGreaterThan(5);
    const main = g.bases.main!;
    // Step on the Unknown mine with the most bases around it.
    let target: [number, number] | null = null;
    let best = -1;
    const bd = g.board;
    for (let ny = bd.minY - 4; ny <= bd.maxY + 4; ny++) {
      for (let nx = bd.minX - 4; nx <= bd.maxX + 4; nx++) {
        if (g.cellState(nx, ny) !== CellState.Unknown || g.world.truth(nx, ny) !== 1) continue;
        let n = 0;
        for (const k of g.econ.owned.keys()) if (inBlast(keyX(k) - nx, keyY(k) - ny, 3)) n++;
        if (n > best) ((best = n), (target = [nx, ny]));
      }
    }
    expect(target).not.toBeNull();
    const [hx, hy] = target!;
    let blast: { r: number; disabled: number[] } | null = null;
    g.events.on('hit', (h) => (blast = h.blast));
    expect(g.reveal(hx, hy).hit).toBe(true);
    const bl = blast as unknown as { r: number; disabled: number[] };
    const range = g.blastRangeAt(hx, hy);
    expect(bl.r).toBeGreaterThanOrEqual(range.min);
    expect(bl.r).toBeLessThanOrEqual(range.max);
    expect(bl.disabled.length).toBeGreaterThan(0);
    for (const [k, m] of g.econ.owned) expect(m.disabled === true).toBe(inBlast(keyX(k) - hx, keyY(k) - hy, bl.r));

    const b = g.bases;
    expect(b.isBase(main)).toBe(true);
    let sum = 0;
    for (const k of g.econ.owned.keys()) sum += b.info(k)!.multShare;
    expect(g.econ.baseMult).toBeCloseTo(1 + sum);
    for (const k of bl.disabled) {
      expect(b.isBase(k)).toBe(false);
      expect(b.complexOf.has(k)).toBe(false);
      expect(b.info(k)!.multShare).toBe(0);
      expect(b.info(k)!.disabled).toBe(true);
      for (const p of b.edges()) expect(p[0] !== k && p[p.length - 1] !== k).toBe(true);
    }

    // Repairs cost more the more of the world is open, and bring the base back.
    const k = bl.disabled[0];
    const cost = g.repairCost();
    expect(cost).toBe(Math.round(g.cfg.blast.repairCostBase + g.cfg.blast.repairCostPerTile * g.board.revealedCount));
    const credits = g.econ.credits;
    expect(g.repairBase(keyX(k), keyY(k)).ok).toBe(true);
    expect(g.econ.credits).toBeCloseTo(credits - cost);
    expect(g.bases.isBase(k)).toBe(true);
    expect(g.bases.complexOf.has(k)).toBe(true);
    expect(g.repairBase(keyX(k), keyY(k)).reason).toBe('notDisabled');

    // Disabled bases survive a save.
    const back = Game.fromSave(structuredClone(g.toSave()));
    for (const d of bl.disabled.slice(1)) expect(back.bases.isBase(d)).toBe(false);
  });
  it('a blast lifts every flag inside; a flag on a mine goes off in a chain (Exploded) and only the first mine burns funds', () => {
    const g = game(5);
    const bd = g.board;
    // An Unknown mine with another Unknown mine and an Unknown safe cell within 2 tiles.
    let found: { a: [number, number]; b: [number, number]; c: [number, number] } | null = null;
    for (let ny = bd.minY; ny <= bd.maxY && !found; ny++) {
      for (let nx = bd.minX; nx <= bd.maxX && !found; nx++) {
        if (g.cellState(nx, ny) !== CellState.Unknown || g.world.truth(nx, ny) !== 1) continue;
        let b: [number, number] | null = null;
        let c: [number, number] | null = null;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if ((!dx && !dy) || dx * dx + dy * dy > 4 || g.cellState(nx + dx, ny + dy) !== CellState.Unknown) continue;
            if (g.world.truth(nx + dx, ny + dy) === 1) b ??= [nx + dx, ny + dy];
            else c ??= [nx + dx, ny + dy];
          }
        }
        if (b && c) found = { a: [nx, ny], b, c };
      }
    }
    expect(found).not.toBeNull();
    const { a, b, c } = found!;
    g.setFlag(b[0], b[1], true);
    g.setFlag(c[0], c[1], true);
    const hits = g.econ.lifetime.hits;
    let blast: { chain: Array<{ x: number; y: number; r: number }>; cleared: number } | null = null;
    g.events.on('hit', (h) => (blast = h.blast));
    expect(g.reveal(a[0], a[1]).hit).toBe(true);
    expect(g.econ.lifetime.hits).toBe(hits + 1);
    expect(g.cellState(b[0], b[1])).toBe(CellState.Exploded);
    expect(g.cellState(c[0], c[1])).toBe(CellState.Unknown);
    const bl = blast as unknown as { chain: Array<{ x: number; y: number }>; cleared: number };
    expect(bl.chain.some((e) => e.x === b[0] && e.y === b[1])).toBe(true);
    expect(bl.cleared).toBeGreaterThanOrEqual(1);
    expect(g.world.committed(cellKey(b[0], b[1]))).toBe(1);
    expect(g.world.committed(cellKey(c[0], c[1]))).toBe(0);
  });
});
