import { CellState, isKnownMine, isRevealed } from './board';
import type { GameConfig } from './config';
import { collectComponent, type CspContext } from './csp';
import { cellKey, forEachNeighbor, keyX, keyY } from './key';
import { enumerate } from './solver';

/**
 * Lazy resolution (spec §5).
 *
 * The world's `truth()` is always a consistent assignment, so the only
 * question when a player opens a cell whose truth is 1 is whether the engine
 * is allowed to *move* that mine. It may do so only when
 *   - the cell is part of a constraint component (not a blind guess),
 *   - the component is small enough to enumerate,
 *   - at least one solution of the component has the cell safe (i.e. the cell
 *     was genuinely undecidable, INV-5), and
 *   - the intervention policy agrees (§5.2).
 * Then the whole component is committed to the alternative solution closest
 * to the current truth, which keeps every revealed number valid.
 */
export interface ResolveDeps {
  cfg: GameConfig;
  ctx: CspContext;
  rescues: { left: number };
}

export interface ResolveOutcome {
  truth: 0 | 1;
  intervened: boolean;
  /** Net mines removed from the world by this intervention (added to density debt). */
  movedMines: number;
}

const KEEP = (truth: 0 | 1): ResolveOutcome => ({ truth, intervened: false, movedMines: 0 });

export function resolveReveal(d: ResolveDeps, x: number, y: number): ResolveOutcome {
  const { world, board } = d.ctx;
  const key = cellKey(x, y);
  const committed = world.committed(key);
  if (committed !== undefined) return KEEP(committed);

  // Base-layer truth is stateless and stable, so a safe reveal needs no override (§3.2 keeps overrides sparse).
  const base = world.truth(x, y);
  if (base === 0) return KEEP(0);

  const mode = d.cfg.resolve.interventionMode;
  if (mode === 'STRICT') {
    world.commit(key, 1);
    return KEEP(1);
  }

  const comp = collectComponent(d.ctx, 'engine', [key], d.cfg.solver.t4MaxCells + 1);
  if (comp.constraints.length === 0 || comp.capped || comp.cells.size > d.cfg.solver.t4MaxCells) {
    world.commit(key, 1);
    return KEEP(1);
  }

  let useRescue = false;
  let want: boolean;
  if (mode === 'FORGIVING' && d.rescues.left > 0) {
    want = true;
    useRescue = true;
  } else {
    want = fairShouldIntervene(d, x, y);
  }
  if (!want) {
    world.commit(key, 1);
    return KEEP(1);
  }

  const cells = [...comp.cells];
  const witness = new Map<number, 0 | 1>();
  const flagged = new Set<number>();
  for (const k of cells) {
    const kx = keyX(k);
    const ky = keyY(k);
    witness.set(k, world.truth(kx, ky));
    if (board.get(kx, ky) === CellState.Flag) flagged.add(k);
  }
  const prior = (k: number) => world.density(keyX(k), keyY(k));

  let best: { assign: Uint8Array; cost: number; weight: number } | null = null;
  let order: number[] = [];
  const res = enumerate(
    cells,
    comp.constraints,
    d.cfg.solver.solutionCap,
    d.cfg.solver.nodeBudget,
    prior,
    (assign, w, ordered) => {
      if (order.length === 0) order = ordered;
      const target = ordered.indexOf(key);
      if (assign[target] !== 0) return;
      // Prefer the solution that changes the fewest cells; flagged cells count triple.
      let cost = 0;
      for (let i = 0; i < assign.length; i++) {
        const k = ordered[i];
        if (assign[i] !== witness.get(k)) cost += flagged.has(k) ? 3 : 1;
      }
      if (!best || cost < best.cost || (cost === best.cost && w > best.weight)) {
        best = { assign: new Uint8Array(assign), cost, weight: w };
      }
    },
  );

  const chosen = best as { assign: Uint8Array; cost: number; weight: number } | null;
  if (!res || !chosen) {
    world.commit(key, 1);
    return KEEP(1);
  }

  let before = 0;
  let after = 0;
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const v = chosen.assign[i] as 0 | 1;
    before += witness.get(k)!;
    after += v;
    world.commit(k, v);
  }
  world.densityDebt += before - after;
  world.interventions++;
  if (useRescue) d.rescues.left--;
  return { truth: 0, intervened: true, movedMines: before - after };
}

/**
 * FAIR policy (§5.2): intervene only if the safe unknown region adjacent to
 * the cell is enclosed (flood fill stays below `escapeCap`). An open region
 * means the player could have approached from elsewhere.
 */
export function fairShouldIntervene(d: ResolveDeps, x: number, y: number): boolean {
  const { board, world } = d.ctx;
  const cap = d.cfg.resolve.escapeCap;
  const visited = new Set<number>();
  const queue: number[] = [];
  const passable = (px: number, py: number): boolean => {
    const s = board.get(px, py);
    if (isRevealed(s) || isKnownMine(s)) return false;
    return world.truth(px, py) === 0;
  };
  forEachNeighbor(x, y, (nx, ny) => {
    const k = cellKey(nx, ny);
    if (!visited.has(k) && passable(nx, ny)) {
      visited.add(k);
      queue.push(k);
    }
  });
  while (queue.length) {
    if (visited.size >= cap) return false;
    const k = queue.pop()!;
    forEachNeighbor(keyX(k), keyY(k), (nx, ny) => {
      const nk = cellKey(nx, ny);
      if (visited.has(nk) || !passable(nx, ny)) return;
      visited.add(nk);
      queue.push(nk);
    });
  }
  return true;
}
