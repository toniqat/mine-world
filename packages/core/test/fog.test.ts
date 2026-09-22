import { describe, expect, it } from 'vitest';
import { CellState, Game, cellKey, isRevealed, makeConfig } from '../src';

const FOG = makeConfig({} as never).fog;

function fogGame(seed = 1, density = 0.15): Game {
  return new Game({ seed, tiers: { enabled: false }, world: { uniformDensity: density, terrainEnabled: false }, econ: { storageBase: Infinity }, resolve: { interventionMode: 'FAIR' } } as never);
}

/** Make (x, y) an Owned base directly (bypassing settlement). */
function ownAt(g: Game, x: number, y: number): void {
  g.board.set(x, y, CellState.Owned);
  g.econ.owned.set(cellKey(x, y), { income: 1, dm: 1, produced: 0, disabled: false });
  (g as unknown as { basesDirty: boolean }).basesDirty = true;
}

/** No revealed cell within `openedRadius` (Chebyshev) of (x, y). */
function farFromOpened(g: Game, x: number, y: number): boolean {
  const r = FOG.openedRadius;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (isRevealed(g.cellState(x + dx, y + dy))) return false;
  return true;
}

/** A closed cell on the +x axis beyond `from` that no opened cell sees. */
function unseenOnAxis(g: Game, from: number): number {
  let x = from;
  while (!farFromOpened(g, x, 0) || isRevealed(g.cellState(x, 0))) x++;
  return x;
}

describe('fog of war (T-FOG)', () => {
  it('everything starts fogged; the first click places the main base there anyway and opens the start area', () => {
    const g = fogGame();
    expect(g.fogged(0, 0)).toBe(true);
    expect(g.fogged(100, 100)).toBe(true);
    // Only the placement is allowed on fog: no flags or marks before the start.
    expect(g.toggleFlag(5, 5)).toBe(false);
    g.cycleMark(5, 5);
    expect(g.questioned(5, 5)).toBe(false);
    const lifted: number[] = [];
    g.events.on('fog', (keys) => lifted.push(...keys));
    g.reveal(7, -3);
    expect(g.bases.main).toBe(cellKey(7, -3));
    expect(isRevealed(g.cellState(7, -3))).toBe(true);
    expect(g.fogged(7 + FOG.mainRadius, -3)).toBe(false);
    expect(lifted.length).toBeGreaterThan(100);
  });

  it('every opened cell lifts the fog around it; fogged cells cannot be opened, flagged or chorded into', () => {
    const g = fogGame(2, 0.3);
    g.reveal(0, 0);
    const r = FOG.openedRadius;
    for (let y = -40; y <= 40; y++) for (let x = -40; x <= 40; x++) {
      if (!isRevealed(g.cellState(x, y))) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) expect(g.fog.isSeen(x + dx, y + dy)).toBe(true);
    }
    const far = unseenOnAxis(g, FOG.mainRadius + 1);
    expect(g.fogged(far, 0)).toBe(true);
    expect(g.reveal(far, 0).revealed).toBe(0);
    expect(g.cellState(far, 0)).toBe(CellState.Unknown);
    expect(g.toggleFlag(far, 0)).toBe(false);
    expect(g.cellState(far, 0)).toBe(CellState.Unknown);
  });

  it('opening a cell at the edge of vision lifts the fog two tiles further', () => {
    const g = fogGame(3, 0.3);
    g.reveal(0, 0);
    // A safe seen cell next to fog.
    let hit: [number, number] | null = null;
    for (let y = -FOG.mainRadius; y <= FOG.mainRadius && !hit; y++) for (let x = 0; x <= FOG.mainRadius + 2 && !hit; x++) {
      if (g.cellState(x, y) === CellState.Unknown && !g.fogged(x, y) && g.fogged(x + 1, y) && g.world.truth(x, y) === 0) hit = [x, y];
    }
    expect(hit).not.toBeNull();
    const [hx, hy] = hit!;
    g.reveal(hx, hy);
    for (let d = 1; d <= FOG.openedRadius; d++) expect(g.fogged(hx + d, hy)).toBe(false);
  });

  it('the main base sees its radius at once and never grows', () => {
    const g = fogGame(1, 0.3);
    g.reveal(0, 0);
    expect(g.fogged(FOG.mainRadius, 0) && g.cellState(FOG.mainRadius, 0) === CellState.Unknown).toBe(false);
    const far = unseenOnAxis(g, FOG.mainRadius + 1);
    for (let i = 0; i < 20; i++) g.tick(30);
    expect(g.fogged(far, 0)).toBe(true);
  });

  it('a new base sees its full radius at once; nothing grows it', () => {
    const g = fogGame();
    g.reveal(0, 0);
    const bx = 60;
    ownAt(g, bx, 0);
    g.tick(0.001);
    expect(g.fogged(bx + FOG.baseRadius, 0)).toBe(false);
    expect(g.fogged(bx + FOG.baseRadius + 1, 0)).toBe(true);
    g.tick(600);
    expect(g.fogged(bx + FOG.baseRadius + 1, 0)).toBe(true);
  });

  it('"?" marks cycle with flags, do nothing, and vanish when the cell opens', () => {
    const g = fogGame();
    g.reveal(0, 0);
    let x = 0;
    while (g.cellState(x, 0) !== CellState.Unknown) x++;
    g.cycleMark(x, 0);
    expect(g.cellState(x, 0)).toBe(CellState.Flag);
    g.cycleMark(x, 0);
    expect(g.cellState(x, 0)).toBe(CellState.Unknown);
    expect(g.questioned(x, 0)).toBe(true);
    const back = Game.fromSave(structuredClone(g.toSave()));
    expect(back.questioned(x, 0)).toBe(true);
    g.cycleMark(x, 0);
    expect(g.questioned(x, 0)).toBe(false);
    expect(g.cellState(x, 0)).toBe(CellState.Unknown);
    g.cycleMark(x, 0);
    g.cycleMark(x, 0);
    g.reveal(x, 0);
    expect(g.questioned(x, 0)).toBe(false);
  });

  it('survives a save round-trip (rebuilt from bases and opened cells)', () => {
    const g = fogGame(4, 0.3);
    g.reveal(0, 0);
    ownAt(g, 40, 0);
    g.tick(0.001);
    const h = Game.fromSave(structuredClone(g.toSave()));
    for (let y = -30; y <= 30; y++) for (let x = -30; x <= 55; x++) expect(h.fogged(x, y)).toBe(g.fogged(x, y));
  });
});
