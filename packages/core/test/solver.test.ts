import { describe, expect, it } from 'vitest';
import { ALL_TIERS, NO_TIERS, Verdict, cellKey, solve, type Constraint, type SolveOptions, type TierSet } from '../src';

const opts = (tiers: TierSet = ALL_TIERS, prior?: (k: number) => number): SolveOptions => ({
  tiers,
  t3MaxCells: 24,
  t4MaxCells: 48,
  solutionCap: 100000,
  nodeBudget: 1000000,
  prior,
});
const k = (x: number, y: number) => cellKey(x, y);
const c = (cells: number[], n: number): Constraint => ({ cells, n, src: 0 });

describe('solver tiers (T-SOLVE)', () => {
  it('T1 resolves trivial constraints', () => {
    const r = solve([c([k(0, 0), k(1, 0)], 0), c([k(2, 0), k(3, 0)], 2)], opts({ ...NO_TIERS, t1Open: true, t1Flag: true }));
    expect(r.verdicts.get(k(0, 0))).toBe(Verdict.Safe);
    expect(r.verdicts.get(k(3, 0))).toBe(Verdict.Mine);
    expect(r.tier.get(k(0, 0))).toBe('t1Open');
    expect(r.tier.get(k(3, 0))).toBe('t1Flag');
  });

  it('T2 solves the 1-2-1 pattern, T1 alone does not', () => {
    // Row above a wall: cells a b c d e; numbers 1 2 1 below b c d.
    const a = k(0, 0), b = k(1, 0), cc = k(2, 0), d = k(3, 0), e = k(4, 0);
    const cons = [c([a, b, cc], 1), c([b, cc, d], 2), c([cc, d, e], 1)];
    const r1 = solve(cons, opts({ ...NO_TIERS, t1Open: true, t1Flag: true }));
    expect(r1.verdicts.size).toBe(0);
    const r2 = solve(cons, opts({ ...NO_TIERS, t1Open: true, t1Flag: true, t2Subset: true, t2Pair: true }));
    expect(r2.verdicts.get(b)).toBe(Verdict.Mine);
    expect(r2.verdicts.get(d)).toBe(Verdict.Mine);
    expect(r2.verdicts.get(cc)).toBe(Verdict.Safe);
    expect(r2.tier.get(b)).toBe('t2Pair');
    // Subset rule alone cannot solve 1-2-1.
    const r3 = solve(cons, opts({ ...NO_TIERS, t1Open: true, t1Flag: true, t2Subset: true }));
    expect(r3.verdicts.size).toBe(0);
  });

  it('wall 1-1 stays undetermined (genuinely ambiguous)', () => {
    const a = k(0, 0), b = k(1, 0);
    const r = solve([c([a, b], 1)], opts());
    expect(r.verdicts.size).toBe(0);
    expect(r.undetermined.has(a)).toBe(true);
    expect(r.probabilities.get(a)).toBeCloseTo(0.5, 6);
  });

  it('T3 enumeration finds verdicts T2 misses', () => {
    // Three cells, two constraints: {a,b}=1, {b,c}=1, {a,c}=... none -> ambiguous.
    // Add {a,b,c}=1 -> only b can be the mine.
    const a = k(0, 0), b = k(1, 0), cc = k(2, 0);
    const cons = [c([a, b], 1), c([b, cc], 1), c([a, b, cc], 1)];
    const r = solve(cons, opts());
    expect(r.verdicts.get(b)).toBe(Verdict.Mine);
    expect(r.verdicts.get(a)).toBe(Verdict.Safe);
    expect(r.verdicts.get(cc)).toBe(Verdict.Safe);
  });
});

describe('INV-5: probabilities are solution-count based, not 50/50', () => {
  it('yields 1/3 and 2/3 with a uniform prior', () => {
    // {a,b}=1 and {b,c,d}=1: b=1 -> 1 solution; b=0 -> a=1 and one of c,d -> 2 solutions.
    const a = k(0, 0), b = k(1, 0), cc = k(2, 0), d = k(3, 0);
    const r = solve([c([a, b], 1), c([b, cc, d], 1)], opts(ALL_TIERS, () => 0.5));
    expect(r.probabilities.get(b)).toBeCloseTo(1 / 3, 6);
    expect(r.probabilities.get(a)).toBeCloseTo(2 / 3, 6);
    expect(r.probabilities.get(cc)).toBeCloseTo(1 / 3, 6);
  });

  it('density prior shifts the weights (Bayesian, §4.4)', () => {
    const a = k(0, 0), b = k(1, 0);
    const r = solve([c([a, b], 1)], opts(ALL_TIERS, (key) => (key === a ? 0.1 : 0.4)));
    // P(a mine) ∝ 0.1*0.6 = 0.06, P(b mine) ∝ 0.4*0.9 = 0.36
    expect(r.probabilities.get(a)).toBeCloseTo(0.06 / 0.42, 6);
    expect(r.probabilities.get(b)).toBeCloseTo(0.36 / 0.42, 6);
  });
});
