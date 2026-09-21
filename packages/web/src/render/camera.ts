import { CELL } from './textures';

/** World<->screen transform. World units are pixels at zoom 1; a cell is CELL units. */
export class Camera {
  x = 0; // world x at the screen centre
  y = 0;
  zoom = 1;
  width = 1;
  height = 1;
  readonly minZoom = 0.2;
  readonly maxZoom = 3;

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.zoom + this.x, y: (sy - this.height / 2) / this.zoom + this.y };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.width / 2, y: (wy - this.y) * this.zoom + this.height / 2 };
  }

  screenToCell(sx: number, sy: number): { cx: number; cy: number } {
    const w = this.screenToWorld(sx, sy);
    return { cx: Math.floor(w.x / CELL), cy: Math.floor(w.y / CELL) };
  }

  /** Zoom keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  centerOnCell(cx: number, cy: number): void {
    this.x = (cx + 0.5) * CELL;
    this.y = (cy + 0.5) * CELL;
  }

  /** Visible cell range (inclusive), padded by one cell. */
  visibleCells(): { x0: number; y0: number; x1: number; y1: number } {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.width, this.height);
    return {
      x0: Math.floor(tl.x / CELL) - 1,
      y0: Math.floor(tl.y / CELL) - 1,
      x1: Math.floor(br.x / CELL) + 1,
      y1: Math.floor(br.y / CELL) + 1,
    };
  }
}
