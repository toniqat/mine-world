import { describe, expect, it } from 'vitest';
import {
  ALL_TIERS,
  CellState,
  Game,
  Verdict,
  World,
  cellKey,
  collectRegion,
  constraintFor,
  countActiveConstraints,
  forEachNeighbor,
  hash01,
  isKnownMine,
  isRevealed,
  keyX,
  keyY,
  numberOf,
  solve,
  type Constraint,
} from '../src';

function uniformGame(density: number, seed = 1, mode: 'STRICT' | 'FAIR' | 'FORGIVING' = 'FAIR'): Game {
  return new Game({ seed, fog: { enabled: false }, tiers: { enabled: false }, world: { uniformDensity: density, terrainEnabled: false }, resolve: { interventionMode: mode } } as never);
}

/** Every revealed number must equal the count of true mines around it. */
function assertConsistent(g: Game): void {
  g.board.forEachCell((x, y, s) => {
    if (!isRevealed(s)) return;
    let n = 0;
    forEachNeighbor(x, y, (nx, ny) => {
      const ns = g.board.get(nx, ny);
      if (isKnownMine(ns)) n++;
      else if (!isRevealed(ns)) n += g.world.truth(nx, ny);
    });
    if (n !== numberOf(s)) throw new Error(`inconsistent number at ${x},${y}: shows ${numberOf(s)}, truth ${n}`);
  });
}

function mulberry(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sound auto-play: apply all verdicts, otherwise reveal a random frontier cell. */
function playRandom(g: Game, steps: number, rng: () => number, wrongFlagChance = 0): void {
  g.reveal(0, 0);
  for (let i = 0; i < steps; i++) {
    const b = g.board;
    const cons = collectRegion(g.ctx, 'public', b.minX - 1, b.minY - 1, b.maxX + 1, b.maxY + 1);
    const r = solve(cons, g.solveOptions(ALL_TIERS));
    let acted = false;
    for (const [k, v] of r.verdicts) {
      const x = keyX(k);
      const y = keyY(k);
      if (g.cellState(x, y) !== CellState.Unknown) continue;
      if (v === Verdict.Safe) g.reveal(x, y);
      else g.setFlag(x, y, true);
      acted = true;
    }
    if (!acted) {
      const frontier = [...r.undetermined].filter((k) => g.cellState(keyX(k), keyY(k)) === CellState.Unknown);
      if (frontier.length === 0) break;
      const k = frontier[Math.floor(rng() * frontier.length)];
      if (rng() < wrongFlagChance) g.setFlag(keyX(k), keyY(k), true);
      else g.reveal(keyX(k), keyY(k));
    }
  }
}

describe('hash / world', () => {
  it('hash01 is uniform-ish and matches density in expectation', () => {
    const seed = 42;
    let mines = 0;
    const N = 200;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (hash01(seed, x, y) < 0.2) mines++;
    expect(mines / (N * N)).toBeGreaterThan(0.18);
    expect(mines / (N * N)).toBeLessThan(0.22);
  });

  it('has no visible correlation between horizontal neighbours', () => {
    const seed = 7;
    let both = 0;
    let first = 0;
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 300; x++) {
        const a = hash01(seed, x, y) < 0.3;
        const b = hash01(seed, x + 1, y) < 0.3;
        if (a) first++;
        if (a && b) both++;
      }
    }
    expect(both / first).toBeGreaterThan(0.27);
    expect(both / first).toBeLessThan(0.33);
  });

  it('INV-4: committed overrides are never rewritten', () => {
    const w = new World({ ...new Game().cfg.world, uniformDensity: 0.2 }, 1);
    w.commit(cellKey(5, 5), 1);
    expect(() => w.commit(cellKey(5, 5), 0)).toThrow(/INV-4/);
    w.commit(cellKey(5, 5), 1);
    expect(w.truth(5, 5)).toBe(1);
  });
});

describe('INV-1: engine constraints never treat flags as mines', () => {
  it('flag stays an unknown cell with n unreduced in engine/public mode', () => {
    const g = uniformGame(0.2, 3);
    g.reveal(0, 0);
    // Find a revealed number and flag one of its unknown neighbours.
    let target: { x: number; y: number; nx: number; ny: number } | null = null;
    g.board.forEachCell((x, y, s) => {
      if (target || !isRevealed(s) || numberOf(s) === 0) return;
      forEachNeighbor(x, y, (nx, ny) => {
        if (!target && g.cellState(nx, ny) === CellState.Unknown) target = { x, y, nx, ny };
      });
    });
    expect(target).not.toBeNull();
    const t = target!;
    const before = constraintFor(g.ctx, 'engine', t.x, t.y)!;
    g.setFlag(t.nx, t.ny, true);
    const engine = constraintFor(g.ctx, 'engine', t.x, t.y)!;
    const belief = constraintFor(g.ctx, 'belief', t.x, t.y);
    expect(engine.cells).toContain(cellKey(t.nx, t.ny));
    expect(engine.n).toBe(before.n);
    if (belief) {
      expect(belief.cells).not.toContain(cellKey(t.nx, t.ny));
      expect(belief.n).toBe(before.n - 1);
    }
  });
});

describe('INV-2: toggling a flag leaks nothing', () => {
  it('observable state differs only by the flag itself', () => {
    const g = uniformGame(0.2, 5);
    g.reveal(0, 0);
    let cell: { x: number; y: number } | null = null;
    g.board.forEachCell((x, y, s) => {
      if (cell || !isRevealed(s) || numberOf(s) === 0) return;
      forEachNeighbor(x, y, (nx, ny) => {
        // Pick an unknown cell that has at least one Unknown neighbour so it cannot close a batch.
        if (cell || g.cellState(nx, ny) !== CellState.Unknown) return;
        let open = 0;
        forEachNeighbor(nx, ny, (ax, ay) => {
          if (g.cellState(ax, ay) === CellState.Unknown) open++;
        });
        if (open > 0) cell = { x: nx, y: ny };
      });
    });
    expect(cell).not.toBeNull();
    const { x, y } = cell!;
    const snap = () => JSON.stringify({ save: { ...g.toSave(), savedAt: 0 }, credits: g.econ.credits });
    const a = snap();
    let events = 0;
    let econ = 0;
    g.events.on('settlement', () => events++);
    g.events.on('econ', () => econ++);
    g.events.on('hit', () => events++);
    g.events.on('log', () => events++);
    // Placing a flag is a turn: the only econ change is base production, which
    // does not depend on the flag (no bases here, so it pays nothing).
    g.toggleFlag(x, y);
    expect(g.cellState(x, y)).toBe(CellState.Flag);
    expect(events).toBe(0);
    expect(econ).toBe(1);
    g.toggleFlag(x, y);
    expect(g.cellState(x, y)).toBe(CellState.Unknown);
    expect(events).toBe(0);
    expect(econ).toBe(1);
    expect(snap()).toBe(a);
  });
});

/** Revealed numbers with their Unknown neighbours, in board order. */
function numbersWithUnknowns(g: Game): Array<{ x: number; y: number; n: number; unknown: Array<[number, number]> }> {
  const out: Array<{ x: number; y: number; n: number; unknown: Array<[number, number]> }> = [];
  g.board.forEachCell((x, y, s) => {
    if (!isRevealed(s) || numberOf(s) === 0) return;
    const unknown: Array<[number, number]> = [];
    forEachNeighbor(x, y, (nx, ny) => void (g.cellState(nx, ny) === CellState.Unknown && unknown.push([nx, ny])));
    if (unknown.length) out.push({ x, y, n: numberOf(s), unknown });
  });
  return out;
}

describe('only openings settle', () => {
  it('flags that seal their numbers wait for the next opening, anywhere', () => {
    const g = uniformGame(0.2, 5);
    g.reveal(0, 0);
    let checked = 0;
    for (const c of numbersWithUnknowns(g)) {
      // Flag every Unknown mine next to the number; count only cases where the next opening settles them.
      const mines = c.unknown.filter(([x, y]) => g.world.truth(x, y) === 1);
      if (!mines.length) continue;
      const trial = Game.fromSave(structuredClone(g.toSave()));
      for (const [x, y] of mines) trial.toggleFlag(x, y);
      const owned = trial.econ.owned.size;
      let settled = 0;
      trial.events.on('settlement', () => settled++);
      for (const [x, y] of mines) trial.toggleFlag(x, y), trial.toggleFlag(x, y);
      expect(settled).toBe(0);
      expect(trial.econ.owned.size).toBe(owned);
      for (const [x, y] of mines) expect(trial.cellState(x, y)).toBe(CellState.Flag);
      // A far safe opening settles whatever became settle-able; it survives a save in between.
      const back = Game.fromSave(structuredClone(trial.toSave()));
      let far: [number, number] | null = null;
      for (const d of numbersWithUnknowns(back).reverse()) {
        const safe = d.unknown.find(([x, y]) => back.world.truth(x, y) === 0 && Math.hypot(x - c.x, y - c.y) > 6);
        if (safe) (far = safe);
        if (far) break;
      }
      if (!far) continue;
      back.reveal(far[0], far[1]);
      if (back.econ.owned.size > owned) {
        expect(mines.some(([x, y]) => back.cellState(x, y) !== CellState.Flag)).toBe(true);
        checked++;
      }
      if (checked >= 3) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('a chord is never rescued: a wrong flag lets the mine go off', () => {
    let checked = 0;
    for (let seed = 1; seed <= 20 && checked < 3; seed++) {
      const g = uniformGame(0.2, seed, 'FORGIVING');
      g.reveal(0, 0);
      for (const c of numbersWithUnknowns(g)) {
        const mine = c.unknown.find(([x, y]) => g.world.truth(x, y) === 1);
        const safe = c.unknown.filter(([x, y]) => g.world.truth(x, y) === 0);
        // A 1 with one mine and at least one safe cell: flag a safe cell (wrong), chord.
        if (c.n !== 1 || !mine || !safe.length) continue;
        let known = 0;
        forEachNeighbor(c.x, c.y, (nx, ny) => void (g.cellState(nx, ny) === CellState.Owned && known++));
        if (known) continue;
        // Opened directly, FORGIVING would move this mine away.
        const direct = Game.fromSave(structuredClone(g.toSave()));
        if (!direct.reveal(mine[0], mine[1]).intervened) continue;
        const chorded = Game.fromSave(structuredClone(g.toSave()));
        chorded.toggleFlag(safe[0][0], safe[0][1]);
        const r = chorded.chord(c.x, c.y);
        expect(r.hit).toBe(true);
        expect(chorded.cellState(mine[0], mine[1])).toBe(CellState.Exploded);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('consistency invariant (T-SETTLE generalised)', () => {
  it('revealed numbers always match the world truth, across seeds and policies', () => {
    for (const mode of ['STRICT', 'FAIR', 'FORGIVING'] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const g = uniformGame(0.2 + (seed % 3) * 0.05, seed, mode);
        playRandom(g, 30, mulberry(seed), 0.15);
        assertConsistent(g);
      }
    }
  });

  it('settled batches are judged by the same truth the numbers were computed from', () => {
    let settlements = 0;
    for (let seed = 100; seed < 112; seed++) {
      const g = uniformGame(0.22, seed);
      g.events.on('settlement', (ev) => {
        settlements++;
        for (const k of ev.cells) {
          const s = g.cellState(keyX(k), keyY(k));
          const t = g.world.truth(keyX(k), keyY(k));
          if (t === 1) expect(s === CellState.Owned || s === CellState.Lost).toBe(true);
          else expect(isRevealed(s)).toBe(true);
        }
      });
      playRandom(g, 40, mulberry(seed), 0.1);
      assertConsistent(g);
    }
    expect(settlements).toBeGreaterThan(20);
  });

  it('FAIR interventions happen and keep numbers valid', () => {
    let interventions = 0;
    for (let seed = 200; seed < 240; seed++) {
      const g = uniformGame(0.25, seed, 'FAIR');
      playRandom(g, 40, mulberry(seed));
      interventions += g.stats.interventions;
      assertConsistent(g);
    }
    expect(interventions).toBeGreaterThan(0);
  });
});

describe('T-SEAL: active constraints scale with perimeter, not area', () => {
  it('a fully opened disc has zero active constraints inside', () => {
    const g = new Game({ seed: 9, fog: { enabled: false }, tiers: { enabled: false }, world: { uniformDensity: 0, startSafeRadius: 3, terrainEnabled: false }, play: { cascadeRadius: 12, cascadeCap: 100000 } } as never);
    g.reveal(0, 0);
    const revealed = g.board.revealedCount;
    expect(revealed).toBeGreaterThan(400);
    expect(countActiveConstraints(g.ctx)).toBe(0);
  });

  it('constraint count grows roughly with sqrt(area) as the bot explores', () => {
    const g = uniformGame(0.15, 11);
    playRandom(g, 15, mulberry(11));
    const c1 = countActiveConstraints(g.ctx);
    const a1 = g.board.revealedCount;
    playRandom(g, 60, mulberry(12));
    const c2 = countActiveConstraints(g.ctx);
    const a2 = g.board.revealedCount;
    expect(a2).toBeGreaterThan(a1 * 2);
    // Perimeter growth is sub-linear in area.
    expect(c2 / c1).toBeLessThan(a2 / a1);
  });
});

/** Probe frontier mines near the start so drones have Owned mines to stand on. */
function ownFrontierMines(g: Game, want = 3): number[] {
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

describe('INV-3: drones never reveal undetermined cells', () => {
  it('drone with correct flags never explodes (its verdicts are sound)', () => {
    const g = uniformGame(0.18, 21);
    g.reveal(0, 0);
    g.econ.credits = 1e9;
    g.equipDrones({ count: 1, tiers: { t1Open: true, t1Flag: true, t2Subset: true, t2Pair: true, t3: true } });
    ownFrontierMines(g);
    let hits = 0;
    g.events.on('hit', (h) => {
      if (h.actor.kind === 'drone') hits++;
    });
    for (let i = 0; i < 400; i++) g.tick(0.5);
    expect(g.drones.drones[0].actions).toBeGreaterThan(20);
    expect(hits).toBe(0);
  });

  it('a planted wrong flag contaminates the drone and the log names the basis (§10 acceptance)', () => {
    let exploded = false;
    for (let seed = 30; seed < 60 && !exploded; seed++) {
      const g = uniformGame(0.2, seed);
      g.reveal(0, 0);
      g.econ.credits = 1e9;
      g.equipDrones({ count: 1, tiers: { t1Open: true, t1Flag: true, t2Subset: true, t2Pair: true, t3: true } });
      ownFrontierMines(g);
      // Plant a wrong flag on a safe frontier cell next to the start.
      let planted: { x: number; y: number } | null = null;
      g.board.forEachCell((x, y, s) => {
        if (planted || !isRevealed(s) || numberOf(s) === 0) return;
        forEachNeighbor(x, y, (nx, ny) => {
          if (!planted && g.cellState(nx, ny) === CellState.Unknown && g.world.truth(nx, ny) === 0) planted = { x: nx, y: ny };
        });
      });
      if (!planted) continue;
      const pl = planted as { x: number; y: number };
      g.setFlag(pl.x, pl.y, true);
      const badKey = cellKey(pl.x, pl.y);
      let entry: { basis: number[] } | null = null;
      g.events.on('log', (e) => {
        if (e.kind === 'drone_explode' && !entry) entry = e.data as { basis: number[] };
      });
      for (let i = 0; i < 600 && !entry; i++) g.tick(0.5);
      if (entry) {
        exploded = true;
        expect((entry as { basis: number[] }).basis.length).toBeGreaterThan(0);
        // The planted flag is either in the basis or was already consumed by a settlement.
        const inBasis = (entry as { basis: number[] }).basis.includes(badKey);
        const consumed = g.cellState(pl.x, pl.y) !== CellState.Flag;
        expect(inBasis || consumed).toBe(true);
        expect(g.drones.drones[0].status).toBe('halted');
      }
    }
    expect(exploded).toBe(true);
  });
});

describe('drone movement (anchor on Owned mines, line, travel)', () => {
  function droneGame(): Game {
    const g = uniformGame(0.18, 21);
    g.reveal(0, 0);
    g.econ.credits = 1e9;
    g.equipDrones({ count: 1, tiers: { t1Open: true, t1Flag: true, t2Subset: true } });
    return g;
  }

  it('waits idle until an Owned mine exists, then stands on one', () => {
    const g = droneGame();
    for (let i = 0; i < 5; i++) g.tick(0.5);
    const d = g.drones.drones[0];
    expect(d.status).toBe('idle');
    expect(d.actions).toBe(0);
    const owned = ownFrontierMines(g);
    g.tick(1.1);
    expect(d.placed).toBe(true);
    expect(owned).toContain(cellKey(d.x, d.y));
  });

  it('extends a line to the target before acting', () => {
    const g = droneGame();
    ownFrontierMines(g);
    g.tick(1.1);
    const d = g.drones.drones[0];
    if (d.status !== 'working') return; // nothing determined around this anchor
    const before = d.actions;
    // Rewind to a fresh plan and advance less than one tile's worth of line.
    g.holdDrone(d.id, false);
    g.tick(0.05);
    expect(d.actions).toBe(before);
    if (d.path && d.path.length > 2) expect(d.phase).toBe('extend');
    for (let i = 0; i < 40; i++) g.tick(0.25);
    expect(d.actions).toBeGreaterThan(before);
  });

  it('only accepts free Owned mines as drop targets, and pauses while held', () => {
    const g = droneGame();
    const owned = ownFrontierMines(g, 2);
    g.tick(1.1);
    const d = g.drones.drones[0];
    expect(g.placeDrone(d.id, 0, 0)).toBe(false);
    const other = owned.find((k) => k !== cellKey(d.x, d.y))!;
    g.holdDrone(d.id, true);
    const acts = d.actions;
    for (let i = 0; i < 20; i++) g.tick(0.5);
    expect(d.actions).toBe(acts);
    expect(g.placeDrone(d.id, keyX(other), keyY(other))).toBe(true);
    expect(d.held).toBe(false);
    expect(cellKey(d.x, d.y)).toBe(other);
  });
});

describe('save / load', () => {
  it('round-trips the full game state', () => {
    const g = uniformGame(0.2, 77);
    playRandom(g, 30, mulberry(77), 0.1);
    g.econ.credits = 5000;
    g.buy('streak_cap');
    g.equipDrones({ count: 1, tiers: { t1Open: true } });
    const data = g.toSave();
    const g2 = Game.fromSave(structuredClone(data));
    expect(g2.board.revealedCount).toBe(g.board.revealedCount);
    expect(g2.board.flagCount).toBe(g.board.flagCount);
    expect(g2.world.overrides.size).toBe(g.world.overrides.size);
    expect(g2.upgrades.level('streak_cap')).toBe(1);
    expect(g2.droneLoadout.count).toBe(1);
    expect(g2.drones.drones.length).toBe(1);
    expect(g2.econ.credits).toBeCloseTo(g.econ.credits, 6);
    assertConsistent(g2);
    // Continue playing on the loaded copy.
    playRandom(g2, 20, mulberry(78));
    assertConsistent(g2);
  });
});

describe('scanner constraints', () => {
  it('scanner count is a truth and joins the solver input', () => {
    const g = uniformGame(0.2, 88);
    g.reveal(0, 0);
    g.econ.credits = 1e6;
    const b = g.board;
    const info = g.useScanner(b.maxX + 1, 0, 2)!;
    expect(info).not.toBeNull();
    let truth = 0;
    for (let y = -2; y <= 2; y++) for (let x = info.cx - 2; x <= info.cx + 2; x++) truth += g.world.truth(x, y);
    expect(info.n).toBe(truth);
    const cons: Constraint[] = collectRegion(g.ctx, 'public', b.minX - 3, b.minY - 3, b.maxX + 3, b.maxY + 3);
    expect(cons.some((c) => c.src < 0)).toBe(true);
  });
});

describe('start area', () => {
  it('the first cell opened becomes the mine-free start, and it survives save / load', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = uniformGame(0.3, seed);
      expect(g.board.revealedCount).toBe(0);
      const r = g.reveal(137, -52);
      expect(r.hit).toBe(false);
      expect(r.revealed).toBeGreaterThan(1);
      expect(g.startCell()).toEqual({ x: 137, y: -52 });
      g.reveal(0, 0);
      expect(g.startCell()).toEqual({ x: 137, y: -52 });
      assertConsistent(g);
      const back = Game.fromSave(structuredClone(g.toSave()));
      expect(back.startCell()).toEqual({ x: 137, y: -52 });
      expect(back.world.started).toBe(true);
    }
  });
});
