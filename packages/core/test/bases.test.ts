import { describe, expect, it } from 'vitest';
import { Bases, CellState, Econ, Game, blastRange, blastRadius, cellKey, forEachNeighbor, inBlast, isRevealed, keyX, keyY, makeConfig, manhattan, numberOf, revealedState } from '../src';

function game(seed = 3, strict = false): Game {
  const g = new Game({ seed, world: { uniformDensity: 0.2, riverEnabled: false }, resolve: { interventionMode: strict ? 'STRICT' : 'FAIR' } } as never);
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
  it('the start cell is the main base and produces nothing itself', () => {
    const g = game();
    expect(g.bases.main).toBe(cellKey(0, 0));
    const info = g.baseInfo(0, 0)!;
    expect(info.main).toBe(true);
    expect(info.rate).toBe(0);
    expect(g.econ.incomeRate).toBe(0);
    const c0 = g.econ.credits;
    g.tick(10);
    expect(g.econ.credits).toBe(c0);
  });

  it('settled bases within 2 tiles form a complex; edges avoid Unknown and hop to the nearest complex closer to the main base', () => {
    const g = game();
    expect(ownMines(g, 12).length).toBeGreaterThan(3);
    const b = g.bases;
    const main = b.main!;
    let sum = 0;
    for (const k of g.econ.owned.keys()) sum += b.rates.get(k)!;
    expect(g.econ.incomeRate).toBeCloseTo(sum);
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
    expect(b.rates.get(cellKey(10, 0))).toBe(0);
    expect(b.isolated.has(cellKey(3, 1))).toBe(false);
    expect(econ.incomeRate).toBeCloseTo(1);
    b.tick(30);
    expect(econ.owned.get(cellKey(10, 0))!.produced).toBe(0);

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
    expect(econ.incomeRate).toBeCloseTo(2);
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
    expect(b.rates.get(cellKey(10, 10))).toBeCloseTo(c.bonus);
    expect(b.rates.get(cellKey(20, 10))).toBeCloseTo(1);
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

  it('bases next to the main base join the main complex and pay at once', () => {
    const cfg = makeConfig({} as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    const b = new Bases(cfg.bases, econ, (x, y) => (econ.owned.has(cellKey(x, y)) ? CellState.Owned : revealedState(0)));
    econ.owned.set(cellKey(1, 0), { income: 2, dm: 1, produced: 0 });
    b.recompute(cellKey(0, 0));
    expect(b.complexOf.get(cellKey(1, 0))).toBe(cellKey(0, 0));
    expect(b.route(cellKey(1, 0))).toBe(0);
    const c0 = econ.credits;
    b.tick(1);
    expect(econ.credits - c0).toBeCloseTo(2);
    expect(b.shipments.length).toBe(0);
  });

  it('a rebuild is deterministic', () => {
    const g = game(5);
    expect(ownMines(g, 30).length).toBeGreaterThan(10);
    const edges = [...g.bases.edges()];
    const income = g.econ.incomeRate;
    g.bases.recompute(g.bases.main);
    expect(g.econ.incomeRate).toBeCloseTo(income, 9);
    expect([...g.bases.edges()]).toEqual(edges);
  });

  it('base production reaches credits only after travelling to the main base', () => {
    const g = game(5);
    expect(ownMines(g, 20).length).toBeGreaterThan(5);
    const b = g.bases;
    const far = Math.max(...[...g.econ.owned.keys()].map((k) => b.route(k)));
    let instant = 0;
    for (const k of b.complexes.get(b.main!)!.members) instant += b.rates.get(k) ?? 0;
    const start = g.econ.credits;
    const step = 0.1;
    g.tick(step);
    // The main complex pays at once; other bases have not arrived yet.
    expect(g.econ.credits - start).toBeCloseTo(instant * step);
    const settle = b.cfg.shipInterval + far / b.speed() + 1;
    for (let t = 0; t < settle; t += step) g.tick(step);
    const before = g.econ.credits + b.inTransit();
    for (let i = 0; i < 200; i++) g.tick(step);
    // Steady state: everything produced is either credited or still on its way
    // (relative check: the fixture holds 1e12 credits).
    const want = g.econ.incomeRate * 200 * step;
    expect(Math.abs(g.econ.credits + b.inTransit() - before - want) / want).toBeLessThan(1e-4);
    expect(b.shipments.length).toBeGreaterThan(0);
  });

  it('upgrading the main base raises income, costs credits, and survives a save', () => {
    const g = game();
    expect(ownMines(g, 8).length).toBeGreaterThan(3);
    const before = g.econ.incomeRate;
    const cost = g.bases.upgradeCost();
    const credits = g.econ.credits;
    expect(g.upgradeMainBase().ok).toBe(true);
    expect(g.econ.credits).toBeCloseTo(credits - cost);
    expect(g.bases.mainLevel).toBe(2);
    expect(g.econ.incomeRate).toBeGreaterThan(before);
    expect(g.upgradeMainBase().ok).toBe(true);

    g.tick(5);
    const back = Game.fromSave(structuredClone(g.toSave()));
    expect(back.bases.mainLevel).toBe(3);
    expect(back.econ.incomeRate).toBeCloseTo(g.econ.incomeRate);
    // Undelivered goods are credited on load.
    expect(back.econ.credits).toBeCloseTo(g.econ.credits + g.bases.inTransit());
  });

  it('no main base (and no upgrade) before the first cell is opened', () => {
    const g = new Game({ seed: 1 } as never);
    g.econ.credits = 1e9;
    expect(g.bases.main).toBeNull();
    expect(g.upgradeMainBase().reason).toBe('nobase');
  });

  it('transport speed and streak cap upgrades apply and survive a save', () => {
    const g = game();
    const v0 = g.bases.speed();
    expect(g.buy('transport_speed').ok).toBe(true);
    expect(g.bases.speed()).toBeCloseTo(v0 + g.cfg.bases.transportSpeedPerLevel);
    const cap0 = g.econ.cfg.streakMultCap + g.econ.streakCapBonus;
    expect(g.buy('streak_cap').ok).toBe(true);
    expect(g.econ.cfg.streakMultCap + g.econ.streakCapBonus).toBeCloseTo(cap0 + g.cfg.econ.streakCapPerLevel);
    const back = Game.fromSave(structuredClone(g.toSave()));
    expect(back.bases.speed()).toBeCloseTo(g.bases.speed());
    expect(back.econ.streakCapBonus).toBeCloseTo(g.econ.streakCapBonus);
  });
});

describe('blasts', () => {
  it('radius range: the minimum and the maximum rise in turn every 5 tiles from the main base', () => {
    const cfg = makeConfig({} as never).blast;
    const ranges = [0, 5, 10, 15, 20, 26].map((d) => blastRange(cfg, d)).map((r) => [r.min, r.max]);
    expect(ranges).toEqual([[3, 5], [4, 5], [4, 6], [5, 6], [5, 7], [6, 7]]);
    expect(blastRange(cfg, 4.9).band).toBe(0);
    for (let n = 0; n < 50; n++) {
      const r = blastRadius(cfg, 12, 7, n, -n, n);
      expect(r).toBeGreaterThanOrEqual(4);
      expect(r).toBeLessThanOrEqual(6);
    }
  });

  it('a hit disables the bases inside the blast (never the main base); they stop producing and leave the network until repaired', () => {
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
    for (const k of g.econ.owned.keys()) sum += b.rates.get(k) ?? 0;
    expect(g.econ.incomeRate).toBeCloseTo(sum);
    for (const k of bl.disabled) {
      expect(b.isBase(k)).toBe(false);
      expect(b.complexOf.has(k)).toBe(false);
      expect(b.rates.get(k)).toBe(0);
      expect(b.info(k)!.disabled).toBe(true);
      for (const p of b.edges()) expect(p[0] !== k && p[p.length - 1] !== k).toBe(true);
    }
    const produced = g.econ.owned.get(bl.disabled[0])!.produced;
    g.tick(5);
    expect(g.econ.owned.get(bl.disabled[0])!.produced).toBe(produced);

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
});
