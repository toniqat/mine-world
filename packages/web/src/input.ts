import type { Camera } from './render/camera';

/**
 * Pointer / touch / keyboard handling for the board canvas.
 * Emits high-level intents; the app decides what they mean (input mode).
 */
export interface InputHandlers {
  primary(cell: { x: number; y: number }): void;
  secondary(cell: { x: number; y: number }): void;
  hover(cell: { x: number; y: number } | null): void;
  key(code: string, ev: KeyboardEvent): void;
  /** Primary press on a cell: return true to drag an object instead of panning. */
  grab?(cell: { x: number; y: number }): boolean;
  /** Pointer moved while grabbing: world position (pixels at zoom 1) and the cell under it. */
  grabMove?(world: { x: number; y: number }, cell: { x: number; y: number }): void;
  /** Grab released over `cell`, or cancelled (null). */
  grabEnd?(cell: { x: number; y: number } | null): void;
}

interface PointerRec {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  button: number;
  isTouch: boolean;
}

const DRAG_THRESHOLD = 6;

export class InputController {
  longPressMs = 450;
  private pointers = new Map<number, PointerRec>();
  private dragging = false;
  private grabbing = false;
  private longPressTimer: number | null = null;
  private longPressed = false;
  private pinchDist = 0;
  private lastPanTs = 0;
  private velocity = { x: 0, y: 0 };
  private lastMove = { x: 0, y: 0, t: 0 };
  private keys = new Set<string>();

  constructor(
    private canvas: HTMLCanvasElement,
    private cam: Camera,
    private h: InputHandlers,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', () => h.hover(null));
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Keyboard panning / inertia, called every frame. */
  tick(dt: number): void {
    const speed = 900 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) dx += speed;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) dx -= speed;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) dy += speed;
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) dy -= speed;
    if (dx || dy) this.cam.panBy(dx, dy);
    if (!this.dragging && (Math.abs(this.velocity.x) > 5 || Math.abs(this.velocity.y) > 5)) {
      this.cam.panBy(this.velocity.x * dt, this.velocity.y * dt);
      const f = Math.pow(0.02, dt);
      this.velocity.x *= f;
      this.velocity.y *= f;
    }
  }

  private cellAt(x: number, y: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const c = this.cam.screenToCell(x - r.left, y - r.top);
    return { x: c.cx, y: c.cy };
  }

  private onDown = (e: PointerEvent): void => {
    if (isEditable(e.target)) return;
    this.canvas.setPointerCapture(e.pointerId);
    const rec: PointerRec = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, button: e.button, isTouch: e.pointerType === 'touch' };
    this.pointers.set(e.pointerId, rec);
    this.velocity = { x: 0, y: 0 };
    this.longPressed = false;
    if (this.pointers.size === 1) {
      this.dragging = false;
      this.clearLongPress();
      if (e.button === 0 && this.h.grab?.(this.cellAt(rec.x, rec.y))) {
        this.grabbing = true;
        return;
      }
      if (e.button === 0) {
        this.longPressTimer = window.setTimeout(() => {
          this.longPressTimer = null;
          if (this.dragging || this.pointers.size !== 1) return;
          this.longPressed = true;
          this.h.secondary(this.cellAt(rec.x, rec.y));
          if (navigator.vibrate) navigator.vibrate(12);
        }, this.longPressMs);
      }
    } else if (this.pointers.size === 2) {
      this.clearLongPress();
      this.endGrab(null);
      this.dragging = true;
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  private onMove = (e: PointerEvent): void => {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) {
      this.h.hover(this.cellAt(e.clientX, e.clientY));
      return;
    }
    const px = rec.x;
    const py = rec.y;
    rec.x = e.clientX;
    rec.y = e.clientY;
    if (this.grabbing) {
      const r = this.canvas.getBoundingClientRect();
      this.h.grabMove?.(this.cam.screenToWorld(rec.x - r.left, rec.y - r.top), this.cellAt(rec.x, rec.y));
      return;
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = this.canvas.getBoundingClientRect();
      if (this.pinchDist > 0) this.cam.zoomAt(mx - r.left, my - r.top, dist / this.pinchDist);
      this.pinchDist = dist;
      // Pan by the midpoint movement of this pointer only (approximation).
      this.cam.panBy((rec.x - px) / 2, (rec.y - py) / 2);
      return;
    }
    if (!this.dragging && Math.hypot(rec.x - rec.startX, rec.y - rec.startY) > DRAG_THRESHOLD) {
      this.dragging = true;
      this.clearLongPress();
    }
    if (this.dragging) {
      const dx = rec.x - px;
      const dy = rec.y - py;
      this.cam.panBy(dx, dy);
      const now = performance.now();
      const dt = Math.max(1, now - this.lastMove.t) / 1000;
      this.velocity = { x: dx / dt, y: dy / dt };
      this.lastMove = { x: rec.x, y: rec.y, t: now };
      this.h.hover(null);
    } else {
      this.h.hover(this.cellAt(rec.x, rec.y));
    }
  };

  private onUp = (e: PointerEvent): void => {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    if (this.grabbing) {
      this.endGrab(e.type === 'pointercancel' ? null : this.cellAt(rec.x, rec.y));
      return;
    }
    if (this.pointers.size > 0) return;
    const wasDragging = this.dragging;
    this.dragging = false;
    if (wasDragging) {
      if (performance.now() - this.lastMove.t > 80) this.velocity = { x: 0, y: 0 };
      return;
    }
    if (this.longPressed) return;
    const cell = this.cellAt(rec.x, rec.y);
    if (rec.button === 2) this.h.secondary(cell);
    else if (rec.button === 0) this.h.primary(cell);
    else if (rec.button === 1) this.h.secondary(cell);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    this.keys.add(e.code);
    this.h.key(e.code, e);
  };

  private endGrab(cell: { x: number; y: number } | null): void {
    if (!this.grabbing) return;
    this.grabbing = false;
    this.h.grabEnd?.(cell);
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}
