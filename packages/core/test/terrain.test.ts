import { describe, expect, it } from 'vitest';
import {
  ALL_TIERS,
  Bases,
  CellState,
  Econ,
  Game,
  Verdict,
  World,
  cellKey,
  collectRegion,
  constraintFor,
  fairShouldIntervene,
  forEachNeighbor,
  isKnownMine,
  isRevealed,
  isWall,
  keyX,
  keyY,
  makeConfig,
  numberOf,
  revealedState,
  solve,
} from '../src';

/** Lots of terrain close to the start so short plays run into it. */
const ROUGH = { uniformDensity: 0.2, terrainMinRadius: 3, mountainThreshold: 0.55 };

function roughGame(seed = 1): Game {
  return new Game({ seed, fog: { enabled: false }, tiers: { enabled: false }, world: ROUGH, econ: { storageBase: Infinity }, resolve: { interventionMode: 'FAIR' } } as never);
}

/** First non-wall cell next to a wall whose own neighbourhood holds exactly one wall. */
function cellBesideWall(g: Game): { x: number; y: number } {
  for (let y = -30; y <= 30; y++) {
    for (let x = -30; x <= 30; x++) {
      if (g.cellState(x, y) !== CellState.Unknown) continue;
      let walls = 0;
      forEachNeighbor(x, y, (nx, ny) => { if (isWall(g.cellState(nx, ny))) walls++; });
      if (walls === 1) return { x, y };
    }
  }
  throw new Error('no wall near the start');
}

/** A cell with no wall within 2 tiles. */
function cellAwayFromWalls(g: Game): { x: number; y: number } {
  for (let y = -30; y <= 30; y++) {
    for (let x = -30; x <= 30; x++) {
      let clear = true;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (isWall(g.cellState(x + dx, y + dy))) clear = false;
      if (clear && Math.hypot(x, y) > 4) return { x, y };
    }
  }
  throw new Error('no open cell');
}

describe('terrain walls', () => {
  it('appear only once the start is set, never near it, and are never mines', () => {
    const cfg = makeConfig({ world: ROUGH } as never).world;
    const w = new World(cfg, 3);
    for (let y = -40; y <= 40; y += 4) for (let x = -40; x <= 40; x += 4) expect(w.terrain(x, y)).toBe(0);
    w.setStart(5, -2);
    let walls = 0;
    for (let y = -40; y <= 40; y++) {
      for (let x = -40; x <= 40; x++) {
        const t = w.terrain(x, y);
        if (!t) continue;
        walls++;
        expect(Math.hypot(x - 5, y + 2)).toBeGreaterThanOrEqual(cfg.terrainMinRadius);
        expect(w.truth(x, y)).toBe(0);
      }
    }
    expect(walls).toBeGreaterThan(0);
    const off = new World({ ...cfg, terrainEnabled: false }, 3);
    off.setStart(5, -2);
    for (let y = -40; y <= 40; y++) for (let x = -40; x <= 40; x++) expect(off.terrain(x, y)).toBe(0);
  });

  it('cannot be opened or flagged, and count as known safe in constraints', () => {
    const g = roughGame();
    g.reveal(0, 0);
    const { x, y } = cellBesideWall(g);
    let wx = 0, wy = 0, n = 0;
    forEachNeighbor(x, y, (nx, ny) => {
      if (isWall(g.cellState(nx, ny))) { wx = nx; wy = ny; }
      n += g.world.truth(nx, ny);
    });
    expect(g.reveal(wx, wy).revealed).toBe(0);
    g.setFlag(wx, wy, true);
    expect(isWall(g.cellState(wx, wy))).toBe(true);

    g.board.set(x, y, revealedState(n));
    const c = constraintFor(g.ctx, 'public', x, y)!;
    expect(c.cells).not.toContain(cellKey(wx, wy));
    expect(c.cells.length).toBe(7);
    expect(c.n).toBe(n);
  });

  it('FAIR rescues an enclosed pocket but not one pinned against a wall', () => {
    const g = roughGame();
    g.reveal(0, 0);
    const deps = { cfg: g.cfg, ctx: g.ctx, rescues: g.rescues };
    const enclose = (x: number, y: number) =>
      forEachNeighbor(x, y, (nx, ny) => { if (!isWall(g.cellState(nx, ny))) g.board.set(nx, ny, revealedState(0)); });
    const open = cellAwayFromWalls(g);
    enclose(open.x, open.y);
    expect(fairShouldIntervene(deps, open.x, open.y)).toBe(true);
    const walled = cellBesideWall(g);
    enclose(walled.x, walled.y);
    expect(fairShouldIntervene(deps, walled.x, walled.y)).toBe(false);
  });

  it('keeps every revealed number consistent while play runs into walls', () => {
    for (const seed of [1, 2, 3, 4]) {
      const g = roughGame(seed);
      g.reveal(0, 0);
      for (let i = 0; i < 300; i++) {
        const b = g.board;
        const r = solve(collectRegion(g.ctx, 'public', b.minX - 1, b.minY - 1, b.maxX + 1, b.maxY + 1), g.solveOptions(ALL_TIERS));
        let acted = false;
        for (const [k, v] of r.verdicts) {
          if (g.cellState(keyX(k), keyY(k)) !== CellState.Unknown) continue;
          if (v === Verdict.Safe) g.reveal(keyX(k), keyY(k));
          else g.setFlag(keyX(k), keyY(k), true);
          acted = true;
        }
        if (acted) continue;
        const frontier = [...r.undetermined].filter((k) => g.cellState(keyX(k), keyY(k)) === CellState.Unknown);
        if (!frontier.length) break;
        const k = frontier[i % frontier.length];
        g.reveal(keyX(k), keyY(k));
      }
      let walls = 0;
      g.board.forEachCell((x, y, s) => {
        if (!isRevealed(s)) return;
        let n = 0;
        forEachNeighbor(x, y, (nx, ny) => {
          const ns = g.board.get(nx, ny);
          if (isWall(ns)) walls++;
          else if (isKnownMine(ns)) n++;
          else if (!isRevealed(ns)) n += g.world.truth(nx, ny);
        });
        expect(numberOf(s)).toBe(n);
      });
      expect(walls).toBeGreaterThan(0);
    }
  });

  it('bases treat walls as resolved neighbours and network edges cross them like opened cells', () => {
    const cfg = makeConfig({} as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    // Row y = 0 is open from x = 0 to 6 except a mountain at x = 3; everything else in rows -1..1 is a mountain.
    const state = (x: number, y: number) => {
      if (econ.owned.has(cellKey(x, y))) return CellState.Owned;
      if (y === 0 && x >= 0 && x <= 6 && x !== 3) return revealedState(0);
      return Math.abs(y) <= 1 ? CellState.Mountain : CellState.Unknown;
    };
    const b = new Bases(cfg.bases, econ, state);
    econ.owned.set(cellKey(5, 0), { income: 1, dm: 1, produced: 0 });
    b.recompute(cellKey(1, 0));
    expect(b.passable(3, 0)).toBe(true);
    expect(b.settled(cellKey(5, 0))).toBe(true);
    expect(b.isolated.has(cellKey(5, 0))).toBe(false);
    expect(b.complexes.get(cellKey(5, 0))?.path).toContain(cellKey(3, 0));
  });

  it('survives a save round-trip; saves from before terrain stay wall-free', () => {
    const g = roughGame();
    g.reveal(0, 0);
    const wall = cellBesideWall(g);
    const back = Game.fromSave(structuredClone(g.toSave()));
    let wx = 0, wy = 0;
    forEachNeighbor(wall.x, wall.y, (nx, ny) => { if (isWall(g.cellState(nx, ny))) { wx = nx; wy = ny; } });
    expect(back.cellState(wx, wy)).toBe(g.cellState(wx, wy));

    const legacy = structuredClone(g.toSave());
    delete (legacy.cfg.world as { terrainEnabled?: boolean }).terrainEnabled;
    expect(Game.fromSave(legacy).cellState(wx, wy)).toBe(CellState.Unknown);
  });
});
