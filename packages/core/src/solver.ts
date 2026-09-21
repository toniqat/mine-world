import type { Constraint } from './csp';

/**
 * Solver tiers (spec §4.3, §4.4). Pure function of a constraint list.
 *
 *   T1a (open)     single constraint, n = 0 -> all safe
 *   T1b (flag)     single constraint, n = |S| -> all mines
 *   T2a (subset)   S1 subset of S2 -> derive (S2 minus S1, n2 - n1), chained to a fixpoint
 *   T2b (pairwise) for overlapping constraints A, B bound the mines in the
 *                  intersection and read off direct verdicts. Covers 1-2-1 and
 *                  1-2-2-1 in one step but does not chain through derived
 *                  sub-constraints (that is what enumeration buys).
 *   T3  (enum)     full enumeration of components up to t3MaxCells
 *   T4  (prob)     enumeration up to t4MaxCells with density-weighted probabilities
 *
 * The spec's T1/T2 are split in two each because Phase 0 showed T1 alone
 * producing 70-93% of all verdicts (packages/sim/results/phase0.md).
 *
 * Soundness: every verdict holds in all assignments satisfying the given
 * constraints. Passing a subset of the real constraints can only lose
 * verdicts, never invent wrong ones. (Contradictory input, e.g. wrong flags in
 * belief mode, is reported via `contradiction` and can yield anything.)
 */
export const Verdict = { Undetermined: 0, Safe: 1, Mine: 2 } as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface TierSet {
  t1Open: boolean;
  t1Flag: boolean;
  t2Subset: boolean;
  t2Pair: boolean;
  t3: boolean;
  t4: boolean;
}
export const ALL_TIERS: TierSet = { t1Open: true, t1Flag: true, t2Subset: true, t2Pair: true, t3: true, t4: true };
export const NO_TIERS: TierSet = { t1Open: false, t1Flag: false, t2Subset: false, t2Pair: false, t3: false, t4: false };
/** Tier ids as reported in SolveResult.tier, in ladder order. */
export const TIER_IDS = ['t1Open', 't1Flag', 't2Subset', 't2Pair', 't3', 't4'] as const;
export type TierId = (typeof TIER_IDS)[number];
export const TIER_LABELS: Record<TierId, string> = { t1Open: 'T1a', t1Flag: 'T1b', t2Subset: 'T2a', t2Pair: 'T2b', t3: 'T3', t4: 'T4' };

export interface SolveOptions {
  tiers: TierSet;
  t3MaxCells: number;
  t4MaxCells: number;
  solutionCap: number;
  nodeBudget: number;
  /** Prior mine probability per cell key (base density). Defaults to 0.5. */
  prior?: (key: number) => number;
}

/** One connected component of the *input* constraint graph. */
export interface ComponentReport {
  cells: number[];
  size: number;
  /** Cells of this component that ended up without a verdict. */
  undetermined: number;
  /** True when every undetermined cell of this component was fully enumerated (so probabilities exist). */
  enumerated: boolean;
}

export interface SolveResult {
  verdicts: Map<number, Verdict>;
  /** Tier that produced each verdict. */
  tier: Map<number, TierId>;
  /** P(mine) for undetermined cells of enumerated components (T4 only). */
  probabilities: Map<number, number>;
  /** Frontier cells with no verdict. */
  undetermined: Set<number>;
  components: ComponentReport[];
  contradiction: boolean;
}

interface C {
  cells: number[];
  n: number;
}

function sig(c: C): string {
  return c.cells.join(',') + '|' + c.n;
}

export function solve(input: Constraint[], opts: SolveOptions): SolveResult {
  const known = new Map<number, 0 | 1>();
  const verdicts = new Map<number, Verdict>();
  const tier = new Map<number, TierId>();
  const probabilities = new Map<number, number>();
  const undetermined = new Set<number>();
  const components: ComponentReport[] = [];
  let contradiction = false;

  let cons: C[] = [];
  {
    const seen = new Set<string>();
    for (const c of input) {
      if (c.cells.length === 0) continue;
      const cells = [...c.cells].sort((a, b) => a - b);
      const cc = { cells, n: c.n };
      const s = sig(cc);
      if (seen.has(s)) continue;
      seen.add(s);
      cons.push(cc);
    }
  }

  const setKnown = (k: number, v: 0 | 1, t: TierId): boolean => {
    const prev = known.get(k);
    if (prev !== undefined) {
      if (prev !== v) contradiction = true;
      return false;
    }
    known.set(k, v);
    verdicts.set(k, v ? Verdict.Mine : Verdict.Safe);
    tier.set(k, t);
    return true;
  };

  const propagate = (tiers: TierSet): void => {
    const usePair = tiers.t2Subset || tiers.t2Pair;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 100000) {
      changed = false;
      // Simplify against known cells, dedupe.
      const next: C[] = [];
      const sigs = new Set<string>();
      for (const c of cons) {
        let cells = c.cells;
        let n = c.n;
        let dirty = false;
        for (const k of cells) {
          if (known.has(k)) {
            dirty = true;
            break;
          }
        }
        if (dirty) {
          cells = [];
          n = c.n;
          for (const k of c.cells) {
            const v = known.get(k);
            if (v === undefined) cells.push(k);
            else n -= v;
          }
        }
        if (cells.length === 0) {
          if (n !== 0) contradiction = true;
          continue;
        }
        if (n < 0 || n > cells.length) {
          contradiction = true;
          continue;
        }
        const cc = { cells, n };
        const s = sig(cc);
        if (sigs.has(s)) continue;
        sigs.add(s);
        next.push(cc);
      }
      cons = next;

      // T1
      for (const c of cons) {
        if (c.n === 0) {
          if (tiers.t1Open) for (const k of c.cells) if (setKnown(k, 0, 't1Open')) changed = true;
        } else if (c.n === c.cells.length) {
          if (tiers.t1Flag) for (const k of c.cells) if (setKnown(k, 1, 't1Flag')) changed = true;
        }
      }
      if (changed) continue;
      if (!usePair) break;

      // T2 pairwise reasoning over constraints that share cells.
      const index = new Map<number, number[]>();
      for (let i = 0; i < cons.length; i++) {
        for (const k of cons[i].cells) {
          let l = index.get(k);
          if (!l) index.set(k, (l = []));
          l.push(i);
        }
      }
      const derived: C[] = [];
      for (let i = 0; i < cons.length; i++) {
        const a = cons[i];
        const partners = new Set<number>();
        for (const k of a.cells) for (const j of index.get(k)!) if (j > i) partners.add(j);
        if (partners.size === 0) continue;
        const aset = new Set(a.cells);
        for (const j of partners) {
          const b = cons[j];
          const bset = new Set(b.cells);
          const I: number[] = [];
          const A: number[] = [];
          const B: number[] = [];
          for (const k of a.cells) (bset.has(k) ? I : A).push(k);
          for (const k of b.cells) if (!aset.has(k)) B.push(k);
          const subset = A.length === 0 || B.length === 0;
          if (!subset && !tiers.t2Pair) continue;
          const t: TierId = subset ? 't2Subset' : 't2Pair';
          const lo = Math.max(0, a.n - A.length, b.n - B.length);
          const hi = Math.min(I.length, a.n, b.n);
          if (lo > hi) {
            contradiction = true;
            continue;
          }
          // Mines in A lie in [a.n - hi, a.n - lo]; in B in [b.n - hi, b.n - lo].
          if (A.length) {
            if (a.n - hi === A.length) {
              for (const k of A) if (setKnown(k, 1, t)) changed = true;
            } else if (a.n - lo === 0) {
              for (const k of A) if (setKnown(k, 0, t)) changed = true;
            } else if (subset && lo === hi) {
              derived.push({ cells: A, n: a.n - lo });
            }
          }
          if (B.length) {
            if (b.n - hi === B.length) {
              for (const k of B) if (setKnown(k, 1, t)) changed = true;
            } else if (b.n - lo === 0) {
              for (const k of B) if (setKnown(k, 0, t)) changed = true;
            } else if (subset && lo === hi) {
              derived.push({ cells: B, n: b.n - lo });
            }
          }
        }
      }
      if (changed) continue;
      if (derived.length) {
        const sigs2 = new Set(cons.map(sig));
        for (const d of derived) {
          const s = sig(d);
          if (sigs2.has(s)) continue;
          sigs2.add(s);
          cons.push(d);
          changed = true;
        }
      }
    }
  };

  // Components of the original constraint graph (for reporting / triage).
  const originalGroups = group(cons);

  // Propagation ladder: T1 alone first so its verdicts are attributed to T1, then with T2.
  const t1 = { ...NO_TIERS, t1Open: opts.tiers.t1Open, t1Flag: opts.tiers.t1Flag };
  if (t1.t1Open || t1.t1Flag) propagate(t1);
  if (opts.tiers.t2Subset || opts.tiers.t2Pair) propagate({ ...t1, t2Subset: opts.tiers.t2Subset, t2Pair: opts.tiers.t2Pair });

  // Remaining constraints -> sub-components, enumerated when small enough.
  const maxEnum = opts.tiers.t4 ? opts.t4MaxCells : opts.tiers.t3 ? opts.t3MaxCells : 0;
  const prior = opts.prior ?? (() => 0.5);
  const enumeratedCells = new Set<number>();

  for (const g of group(cons).values()) {
    const size = g.cells.length;
    let done = false;
    if (size <= maxEnum) {
      const r = enumerate(g.cells, g.cons, opts.solutionCap, opts.nodeBudget, prior);
      if (r) {
        done = true;
        const t: TierId = opts.tiers.t3 && size <= opts.t3MaxCells ? 't3' : 't4';
        if (r.count === 0) {
          contradiction = true;
          for (const k of g.cells) undetermined.add(k);
        } else {
          for (let i = 0; i < size; i++) {
            const k = r.cells[i];
            enumeratedCells.add(k);
            if (r.mineCount[i] === 0) setKnown(k, 0, t);
            else if (r.mineCount[i] === r.count) setKnown(k, 1, t);
            else {
              undetermined.add(k);
              if (opts.tiers.t4) probabilities.set(k, r.mineWeight[i] / r.totalWeight);
            }
          }
        }
      }
    }
    if (!done) for (const k of g.cells) undetermined.add(k);
  }

  for (const g of originalGroups.values()) {
    let und = 0;
    let enumerated = true;
    for (const k of g.cells) {
      if (undetermined.has(k)) {
        und++;
        if (!enumeratedCells.has(k)) enumerated = false;
      }
    }
    components.push({ cells: g.cells, size: g.cells.length, undetermined: und, enumerated });
  }

  return { verdicts, tier, probabilities, undetermined, components, contradiction };
}

/** Union-find grouping of constraints into connected components. */
function group(cons: C[]): Map<number, { cells: number[]; cons: C[] }> {
  const parent = new Map<number, number>();
  const find = (k: number): number => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = k;
    while (parent.get(c) !== r) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const c of cons) {
    for (const k of c.cells) if (!parent.has(k)) parent.set(k, k);
    const r0 = find(c.cells[0]);
    for (let i = 1; i < c.cells.length; i++) parent.set(find(c.cells[i]), r0);
  }
  const groups = new Map<number, { cells: number[]; cons: C[] }>();
  for (const k of parent.keys()) {
    const r = find(k);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { cells: [], cons: [] }));
    g.cells.push(k);
  }
  for (const c of cons) groups.get(find(c.cells[0]))!.cons.push(c);
  return groups;
}

export interface EnumResult {
  /** Cells in enumeration order (matches indices of the arrays below). */
  cells: number[];
  count: number;
  totalWeight: number;
  mineWeight: Float64Array;
  mineCount: Float64Array;
}

/**
 * Enumerate all assignments of `cells` satisfying `cons`. Returns null when
 * the solution cap or node budget is exceeded. `onSolution` receives each
 * assignment, its prior weight and the cell order the assignment is indexed by.
 */
export function enumerate(
  cellsIn: number[],
  cons: C[],
  solutionCap: number,
  nodeBudget: number,
  prior: (key: number) => number,
  onSolution?: (assign: Uint8Array, weight: number, cells: number[]) => void,
): EnumResult | null {
  // Order cells by BFS over the constraint graph for early pruning.
  const idxIn = new Map<number, number>();
  cellsIn.forEach((k, i) => idxIn.set(k, i));
  const consOfCell: number[][] = cellsIn.map(() => []);
  cons.forEach((c, ci) => {
    for (const k of c.cells) {
      const i = idxIn.get(k);
      if (i !== undefined) consOfCell[i].push(ci);
    }
  });
  const order: number[] = [];
  const seen = new Uint8Array(cellsIn.length);
  for (let start = 0; start < cellsIn.length; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      order.push(i);
      for (const ci of consOfCell[i]) {
        for (const k of cons[ci].cells) {
          const j = idxIn.get(k);
          if (j !== undefined && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
    }
  }
  const cells = order.map((i) => cellsIn[i]);
  const n = cells.length;
  const idx = new Map<number, number>();
  cells.forEach((k, i) => idx.set(k, i));
  const cellCons: number[][] = cells.map(() => []);
  const conNeed = new Int32Array(cons.length);
  const conMines = new Int32Array(cons.length);
  const conRem = new Int32Array(cons.length);
  cons.forEach((c, ci) => {
    conNeed[ci] = c.n;
    let cnt = 0;
    for (const k of c.cells) {
      const i = idx.get(k);
      if (i !== undefined) {
        cellCons[i].push(ci);
        cnt++;
      }
    }
    conRem[ci] = cnt;
  });
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = prior(cells[i]);
    p[i] = v < 0.01 ? 0.01 : v > 0.99 ? 0.99 : v;
  }

  const assign = new Uint8Array(n);
  const mineWeight = new Float64Array(n);
  const mineCount = new Float64Array(n);
  let totalWeight = 0;
  let count = 0;
  let nodes = 0;
  let aborted = false;

  const rec = (i: number, w: number): void => {
    if (aborted) return;
    if (++nodes > nodeBudget) {
      aborted = true;
      return;
    }
    if (i === n) {
      count++;
      if (count > solutionCap) {
        aborted = true;
        return;
      }
      totalWeight += w;
      for (let j = 0; j < n; j++) {
        if (assign[j]) {
          mineWeight[j] += w;
          mineCount[j]++;
        }
      }
      if (onSolution) onSolution(assign, w, cells);
      return;
    }
    const cs = cellCons[i];
    for (let v = 0; v <= 1; v++) {
      let ok = true;
      for (let a = 0; a < cs.length; a++) {
        const ci = cs[a];
        const m = conMines[ci] + v;
        const r = conRem[ci] - 1;
        if (m > conNeed[ci] || m + r < conNeed[ci]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let a = 0; a < cs.length; a++) {
        conMines[cs[a]] += v;
        conRem[cs[a]]--;
      }
      assign[i] = v;
      rec(i + 1, w * (v ? p[i] : 1 - p[i]));
      for (let a = 0; a < cs.length; a++) {
        conMines[cs[a]] -= v;
        conRem[cs[a]]++;
      }
      if (aborted) return;
    }
  };
  rec(0, 1);
  if (aborted) return null;
  return { cells, count, totalWeight, mineWeight, mineCount };
}
