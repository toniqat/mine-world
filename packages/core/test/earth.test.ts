import { describe, expect, it } from 'vitest';
import { Bases, CellState, Econ, Game, World, cellKey, forEachNeighbor, isKnownMine, isRevealed, keyX, makeConfig, mapMask, numberOf, revealedState, type CellChange } from '../src';

const W = 1440;
const H = 720;
/** Cell of a longitude / latitude on the Earth map (0.25 degrees per cell, column 0 at 180 W, row 0 at 90 N). */
const at = (lon: number, lat: number) => ({ x: Math.floor((lon + 180) * 4), y: Math.floor((90 - lat) * 4) });
/** A row deep in Antarctica: land all the way round, across the seam. */
const POLE_ROW = 708;

function earthGame(extra: Record<string, unknown> = {}): Game {
  return new Game({ seed: 7, fog: { enabled: false }, tiers: { enabled: false }, econ: { storageBase: Infinity }, world: { map: 'earth', uniformDensity: 0.15 }, ...extra } as never);
}

/** Every revealed number equals the mines around it (wrapping), by the world's truth. */
function expectConsistent(g: Game): void {
  let checked = 0;
  g.board.forEachCell((x, y, s) => {
    if (!isRevealed(s)) return;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(W);
    let n = 0;
    forEachNeighbor(x, y, (nx, ny) => {
      const t = g.cellState(nx, ny);
      if (isKnownMine(t)) n++;
      else if (!isRevealed(t)) n += g.world.truth(nx, ny);
    }, g.wrap);
    expect(numberOf(s)).toBe(n);
    checked++;
  });
  expect(checked).toBeGreaterThan(0);
}

describe('Earth map', () => {
  it('decodes the land mask with the continents where they belong', () => {
    const m = mapMask('earth');
    expect(m.w).toBe(W);
    expect(m.h).toBe(H);
    let land = 0;
    for (const v of m.data) land += v;
    expect(land / (W * H)).toBeGreaterThan(0.25);
    expect(land / (W * H)).toBeLessThan(0.4);
    const cell = (p: { x: number; y: number }) => m.data[p.y * W + p.x];
    expect(cell(at(127, 37.5))).toBe(1); // Seoul
    expect(cell(at(10, 23))).toBe(1); // Sahara
    expect(cell(at(-100, 40))).toBe(1); // Kansas
    expect(cell(at(-150, 0))).toBe(0); // Pacific
    expect(cell(at(-30, 30))).toBe(0); // Atlantic
    expect(cell(at(51, 42))).toBe(0); // Caspian Sea
  });

  it('makes water and the rows beyond the map walls from the start, never mines, wrapping east-west', () => {
    const w = new World(makeConfig({ world: { map: 'earth' } } as never).world, 3);
    expect(w.wrap).toBe(W);
    const sea = at(-150, 0);
    expect(w.terrain(sea.x, sea.y)).toBe(CellState.Water);
    expect(w.terrain(10, -1)).toBe(CellState.Water);
    expect(w.terrain(10, H)).toBe(CellState.Water);
    for (let x = -20; x < 20; x++) {
      for (let y = 80; y < 110; y++) {
        expect(w.terrain(x, y)).toBe(w.terrain(x + W, y));
        expect(w.terrain(x, y)).toBe(w.terrain(x - W, y));
      }
    }
    w.setStart(at(127, 37.5).x, at(127, 37.5).y);
    expect(w.truth(sea.x, sea.y)).toBe(0);
    for (let x = 0; x < W; x += 7) expect(w.truth(x, POLE_ROW)).toBe(w.truth(x + W, POLE_ROW));
  });

  it('refuses a main base on water and places it on land, canonical wherever it is clicked', () => {
    const g = earthGame();
    const sea = at(-150, 0);
    g.reveal(sea.x, sea.y);
    expect(g.world.started).toBe(false);
    const seoul = at(127, 37.5);
    g.reveal(seoul.x + W, seoul.y);
    expect(g.world.started).toBe(true);
    expect(g.startCell()).toEqual(seoul);
    expect(g.mainBaseKey()).toBe(cellKey(seoul.x, seoul.y));
  });

  it('opens and counts across the seam', () => {
    const g = earthGame();
    const changes: CellChange[] = [];
    g.events.on('cells', (list) => changes.push(...list));
    // The start area (mine-free) straddles the seam.
    g.reveal(W - 1, POLE_ROW);
    expect(g.cellState(W - 1, POLE_ROW)).toBe(revealedState(0));
    expect(isRevealed(g.cellState(0, POLE_ROW))).toBe(true);
    expect(isRevealed(g.cellState(-1, POLE_ROW))).toBe(true);
    expect(g.cellState(-1, POLE_ROW)).toBe(g.cellState(W - 1, POLE_ROW));
    for (const c of changes) expect(c.x >= 0 && c.x < W).toBe(true);
    // Keep opening safe cells on both sides of the seam; every number stays right.
    for (let i = 0; i < 400; i++) {
      const x = (W - 30 + ((i * 7) % 60)) % W;
      const y = POLE_ROW - 12 + ((i * 13) % 24);
      if (g.cellState(x, y) !== CellState.Unknown || g.world.truth(x, y) === 1) continue;
      g.reveal(x, y);
    }
    expectConsistent(g);
    // A chord across the seam reads its neighbours on the other side.
    let chorded = false;
    g.board.forEachCell((x, y, s) => {
      if (chorded || x !== W - 1 || !isRevealed(s) || numberOf(s) === 0) return;
      let unknown = 0;
      forEachNeighbor(x, y, (nx, ny) => {
        if (g.cellState(nx, ny) !== CellState.Unknown) return;
        unknown++;
        if (g.world.truth(nx, ny) === 1) g.setFlag(nx, ny, true);
      }, g.wrap);
      if (unknown === 0) return;
      chorded = true;
      const r = g.chord(x - W, y);
      expect(r.hit).toBe(false);
    });
    expectConsistent(g);
  });

  it('measures tiers and fog across the seam', () => {
    const g = earthGame({ fog: { enabled: true }, tiers: { enabled: true } });
    g.reveal(W - 2, POLE_ROW);
    expect(g.tierAt(8, POLE_ROW)).toBe(1);
    expect(g.tierAt(W - 2 - 30, POLE_ROW)).toBe(2);
    expect(g.tierAt(30, POLE_ROW)).toBe(2);
    expect(g.fogged(10, POLE_ROW)).toBe(false);
    expect(g.fogged(-6, POLE_ROW)).toBe(g.fogged(W - 6, POLE_ROW));
  });

  it('groups bases into complexes and links them across the seam', () => {
    const cfg = makeConfig({ econ: { storageBase: Infinity } } as never);
    const econ = new Econ(cfg.econ, cfg.world.densityMin);
    const y = 10;
    econ.owned.set(cellKey(1, y), { density: 0.2 } as never);
    econ.owned.set(cellKey(40, y), { density: 0.2 } as never);
    const b = new Bases(cfg.bases, econ, (x, yy) => (econ.owned.has(cellKey(((x % W) + W) % W, yy)) ? CellState.Owned : revealedState(0)), W);
    const main = cellKey(W - 1, y);
    b.recompute(main);
    // Two tiles apart across the seam: one complex.
    expect(b.complexOf.get(cellKey(1, y))).toBe(b.complexOf.get(main));
    // The far base links to it over the seam side, a straight path of 39 steps.
    const far = b.complexes.get(b.complexOf.get(cellKey(40, y))!)!;
    expect(far.isolated).toBe(false);
    expect(far.path.length - 1).toBe(39);
    for (const k of far.path) expect(keyX(k) >= 0 && keyX(k) < W).toBe(true);
  });

  it('round-trips a save', () => {
    const g = earthGame();
    g.reveal(W - 1, POLE_ROW);
    const h = Game.fromSave(structuredClone(g.toSave()));
    expect(h.wrap).toBe(W);
    expect(h.cfg.world.map).toBe('earth');
    for (let x = -20; x < 20; x++) expect(h.cellState(x, POLE_ROW)).toBe(g.cellState(x, POLE_ROW));
    expectConsistent(h);
  });

  it('leaves the endless world unwrapped', () => {
    const g = new Game({ seed: 3, fog: { enabled: false } } as never);
    expect(g.wrap).toBe(0);
    expect(g.wx(-5000)).toBe(-5000);
  });
});
