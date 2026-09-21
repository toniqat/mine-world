import { type Board, CellState } from '../board';
import type { World } from '../world';

/**
 * Audit items (spec §10.3). They read the world's truth for flagged cells
 * and report counts only — never which cell is wrong.
 */
export interface AuditResult {
  total: number;
  wrong: number;
  /** Audit+ only: 16x16 sectors containing at least one wrong flag. */
  sectors: Array<{ sx: number; sy: number; wrong: number }> | null;
}

export function audit(board: Board, world: World, plus: boolean): AuditResult {
  let total = 0;
  let wrong = 0;
  const sectors = new Map<string, { sx: number; sy: number; wrong: number }>();
  board.forEachCell((x, y, s) => {
    if (s !== CellState.Flag) return;
    total++;
    if (world.truth(x, y) === 0) {
      wrong++;
      if (plus) {
        const sx = x >> 4;
        const sy = y >> 4;
        const id = `${sx},${sy}`;
        const e = sectors.get(id);
        if (e) e.wrong++;
        else sectors.set(id, { sx, sy, wrong: 1 });
      }
    }
  });
  return { total, wrong, sectors: plus ? [...sectors.values()] : null };
}
