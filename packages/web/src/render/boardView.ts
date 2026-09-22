import { Container, Graphics, Sprite, Text, type Application } from 'pixi.js';
import { CHUNK, CellState, cellKey, hash01, inBlast, inDisc, isRevealed, keyX, keyY, numberOf, type CellChange, type DroneState, type Game, type ScannerInfo, type Shipment } from '@mine/core';
import { hex, type Palette } from '../theme';
import type { Camera } from './camera';
import { CELL, buildTextures, destroyTextures, stateTexture, type CellTextures } from './textures';

/**
 * Board renderer: one sprite per cell, grouped per 16x16 chunk, culled by the
 * camera. Cells are never DOM nodes (spec §13.2). Overlays (odds, drones,
 * scanners, highlights) live in a separate layer in world coordinates.
 * Short-lived effects (flag pop, reveal fades, number fades, drone lines,
 * settlement pulses, blasts, shipment trails) are updated every frame while active.
 */
const DIGIT_MIN_ZOOM = 0.5;
/** A finished number fades out over this long. */
const DIGIT_FADE_MS = 300;
/** An opened tile flips over this long (the cover folds away, then the face unfolds)... */
const COVER_MS = 200;
/** ...starting this much later per cell of distance from the cell that was clicked. */
const COVER_STEP_MS = 13;
const MAX_COVERS = 1500;
const MARK_IN_MS = 110;
const MARK_OUT_MS = 70;
const PULSE_MS = 240;
/** Ripple delay per cell of distance from the settlement batch centre. */
const PULSE_STEP_MS = 17.5;
const MAX_MARK_ANIMS = 64;
/** Intro: the diagonal wave takes this long to cross the screen (top-left to bottom-right)... */
const INTRO_SPAN_MS = 1000;
/** ...each tile pops in over this long... */
const INTRO_TILE_MS = 320;
/** ...with up to this much random lag... */
const INTRO_JITTER_MS = 90;
/** ...and the overlays (bases, network) fade in over this long once it is done. */
const INTRO_OVERLAY_MS = 350;

/** Alpha of a number that can tell nothing more but still waits on an unsettled flag. */
const DIGIT_DIM_ALPHA = 0.25;

const enum Finish {
  /** Some neighbour is Unknown: the number still carries information. */
  Open,
  /** No Unknown neighbour, but an unsettled flag next to it: shown dimmed. */
  Dim,
  /** No Unknown or unsettled-flag neighbour: hidden. */
  Done,
}

function finishOf(game: Game, x: number, y: number): Finish {
  let flag = false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const s = game.cellState(x + dx, y + dy);
      if (s === CellState.Unknown) return Finish.Open;
      if (s === CellState.Flag) flag = true;
    }
  }
  return flag ? Finish.Dim : Finish.Done;
}

interface MarkAnim {
  key: number;
  sprite: Sprite;
  start: number;
  appear: boolean;
}

/** A pooled sprite fading out over one cell (reveal cover). */
interface CellFx {
  key: number;
  sprite: Sprite;
  start: number;
}

interface DigitFade {
  key: number;
  start: number;
  /** Alpha the fade starts from (dimmed numbers fade from DIGIT_DIM_ALPHA). */
  from: number;
}

/**
 * A drone line that is no longer used, shrinking back towards its origin, or,
 * when the next line continues from its end (`tail`), shrinking towards that end.
 */
interface GhostLine {
  path: number[];
  len: number;
  color: number;
  start: number;
  tail: boolean;
}

/** A mine explosion: every tile in the blast flashes in a wave from the centre, then scorches and fades. */
interface Blast {
  /** Tiles inside the blast: position, distance from the centre (tiles, with a little jitter) and peak strength. */
  tiles: Array<{ x: number; y: number; d: number; k: number }>;
  color: number;
  hot: number;
  start: number;
  end: number;
}

/** The trail a shipment leaves on an edge after it arrived, fading in place. */
interface Trail {
  path: number[];
  len: number;
  start: number;
}

/** A grand complex forming: rings spreading from its centre and a label rising and fading. */
interface GrandFx {
  cx: number;
  cy: number;
  /** Distance from the centre to the farthest member, plus one (tiles). */
  r: number;
  color: number;
  label: Text;
  start: number;
}

interface Pulse {
  keys: number[];
  cx: number;
  cy: number;
  color: number;
  start: number;
  end: number;
}

class ChunkView {
  readonly root = new Container();
  readonly bg: Sprite[] = [];
  readonly digit: Sprite[] = [];
  /** Last painted state per cell, to detect transitions (flag in / out, reveal). */
  readonly state = new Uint8Array(CHUNK * CHUNK);
  /** 1 when the cell's number is finished (hidden). */
  readonly done = new Uint8Array(CHUNK * CHUNK);
  /** 1 when the cell's number only waits on unsettled flags (dimmed). */
  readonly dim = new Uint8Array(CHUNK * CHUNK);

  constructor(
    readonly cx: number,
    readonly cy: number,
    tex: CellTextures,
    game: Game,
  ) {
    this.root.position.set(cx * CHUNK * CELL, cy * CHUNK * CELL);
    const bgLayer = new Container();
    const digitLayer = new Container();
    this.root.addChild(bgLayer, digitLayer);
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const x = i & 15;
      const y = i >> 4;
      // Centred so tiles can scale about their middle (intro, flips).
      const s = new Sprite(tex.unknown);
      s.anchor.set(0.5);
      s.position.set((x + 0.5) * CELL, (y + 0.5) * CELL);
      bgLayer.addChild(s);
      this.bg.push(s);
      const d = new Sprite(tex.empty);
      d.anchor.set(0.5);
      d.position.set((x + 0.5) * CELL, (y + 0.5) * CELL);
      d.visible = false;
      digitLayer.addChild(d);
      this.digit.push(d);
    }
    this.refresh(tex, game);
  }

  refresh(tex: CellTextures, game: Game): void {
    for (let i = 0; i < CHUNK * CHUNK; i++) this.paint(i, game, tex);
  }

  /** Repaint one cell (index within the chunk) from the game state. Returns true when its number just finished. */
  paint(i: number, game: Game, tex: CellTextures): boolean {
    const x = this.cx * CHUNK + (i & 15);
    const y = this.cy * CHUNK + (i >> 4);
    const s = game.cellState(x, y);
    this.state[i] = s;
    this.bg[i].texture = s === CellState.Owned ? ownedTexture(tex, baseStyle(game, cellKey(x, y))) : stateTexture(tex, s);
    const d = this.digit[i];
    const wasDone = this.done[i] === 1;
    if (isRevealed(s) && numberOf(s) > 0) {
      const f = finishOf(game, x, y);
      const done = f === Finish.Done;
      this.done[i] = done ? 1 : 0;
      this.dim[i] = f === Finish.Dim ? 1 : 0;
      d.texture = tex.digits[numberOf(s)];
      d.alpha = f === Finish.Dim ? DIGIT_DIM_ALPHA : 1;
      d.visible = !done;
      return done && !wasDone;
    }
    this.done[i] = 0;
    this.dim[i] = 0;
    d.visible = false;
    return false;
  }

  setDigitsVisible(v: boolean): void {
    this.root.children[1].visible = v;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

export class BoardView {
  readonly root = new Container();
  private readonly chunkLayer = new Container();
  private readonly densityLayer = new Graphics();
  /** Base network, the selected base's route and the main-base diamond. */
  private readonly baseGfx = new Graphics();
  /** Redrawn every frame: shipments travelling along the base network. */
  private readonly shipGfx = new Graphics();
  private readonly overlay = new Container();
  private readonly highlightGfx = new Graphics();
  private readonly scannerGfx = new Graphics();
  private readonly droneRangeGfx = new Graphics();
  private readonly droneGfx = new Graphics();
  private readonly targetGfx = new Graphics();
  /** Redrawn every frame: settlement pulses and blasts. */
  private readonly fxGfx = new Graphics();
  private readonly markLayer = new Container();
  /** Tiles fading out over freshly opened cells. */
  private readonly coverLayer = new Container();
  /** Redrawn every frame: drone lines, drones and the dragged drone. */
  private readonly droneFxGfx = new Graphics();
  private readonly hoverSprite: Sprite;
  private readonly labelLayer = new Container();
  private labelPool: Text[] = [];
  private scannerLabels: Text[] = [];
  private chunks = new Map<number, ChunkView>();
  private tex: CellTextures;
  private palette: Palette;
  private probabilities: Map<number, number> | null = null;
  private drones: DroneState[] = [];
  private droneRadius = 8;
  private droneTiming = { pending: 0, aps: 0, mps: 1 };
  /** Last drawn line per drone, to turn abandoned lines into ghosts. */
  private droneLines = new Map<number, { path: number[] | null; len: number; phase: DroneState['phase']; color: number }>();
  private ghosts: GhostLine[] = [];
  private drag: { id: number; wx: number; wy: number; valid: boolean } | null = null;
  private scanners: ScannerInfo[] = [];
  private target: { x: number; y: number; r: number; disc: boolean } | null = null;
  private hover: { x: number; y: number } | null = null;
  private highlight: { keys: number[]; color: number; until: number } | null = null;
  private selectedBase: number | null = null;
  /** Base network and complex tint; rebuilt when bases change. */
  private net: Net | null = null;
  /** Isolated / disabled bases as last painted (key -> BaseStyle). */
  private baseStyles = new Map<number, BaseStyle>();
  /** Shipments drawn last frame, to leave a trail behind the ones that arrived. */
  private shipSeen = new Set<Shipment>();
  private trails: Trail[] = [];
  private blasts: Blast[] = [];
  private grands: GrandFx[] = [];
  /** Labels of grand-complex effects. */
  private readonly fxLabels = new Container();
  private vis = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private marks: MarkAnim[] = [];
  private markPool: Sprite[] = [];
  private covers: CellFx[] = [];
  private coverPool: Sprite[] = [];
  private digitFades: DigitFade[] = [];
  private pulses: Pulse[] = [];
  private densityOverlay = false;
  /** Tile-intro wave in progress (see `intro`). */
  private introFx: { start: number; end: number; settled: boolean } | null = null;
  /** When set, reveals ripple out from this cell instead of each cascade's own start (a chord). */
  rippleFrom: number | null = null;
  private digitsVisible = true;
  private lastVisible = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private overlayDirty = true;

  constructor(
    private app: Application,
    private game: Game,
    palette: Palette,
  ) {
    this.palette = palette;
    this.tex = buildTextures(app.renderer, palette);
    this.hoverSprite = new Sprite(this.tex.unknownHover);
    this.hoverSprite.visible = false;
    this.hoverSprite.alpha = 0.9;
    this.overlay.addChild(
      this.coverLayer,
      this.densityLayer,
      this.baseGfx,
      this.shipGfx,
      this.droneRangeGfx,
      this.hoverSprite,
      this.markLayer,
      this.fxGfx,
      this.fxLabels,
      this.highlightGfx,
      this.scannerGfx,
      this.droneGfx,
      this.droneFxGfx,
      this.targetGfx,
      this.labelLayer,
    );
    this.root.addChild(this.chunkLayer, this.overlay);
  }

  setGame(game: Game): void {
    this.game = game;
    for (const c of this.chunks.values()) c.destroy();
    this.chunks.clear();
    this.lastVisible = { x0: 0, y0: 0, x1: -1, y1: -1 };
    this.probabilities = null;
    this.drones = [];
    this.scanners = [];
    this.highlight = null;
    this.selectedBase = null;
    this.net = null;
    this.baseStyles = new Map();
    this.shipSeen = new Set();
    this.trails = [];
    this.blasts = [];
    for (const f of this.grands) f.label.destroy();
    this.grands = [];
    this.pulses = [];
    for (const m of this.marks) this.releaseMark(m);
    this.marks = [];
    for (const c of this.covers) this.releaseCover(c);
    this.covers = [];
    this.digitFades = [];
    this.introFx = null;
    this.overlay.alpha = 1;
    this.ghosts = [];
    this.droneLines.clear();
    this.drag = null;
    this.overlayDirty = true;
  }

  setPalette(p: Palette): void {
    this.palette = p;
    const old = this.tex;
    this.tex = buildTextures(this.app.renderer, p);
    this.hoverSprite.texture = this.tex.unknownHover;
    for (const m of this.marks) m.sprite.texture = this.tex.flagGlyph;
    for (const c of this.covers) this.releaseCover(c);
    this.covers = [];
    for (const s of this.markPool) s.texture = this.tex.flagGlyph;
    for (const c of this.chunks.values()) c.refresh(this.tex, this.game);
    destroyTextures(old);
    this.overlayDirty = true;
  }

  applyChanges(list: CellChange[]): void {
    const now = performance.now();
    // Changed cells and their neighbours: a neighbouring number may have become done.
    const touched = new Set<number>();
    for (const c of list) {
      const v = this.chunks.get(cellKey(c.x >> 4, c.y >> 4));
      if (v) {
        const prev = v.state[((c.y & 15) << 4) | (c.x & 15)];
        const k = cellKey(c.x, c.y);
        if (c.state === CellState.Flag && prev === CellState.Unknown) this.startMark(k, true, now);
        else if (c.state === CellState.Unknown && prev === CellState.Flag) this.startMark(k, false, now);
        else if (isRevealed(c.state) && (prev === CellState.Unknown || prev === CellState.Flag)) {
          // Reveals ripple outwards from the clicked cell (a cascade's start, or the chorded number).
          const from = this.rippleFrom ?? c.from;
          const delay = from === undefined ? 0 : Math.hypot(c.x - keyX(from), c.y - keyY(from)) * COVER_STEP_MS;
          this.startCover(k, prev, now + delay);
        }
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) touched.add(cellKey(c.x + dx, c.y + dy));
    }
    for (const k of touched) this.paintCell(keyX(k), keyY(k), now);
    this.overlayDirty = true;
  }

  private paintCell(x: number, y: number, now?: number): void {
    const v = this.chunks.get(cellKey(x >> 4, y >> 4));
    if (!v) return;
    const i = ((y & 15) << 4) | (x & 15);
    const from = v.dim[i] ? DIGIT_DIM_ALPHA : 1;
    if (v.paint(i, this.game, this.tex) && now !== undefined) {
      const k = cellKey(x, y);
      if (!this.digitFades.some((f) => f.key === k)) this.digitFades.push({ key: k, start: now, from });
    }
    // While a flag pops in, the tile stays plain and the glyph sprite carries the flag.
    if (v.state[i] === CellState.Flag) {
      const k = cellKey(x, y);
      if (this.marks.some((m) => m.appear && m.key === k)) v.bg[i].texture = this.tex.unknown;
    }
  }

  /** Flag pop-in / pop-out. */
  private startMark(key: number, appear: boolean, now: number): void {
    const old = this.marks.findIndex((m) => m.key === key);
    if (old >= 0) {
      this.releaseMark(this.marks[old]);
      this.marks.splice(old, 1);
    }
    if (this.marks.length >= MAX_MARK_ANIMS) return;
    const sprite = this.markPool.pop() ?? new Sprite(this.tex.flagGlyph);
    sprite.texture = this.tex.flagGlyph;
    sprite.anchor.set(0.5);
    sprite.position.set((keyX(key) + 0.5) * CELL, (keyY(key) + 0.5) * CELL);
    sprite.scale.set(appear ? 0 : 1);
    sprite.alpha = appear ? 0 : 1;
    sprite.visible = true;
    this.markLayer.addChild(sprite);
    this.marks.push({ key, sprite, start: now, appear });
  }

  private releaseMark(m: MarkAnim): void {
    m.sprite.visible = false;
    this.markLayer.removeChild(m.sprite);
    this.markPool.push(m.sprite);
  }

  private updateMarks(now: number): void {
    if (!this.marks.length) return;
    const done: MarkAnim[] = [];
    this.marks = this.marks.filter((m) => {
      const t = Math.min(1, (now - m.start) / (m.appear ? MARK_IN_MS : MARK_OUT_MS));
      if (t >= 1) {
        done.push(m);
        return false;
      }
      // Appear: ease-out-back overshoot. Disappear: ease-in shrink.
      m.sprite.scale.set(m.appear ? easeOutBack(t) : 1 - t * t);
      m.sprite.alpha = m.appear ? Math.min(1, t * 3) : 1 - t;
      return true;
    });
    for (const m of done) {
      this.releaseMark(m);
      if (m.appear) this.paintCell(keyX(m.key), keyY(m.key));
    }
  }

  /** Flip a freshly opened cell at `start`: its previous tile (Unknown or flag) folds away, then its number unfolds. */
  private startCover(key: number, prev: number, start: number): void {
    const old = this.covers.findIndex((c) => c.key === key);
    if (old >= 0) {
      this.releaseCover(this.covers[old]);
      this.covers.splice(old, 1);
    }
    if (this.covers.length >= MAX_COVERS) return;
    const sprite = this.coverPool.pop() ?? new Sprite();
    sprite.texture = stateTexture(this.tex, prev);
    sprite.anchor.set(0.5);
    sprite.position.set((keyX(key) + 0.5) * CELL, (keyY(key) + 0.5) * CELL);
    sprite.scale.set(1);
    sprite.alpha = 1;
    sprite.tint = 0xffffff;
    sprite.visible = true;
    this.coverLayer.addChild(sprite);
    this.covers.push({ key, sprite, start });
    const d = this.digitSprite(key);
    if (d) d.scale.x = 0;
  }

  private releaseCover(c: CellFx): void {
    const d = this.digitSprite(c.key);
    if (d) d.scale.set(1);
    c.sprite.visible = false;
    this.coverLayer.removeChild(c.sprite);
    this.coverPool.push(c.sprite);
  }

  private updateCovers(now: number): void {
    if (!this.covers.length) return;
    this.covers = this.covers.filter((c) => {
      const t = (now - c.start) / COVER_MS;
      if (t >= 1) {
        this.releaseCover(c);
        return false;
      }
      if (t <= 0) return true;
      // First half: the cover folds to an edge, darkening as it turns away.
      // Second half: the face (its number) unfolds from that edge.
      if (t < 0.5) {
        const u = t / 0.5;
        c.sprite.visible = true;
        c.sprite.scale.set(Math.max(0, Math.cos((u * Math.PI) / 2)), 1 + 0.06 * Math.sin(u * Math.PI));
        const shade = Math.round(255 * (1 - 0.35 * u));
        c.sprite.tint = (shade << 16) | (shade << 8) | shade;
      } else {
        c.sprite.visible = false;
        const d = this.digitSprite(c.key);
        if (d) d.scale.x = Math.sin(((t - 0.5) / 0.5) * (Math.PI / 2));
      }
      return true;
    });
  }

  private digitSprite(key: number): Sprite | null {
    const x = keyX(key);
    const y = keyY(key);
    const v = this.chunks.get(cellKey(x >> 4, y >> 4));
    return v ? v.digit[((y & 15) << 4) | (x & 15)] : null;
  }

  /**
   * Tiles appear in a diagonal wave from the top-left corner of the screen to
   * the bottom-right; the overlays fade in after. Returns the duration in ms.
   */
  intro(): number {
    const start = performance.now();
    this.introFx = { start, end: start + INTRO_SPAN_MS + INTRO_JITTER_MS + INTRO_TILE_MS, settled: false };
    this.overlay.alpha = 0;
    for (const c of this.covers) this.releaseCover(c);
    this.covers = [];
    return this.introFx.end - start + INTRO_OVERLAY_MS;
  }

  private fadeInOverlay(now: number, from: number): void {
    const u = Math.min(1, (now - from) / INTRO_OVERLAY_MS);
    this.overlay.alpha = u;
    if (u >= 1) this.introFx = null;
  }

  private updateIntro(now: number, cam: Camera): void {
    const fx = this.introFx;
    if (!fx) return;
    if (now >= fx.end) {
      if (!fx.settled) {
        fx.settled = true;
        for (const v of this.chunks.values()) {
          for (let i = 0; i < CHUNK * CHUNK; i++) {
            v.bg[i].scale.set(1);
            v.bg[i].alpha = 1;
            v.digit[i].scale.set(1);
          }
        }
      }
      return this.fadeInOverlay(now, fx.end);
    }
    const diag = Math.max(1, cam.width + cam.height);
    for (const v of this.chunks.values()) {
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const x = v.cx * CHUNK + (i & 15);
        const y = v.cy * CHUNK + (i >> 4);
        const p = cam.worldToScreen((x + 0.5) * CELL, (y + 0.5) * CELL);
        const f = Math.min(1, Math.max(0, (p.x + p.y) / diag));
        const t = (now - fx.start - f * INTRO_SPAN_MS - hash01(0x1a7e, x, y) * INTRO_JITTER_MS) / INTRO_TILE_MS;
        const k = t <= 0 ? 0 : t >= 1 ? 1 : easeOutBack(t);
        v.bg[i].scale.set(k);
        v.bg[i].alpha = Math.min(1, Math.max(0, t * 2.5));
        v.digit[i].scale.set(k);
      }
    }
  }

  /** Finished numbers fade to nothing. */
  private updateDigitFades(now: number): void {
    if (!this.digitFades.length) return;
    this.digitFades = this.digitFades.filter((f) => {
      const x = keyX(f.key);
      const y = keyY(f.key);
      const v = this.chunks.get(cellKey(x >> 4, y >> 4));
      if (!v) return false;
      const i = ((y & 15) << 4) | (x & 15);
      const d = v.digit[i];
      const t = (now - f.start) / DIGIT_FADE_MS;
      if (!v.done[i] || t >= 1) {
        d.alpha = v.dim[i] ? DIGIT_DIM_ALPHA : 1;
        d.visible = !v.done[i] && isRevealed(v.state[i]) && numberOf(v.state[i]) > 0;
        return false;
      }
      d.visible = true;
      d.alpha = f.from * (1 - t);
      return true;
    });
  }

  /** Settlement: a ripple of tile pulses from the batch centre outwards. */
  pulse(keys: number[], cx: number, cy: number, color: number): void {
    let maxD = 0;
    for (const k of keys) maxD = Math.max(maxD, Math.hypot(keyX(k) - cx, keyY(k) - cy));
    const start = performance.now();
    this.pulses.push({ keys, cx, cy, color, start, end: start + maxD * PULSE_STEP_MS + PULSE_MS });
  }

  /** Mine explosion at (x, y) with radius r (tiles): the tiles `inBlast` flash from `hot` to `color`, centre first. */
  blast(x: number, y: number, r: number, color: number, hot: number): void {
    const tiles: Blast['tiles'] = [];
    const n = Math.ceil(r);
    let maxD = 0;
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        if (!inBlast(dx, dy, r)) continue;
        const e = Math.hypot(dx, dy);
        const d = e + (e ? 0.6 * hash01(0xb1a5, x + dx, y + dy) : 0);
        tiles.push({ x: x + dx, y: y + dy, d, k: 1 - 0.55 * (e / Math.max(1, r)) });
        maxD = Math.max(maxD, d);
      }
    }
    const start = performance.now();
    this.blasts.push({ tiles, color, hot, start, end: start + maxD * BLAST_STEP_MS + BLAST_TILE_MS });
  }

  /**
   * A grand complex formed: its members pulse outwards from the centre of
   * the complex, two rings spread from there and `text` rises and fades.
   */
  grand(members: number[], cx: number, cy: number, text: string, color: number): void {
    let r = 0;
    for (const k of members) r = Math.max(r, Math.hypot(keyX(k) + 0.5 - cx, keyY(k) + 0.5 - cy));
    this.pulse(members, cx - 0.5, cy - 0.5, color);
    const label = new Text({ text, style: { fontFamily: 'Cascadia Code, SF Mono, Consolas, monospace', fontSize: 14, fontWeight: '700', fill: color } });
    label.anchor.set(0.5);
    label.resolution = 2;
    label.position.set(cx * CELL, cy * CELL);
    this.fxLabels.addChild(label);
    this.grands.push({ cx, cy, r: r + 1, color, label, start: performance.now() });
  }

  /** Time since the game last ticked drones, so lines and gauges move smoothly between ticks. */
  setDroneTiming(pendingSec: number, actionsPerSec: number, tilesPerSec: number): void {
    this.droneTiming.pending = pendingSec;
    this.droneTiming.aps = actionsPerSec;
    this.droneTiming.mps = tilesPerSec;
  }

  /** Drone being dragged (world position of the pointer), or null. */
  setDrag(d: { id: number; wx: number; wy: number; valid: boolean } | null): void {
    const was = this.drag !== null;
    this.drag = d;
    if (was !== (d !== null)) this.overlayDirty = true;
  }

  setHover(cell: { x: number; y: number } | null): void {
    this.hover = cell;
    if (cell && this.game.cellState(cell.x, cell.y) === CellState.Unknown) {
      this.hoverSprite.visible = true;
      this.hoverSprite.position.set(cell.x * CELL, cell.y * CELL);
    } else {
      this.hoverSprite.visible = false;
    }
    if (this.target) this.overlayDirty = true;
  }

  setProbabilities(map: Map<number, number> | null): void {
    this.probabilities = map;
    this.overlayDirty = true;
  }

  setDrones(list: DroneState[], radius: number): void {
    this.drones = list;
    this.droneRadius = radius;
    this.overlayDirty = true;
  }

  setScanners(list: ScannerInfo[]): void {
    this.scanners = list;
    this.overlayDirty = true;
  }

  /** `disc`: preview a drone work area (tile-rounded disc) instead of a square. */
  setTarget(t: { x: number; y: number; r: number; disc: boolean } | null): void {
    this.target = t;
    this.overlayDirty = true;
  }

  /** Bases or the base network changed. */
  markBasesDirty(): void {
    this.net = null;
    this.overlayDirty = true;
    // Repaint bases whose isolation or disabled state changed.
    const b = this.game.bases;
    const now = new Map<number, BaseStyle>();
    for (const k of b.isolated) now.set(k, BaseStyle.Isolated);
    for (const k of b.disabled) now.set(k, BaseStyle.Disabled);
    for (const k of this.baseStyles.keys()) if (!now.has(k)) this.paintCell(keyX(k), keyY(k));
    for (const [k, st] of now) if (this.baseStyles.get(k) !== st) this.paintCell(keyX(k), keyY(k));
    this.baseStyles = now;
  }

  setSelectedBase(key: number | null): void {
    this.selectedBase = key;
    this.overlayDirty = true;
  }

  setDensityOverlay(on: boolean): void {
    this.densityOverlay = on;
    this.overlayDirty = true;
  }

  flash(keys: number[], color: number, ms = 2500): void {
    this.highlight = { keys, color, until: performance.now() + ms };
    this.overlayDirty = true;
  }

  /** Called every frame. */
  update(cam: Camera): void {
    this.root.scale.set(cam.zoom);
    const c = cam.worldToScreen(0, 0);
    this.root.position.set(Math.round(c.x), Math.round(c.y));

    const vis = cam.visibleCells();
    this.vis = vis;
    const digits = cam.zoom >= DIGIT_MIN_ZOOM;
    if (digits !== this.digitsVisible) {
      this.digitsVisible = digits;
      for (const v of this.chunks.values()) v.setDigitsVisible(digits);
    }
    const cx0 = vis.x0 >> 4;
    const cy0 = vis.y0 >> 4;
    const cx1 = vis.x1 >> 4;
    const cy1 = vis.y1 >> 4;
    if (cx0 !== this.lastVisible.x0 || cy0 !== this.lastVisible.y0 || cx1 !== this.lastVisible.x1 || cy1 !== this.lastVisible.y1) {
      this.lastVisible = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
      for (const [k, v] of this.chunks) {
        if (v.cx < cx0 || v.cx > cx1 || v.cy < cy0 || v.cy > cy1) {
          v.destroy();
          this.chunks.delete(k);
        }
      }
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cellKey(cx, cy);
          if (this.chunks.has(k)) continue;
          const v = new ChunkView(cx, cy, this.tex, this.game);
          v.setDigitsVisible(digits);
          this.chunks.set(k, v);
          this.chunkLayer.addChild(v.root);
        }
      }
      this.overlayDirty = true;
    }
    if (this.highlight && performance.now() > this.highlight.until) {
      this.highlight = null;
      this.overlayDirty = true;
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawOverlay(vis, cam.zoom);
    }
    const now = performance.now();
    this.updateIntro(now, cam);
    this.updateMarks(now);
    this.updateCovers(now);
    this.updateDigitFades(now);
    this.drawFx(now);
    this.drawShipments(now);
    this.drawDrones(now);
  }

  /** Per-frame effects: settlement pulses, blasts and grand complexes forming. */
  private drawFx(now: number): void {
    const g = this.fxGfx;
    g.clear();
    if (this.grands.length) {
      this.grands = this.grands.filter((f) => {
        const t = (now - f.start) / GRAND_MS;
        if (t >= 1) {
          f.label.destroy();
          return false;
        }
        const x = f.cx * CELL, y = f.cy * CELL;
        // Two rings, the second a little later, each growing past the complex and fading.
        for (const lag of [0, 0.18]) {
          const u = (t - lag) / 0.6;
          if (u <= 0 || u >= 1) continue;
          const rad = (0.4 + (1 - Math.pow(1 - u, 3)) * f.r) * CELL;
          g.circle(x, y, rad).stroke({ width: 2, color: f.color, alpha: 0.6 * (1 - u) });
        }
        const smooth = (v: number) => v * v * (3 - 2 * v);
        f.label.alpha = t < 0.15 ? smooth(t / 0.15) : t > 0.7 ? 1 - smooth((t - 0.7) / 0.3) : 1;
        f.label.position.set(x, y - smooth(Math.min(1, t / 0.7)) * CELL * 0.8);
        return true;
      });
    }
    if (this.blasts.length) {
      this.blasts = this.blasts.filter((b) => now < b.end);
      for (const b of this.blasts) {
        for (const tl of b.tiles) {
          const t = (now - b.start - tl.d * BLAST_STEP_MS) / BLAST_TILE_MS;
          if (t <= 0 || t >= 1) continue;
          // A hot flash that pops slightly larger than the tile, cools to the blast colour
          // while shrinking back, then a faint scorch that fades out.
          const flash = t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 2.2);
          const cool = Math.min(1, t / 0.35);
          const grow = t < 0.12 ? 3 * (t / 0.12) : 3 * (1 - Math.min(1, (t - 0.12) / 0.3)) - 2 * Math.min(1, (t - 0.12) / 0.3);
          const x = tl.x * CELL - grow, y = tl.y * CELL - grow, s = CELL + 2 * grow;
          g.roundRect(x, y, s, s, 3).fill({ color: lerpColor(b.hot, b.color, cool), alpha: 0.7 * tl.k * flash });
          const scorch = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
          g.rect(tl.x * CELL, tl.y * CELL, CELL, CELL).fill({ color: b.color, alpha: 0.14 * tl.k * scorch });
          // The first moments of the flash leave a bright core in each tile.
          if (t < 0.25) {
            const c = 1 - t / 0.25;
            const h = CELL * (0.18 + 0.2 * c);
            g.rect((tl.x + 0.5) * CELL - h, (tl.y + 0.5) * CELL - h, 2 * h, 2 * h).fill({ color: 0xffffff, alpha: 0.35 * tl.k * c });
          }
        }
      }
    }
    if (!this.pulses.length) return;
    this.pulses = this.pulses.filter((pl) => now < pl.end);
    for (const pl of this.pulses) {
      for (const k of pl.keys) {
        const t = (now - pl.start - Math.hypot(keyX(k) - pl.cx, keyY(k) - pl.cy) * PULSE_STEP_MS) / PULSE_MS;
        if (t <= 0 || t >= 1) continue;
        const a = Math.sin(Math.PI * t);
        const grow = 3 * a;
        g.roundRect(keyX(k) * CELL - grow, keyY(k) * CELL - grow, CELL + 2 * grow, CELL + 2 * grow, 4).fill({ color: pl.color, alpha: 0.5 * a });
      }
    }
  }

  private droneColor(d: DroneState): number {
    const p = this.palette;
    return d.status === 'working' ? p.success : d.status === 'idle' ? p.fgMuted : p.error;
  }

  /**
   * Per-frame drone layer: the line growing from the anchor to the target,
   * the work gauge once it arrives, the drone riding a line to another mine,
   * abandoned lines shrinking back, and the drone under the pointer while dragged.
   */
  private drawDrones(now: number): void {
    const g = this.droneFxGfx;
    g.clear();
    const p = this.palette;
    const { pending, aps, mps } = this.droneTiming;
    const width = CELL * 0.2;

    for (const d of this.drones) {
      const color = d.targetKind === 'flag' ? p.accent : d.targetKind === 'move' ? p.fg : p.success;
      let len = 0;
      let from = 0;
      if (d.path && d.phase) {
        const max = d.path.length - 1;
        len = d.phase === 'extend' ? Math.min(max, d.line + pending * mps) : max;
        if (d.phase === 'travel') from = Math.min(max, d.ride + pending * mps);
      }
      // A line dropped without being ridden shrinks back towards its origin; one the
      // next line continues from shrinks towards its end instead.
      const last = this.droneLines.get(d.id);
      if (last && last.path && last.path !== d.path && last.phase !== 'travel' && last.len > 0) {
        const end = last.path[last.path.length - 1];
        const tail = d.path !== null && d.path[0] === end && last.len >= last.path.length - 1;
        this.ghosts.push({ path: last.path, len: last.len, color: last.color, start: now, tail });
      }
      this.droneLines.set(d.id, { path: d.path, len, phase: d.phase, color });

      if (d.path && d.phase && len > from) {
        drawPathLine(g, d.path, from, len);
        g.stroke({ width, color, alpha: 0.45, cap: 'round', join: 'round' });
      }
      if (d.phase === 'work' && d.target !== null) {
        const f = Math.min(1, d.acc + pending * aps);
        if (f > 0) {
          clockWipe(g, (keyX(d.target) + 0.5) * CELL, (keyY(d.target) + 0.5) * CELL, CELL / 2 - 2, f);
          g.fill({ color, alpha: 0.45 });
        }
      }
      if (!d.placed) continue;
      const pos = d.phase === 'travel' && d.path ? pathPoint(d.path, from) : { x: (d.x + 0.5) * CELL, y: (d.y + 0.5) * CELL };
      drawDrone(g, pos.x, pos.y, this.droneColor(d), this.drag?.id === d.id ? 0.35 : 1, d.status === 'halted');
    }

    if (this.ghosts.length) {
      this.ghosts = this.ghosts.filter((gl) => {
        const len = gl.len - ((now - gl.start) / 1000) * mps * 2;
        if (len <= 0) return false;
        if (gl.tail) drawPathLine(g, gl.path, gl.len - len, gl.len);
        else drawPathLine(g, gl.path, 0, len);
        g.stroke({ width, color: gl.color, alpha: 0.45 * Math.min(1, len / gl.len + 0.3), cap: 'round', join: 'round' });
        return true;
      });
    }

    if (this.drag) {
      const d = this.drones.find((x) => x.id === this.drag!.id);
      if (d) drawDrone(g, this.drag.wx, this.drag.wy, this.drag.valid ? p.accent : this.droneColor(d), 0.9, false);
    }
  }

  private drawOverlay(vis: { x0: number; y0: number; x1: number; y1: number }, zoom: number): void {
    const p = this.palette;
    // Density heatmap (chunk granularity).
    this.densityLayer.clear();
    if (this.densityOverlay) {
      for (let cy = vis.y0 >> 4; cy <= vis.y1 >> 4; cy++) {
        for (let cx = vis.x0 >> 4; cx <= vis.x1 >> 4; cx++) {
          const d = this.game.densityAt(cx * CHUNK + 8, cy * CHUNK + 8);
          const a = Math.min(0.55, Math.max(0, (d - 0.08) / 0.4));
          this.densityLayer.rect(cx * CHUNK * CELL, cy * CHUNK * CELL, CHUNK * CELL, CHUNK * CELL).fill({ color: p.error, alpha: a });
        }
      }
    }

    this.drawBases(vis);

    // Highlights.
    this.highlightGfx.clear();
    if (this.highlight) {
      for (const k of this.highlight.keys) {
        this.highlightGfx.rect(keyX(k) * CELL + 2, keyY(k) * CELL + 2, CELL - 4, CELL - 4).stroke({ width: 3, color: this.highlight.color, alpha: 0.9 });
      }
    }

    // Scanner boxes.
    this.scannerGfx.clear();
    for (const t of this.scannerLabels) t.visible = false;
    let sl = 0;
    for (const s of this.scanners) {
      if (s.cx + s.r < vis.x0 || s.cx - s.r > vis.x1 || s.cy + s.r < vis.y0 || s.cy - s.r > vis.y1) continue;
      const x = (s.cx - s.r) * CELL;
      const y = (s.cy - s.r) * CELL;
      const w = (2 * s.r + 1) * CELL;
      this.scannerGfx.rect(x + 1, y + 1, w - 2, w - 2).stroke({ width: 2, color: p.warning, alpha: 0.9 });
      const label = this.scannerLabel(sl++);
      label.text = String(s.n);
      label.style.fill = hex(p.warning);
      label.position.set(x + 4, y + 2);
      label.visible = zoom >= DIGIT_MIN_ZOOM;
    }

    // Drones: tint the Unknown cells inside each work disc; nothing once none are left.
    this.droneGfx.clear();
    this.droneRangeGfx.clear();
    const r = this.droneRadius;
    const tinted = new Set<number>();
    for (const d of this.drones) {
      if (!d.placed) continue;
      const color = this.droneColor(d);
      for (let y = Math.max(d.y - r, vis.y0); y <= Math.min(d.y + r, vis.y1); y++) {
        for (let x = Math.max(d.x - r, vis.x0); x <= Math.min(d.x + r, vis.x1); x++) {
          if (!inDisc(x - d.x, y - d.y, r) || this.game.cellState(x, y) !== CellState.Unknown) continue;
          const k = cellKey(x, y);
          if (tinted.has(k)) continue;
          tinted.add(k);
          this.droneRangeGfx.rect(x * CELL, y * CELL, CELL, CELL).fill({ color, alpha: 0.1 });
        }
      }
      if (d.stall) {
        for (const comp of d.stall) {
          for (const k of comp.cells) {
            if (this.game.cellState(keyX(k), keyY(k)) !== CellState.Unknown) continue;
            this.droneGfx.rect(keyX(k) * CELL + 3, keyY(k) * CELL + 3, CELL - 6, CELL - 6).stroke({ width: 1.5, color: p.error, alpha: 0.5 });
          }
        }
      }
    }

    // While dragging: outline every free Owned mine the drone can be dropped on.
    if (this.drag) {
      const id = this.drag.id;
      for (let y = vis.y0; y <= vis.y1; y++) {
        for (let x = vis.x0; x <= vis.x1; x++) {
          if (!this.game.canPlaceDrone(id, x, y)) continue;
          this.droneGfx.roundRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4, 4).stroke({ width: 2, color: p.accent, alpha: 0.8 });
        }
      }
    }

    // Targeting preview.
    this.targetGfx.clear();
    if (this.target && this.hover) {
      const t = this.target;
      if (t.disc) {
        for (let dy = -t.r; dy <= t.r; dy++) {
          for (let dx = -t.r; dx <= t.r; dx++) {
            if (inDisc(dx, dy, t.r)) this.targetGfx.rect((this.hover.x + dx) * CELL, (this.hover.y + dy) * CELL, CELL, CELL);
          }
        }
        this.targetGfx.fill({ color: p.accent, alpha: 0.18 });
      } else {
        const x = (this.hover.x - t.r) * CELL;
        const y = (this.hover.y - t.r) * CELL;
        const w = (2 * t.r + 1) * CELL;
        this.targetGfx.rect(x, y, w, w).fill({ color: p.accent, alpha: 0.15 }).stroke({ width: 2, color: p.accent, alpha: 0.9 });
      }
    }

    // Probability labels.
    let used = 0;
    if (this.probabilities && zoom >= DIGIT_MIN_ZOOM) {
      for (const [k, prob] of this.probabilities) {
        const x = keyX(k);
        const y = keyY(k);
        if (x < vis.x0 || x > vis.x1 || y < vis.y0 || y > vis.y1) continue;
        if (this.game.cellState(x, y) !== CellState.Unknown) continue;
        const label = this.label(used++);
        label.text = Math.round(prob * 100) + '';
        label.style.fill = hex(lerpColor(p.probLow, p.probHigh, Math.min(1, prob / 0.5)));
        label.position.set((x + 0.5) * CELL, (y + 0.5) * CELL);
        label.visible = true;
        if (used > 600) break;
      }
    }
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].visible = false;
  }

  /**
   * Complexes as a faint tint over their tiles with a round-cornered border
   * around the whole group, the base network as faint strips (1/6 of a tile,
   * drawn from non-overlapping pieces so shared tiles do not get darker), the
   * selected base's route to the main base emphasised, and a large diamond on
   * the main base (Owned tiles already carry the small one).
   */
  private drawBases(vis: { x0: number; y0: number; x1: number; y1: number }): void {
    const g = this.baseGfx;
    g.clear();
    const p = this.palette;
    const bases = this.game.bases;
    const net = (this.net ??= buildNet(bases));
    const inside = (k: number) => keyX(k) >= vis.x0 - 1 && keyX(k) <= vis.x1 + 1 && keyY(k) >= vis.y0 - 1 && keyY(k) <= vis.y1 + 1;

    const shown = net.complexes.filter(({ box: [x0, y0, x1, y1] }) => x1 >= vis.x0 - 1 && x0 <= vis.x1 + 2 && y1 >= vis.y0 - 1 && y0 <= vis.y1 + 2);
    for (const c of shown) {
      for (const l of c.outer) roundLoop(g, l);
      g.fill({ color: p.accent, alpha: COMPLEX_ALPHA });
      if (c.holes.length) {
        for (const l of c.holes) roundLoop(g, l);
        g.cut();
      }
    }
    for (const c of shown) for (const l of [...c.outer, ...c.holes]) roundLoop(g, l);
    if (shown.length) g.stroke({ width: COMPLEX_BORDER, color: p.accent, alpha: COMPLEX_BORDER_ALPHA, join: 'round' });

    let any = false;

    const w = NET_WIDTH;
    const o = (CELL - w) / 2;
    for (const k of net.tiles) if (inside(k)) (g.rect(keyX(k) * CELL + o, keyY(k) * CELL + o, w, w), (any = true));
    for (const k of net.right) if (inside(k)) g.rect(keyX(k) * CELL + o + w, keyY(k) * CELL + o, CELL - w, w);
    for (const k of net.down) if (inside(k)) g.rect(keyX(k) * CELL + o, keyY(k) * CELL + o + w, w, CELL - w);
    if (any) g.fill({ color: p.cellOwned, alpha: NET_ALPHA });

    const sel = this.selectedBase !== null ? bases.info(this.selectedBase) : null;
    if (sel) {
      const route = bases.routePaths(sel.key);
      if (route.length) {
        for (const path of route) drawPathLine(g, path, 0, path.length - 1);
        g.stroke({ width: w, color: p.accent, alpha: 0.35, join: 'miter', cap: 'square' });
      }
      // The rest of the selected base's complex.
      const hub = bases.complexOf.get(sel.key);
      for (const k of hub === undefined ? [] : bases.complexes.get(hub)!.members) {
        if (k !== sel.key) g.roundRect(keyX(k) * CELL + 2, keyY(k) * CELL + 2, CELL - 4, CELL - 4, 4).stroke({ width: 1.5, color: p.accent, alpha: 0.5 });
      }
      g.roundRect(sel.x * CELL + 1, sel.y * CELL + 1, CELL - 2, CELL - 2, 4).stroke({ width: 2.5, color: p.accent, alpha: 1 });
    }

    if (bases.main !== null) {
      const x = (keyX(bases.main) + 0.5) * CELL;
      const y = (keyY(bases.main) + 0.5) * CELL;
      const h = CELL * 0.44;
      g.poly([x, y - h, x + h, y, x, y + h, x - h, y]).fill({ color: p.cellOwned });
      const i = CELL * 0.18;
      g.poly([x, y - i, x + i, y, x, y + i, x - i, y]).fill({ color: p.bg });
    }
  }

  /**
   * Per-frame shipments: a bright stretch of the network line with a fading
   * tail, moving from each base towards the main base. Positions are
   * extrapolated between game ticks. A shipment that arrives (or hands over
   * to the next edge) leaves its trail behind as an afterimage that fades
   * out in place instead of vanishing with it. Inside a complex (two or more
   * bases) goods are not drawn: they seem to leave through the border and
   * arrive at it, although they really run between member bases.
   */
  private drawShipments(now: number): void {
    const g = this.shipGfx;
    g.clear();
    const bases = this.game.bases;
    const net = (this.net ??= buildNet(bases));
    const live = bases.shipments;
    if (this.shipSeen.size) {
      const alive = new Set(live);
      for (const s of this.shipSeen) if (!alive.has(s)) this.trails.push({ path: s.path, len: s.len, start: now });
    }
    this.shipSeen = new Set(live);
    if (!live.length && !this.trails.length) return;
    const ahead = this.droneTiming.pending * bases.speed();
    for (const s of live) if (this.edgeVisible(s.path)) this.drawShipment(g, net, s.path, s.len, Math.min(s.len, s.d + ahead), 1);
    if (this.trails.length) {
      this.trails = this.trails.filter((tr) => now - tr.start < TRAIL_FADE_MS);
      for (const tr of this.trails) {
        if (!this.edgeVisible(tr.path)) continue;
        const u = (now - tr.start) / TRAIL_FADE_MS;
        this.drawShipment(g, net, tr.path, tr.len, tr.len, 1 - u * u * (3 - 2 * u));
      }
    }
  }

  private edgeVisible(path: number[]): boolean {
    const vis = this.vis;
    for (const k of path) if (keyX(k) >= vis.x0 - 1 && keyX(k) <= vis.x1 + 1 && keyY(k) >= vis.y0 - 1 && keyY(k) <= vis.y1 + 1) return true;
    return false;
  }

  /** One shipment's stretch on the edge `path` with its front at `head` tiles, opacity scaled by `fade`; clipped to the part outside complexes. */
  private drawShipment(g: Graphics, net: Net, path: number[], len: number, head: number, fade: number): void {
    const color = this.palette.cellOwned;
    const [lo, hi] = outsideComplexes(net, path, len);
    for (let i = 0; i < SHIP_PIECES; i++) {
      const b = Math.min(hi, head - (i * SHIP_TAIL) / SHIP_PIECES);
      const a = Math.max(lo, head - ((i + 1) * SHIP_TAIL) / SHIP_PIECES);
      if (a >= hi) continue;
      if (b <= a) break;
      drawPathLine(g, path, a, b);
      g.stroke({ width: NET_WIDTH, color, alpha: fade * shipAlpha((i + 0.5) / SHIP_PIECES), cap: 'butt', join: 'miter' });
    }
  }

  private label(i: number): Text {
    while (this.labelPool.length <= i) {
      const t = new Text({ text: '', style: { fontFamily: 'Cascadia Code, SF Mono, Consolas, monospace', fontSize: 11, fontWeight: '600' } });
      t.anchor.set(0.5);
      t.resolution = 2;
      this.labelLayer.addChild(t);
      this.labelPool.push(t);
    }
    return this.labelPool[i];
  }

  private scannerLabel(i: number): Text {
    while (this.scannerLabels.length <= i) {
      const t = new Text({ text: '', style: { fontFamily: 'Cascadia Code, SF Mono, Consolas, monospace', fontSize: 11, fontWeight: '700' } });
      t.resolution = 2;
      this.labelLayer.addChild(t);
      this.scannerLabels.push(t);
    }
    return this.scannerLabels[i];
  }
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Network line thickness: a sixth of a tile. */
const NET_WIDTH = CELL / 6;
/** The idle network is barely visible. */
const NET_ALPHA = 0.1;
/** Length of a shipment's bright stretch in tiles, drawn in this many pieces along a smooth gradient. */
const SHIP_TAIL = 2.4;
const SHIP_PIECES = 16;
/** Peak opacity of a shipment. */
const SHIP_ALPHA = 0.45;
/** Fraction of the stretch (from the front) over which it fades in; the rest is the fading tail. */
const SHIP_HEAD = 0.2;
/** Complex tint over member tiles: barely visible. */
const COMPLEX_ALPHA = 0.08;
/** Border around a complex (world pixels), its corner radius and its opacity. */
const COMPLEX_BORDER = 1.5;
const COMPLEX_RADIUS = 6;
const COMPLEX_BORDER_ALPHA = 0.3;
/** A shipment's trail fades out over this long after it arrives. */
const TRAIL_FADE_MS = 900;
/** A blast reaches one tile further out every this many ms; each tile's flash and scorch last this long. */
const BLAST_STEP_MS = 55;
const BLAST_TILE_MS = 900;
/** A grand complex's formation effect lasts this long. */
const GRAND_MS = 2200;

const enum BaseStyle {
  Normal,
  Isolated,
  Disabled,
}

function baseStyle(game: Game, key: number): BaseStyle {
  const b = game.bases;
  return b.disabled.has(key) ? BaseStyle.Disabled : b.isolated.has(key) ? BaseStyle.Isolated : BaseStyle.Normal;
}

function ownedTexture(tex: CellTextures, st: BaseStyle): CellTextures['owned'] {
  return st === BaseStyle.Disabled ? tex.ownedDisabled : st === BaseStyle.Isolated ? tex.ownedIsolated : tex.owned;
}

/** Shipment opacity at `u` (0 = front, 1 = end of the tail): a smooth rise, then a smooth fade. */
function shipAlpha(u: number): number {
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return SHIP_ALPHA * (u < SHIP_HEAD ? smooth(u / SHIP_HEAD) : 1 - smooth((u - SHIP_HEAD) / (1 - SHIP_HEAD)));
}

interface Net {
  tiles: Set<number>;
  right: Set<number>;
  down: Set<number>;
  /** Complexes with more than one base: border loops (corners in cell units) and bounding box [x0, y0, x1, y1] in cells. */
  complexes: Array<{ outer: Loop[]; holes: Loop[]; box: [number, number, number, number] }>;
  /** Tile inside a complex's border (two or more bases) -> the complex's index in `complexes`. */
  area: Map<number, number>;
  /** Edge path -> the range [lo, hi] (tiles along it) outside the complexes at its ends. */
  clip: WeakMap<number[], [number, number]>;
}

/**
 * Part of an edge path outside the complexes it leaves and enters: from the
 * border tile side where it leaves the first cell's complex to the one where
 * it enters the last cell's. Paths of shipments still in flight after a
 * rebuild are clipped against the current complexes.
 */
function outsideComplexes(net: Net, path: number[], len: number): [number, number] {
  const hit = net.clip.get(path);
  if (hit) return hit;
  let lo = 0, hi = len;
  const from = net.area.get(path[0]);
  if (from !== undefined) {
    let i = 0;
    while (i < len && net.area.get(path[i + 1]) === from) i++;
    lo = i + 0.5;
  }
  const to = net.area.get(path[len]);
  if (to !== undefined) {
    let j = len;
    while (j > 0 && net.area.get(path[j - 1]) === to) j--;
    hi = j - 0.5;
  }
  const r: [number, number] = [Math.min(lo, len), Math.max(0, hi)];
  net.clip.set(path, r);
  return r;
}

/** Closed loop of tile-grid corners, flat [x0, y0, x1, y1, ...]. */
type Loop = number[];

/**
 * Complex tint and border, plus network tiles and connectors of every edge
 * path. Members of a complex can be up to 2 tiles apart, so the tinted area
 * is the members plus, for each pair within reach, the rectangle between
 * them.
 */
function buildNet(bases: Game['bases']): Net {
  const tiles = new Set<number>();
  const right = new Set<number>();
  const down = new Set<number>();
  const complexes: Net['complexes'] = [];
  const inArea = new Map<number, number>();
  for (const c of bases.complexes.values()) {
    if (c.members.length < 2) continue;
    const xs = c.members.map(keyX), ys = c.members.map(keyY);
    const set = new Set(c.members);
    const area = new Set(c.members);
    for (const k of c.members) {
      const x = keyX(k), y = keyY(k);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!set.has(cellKey(x + dx, y + dy))) continue;
          for (let ry = Math.min(0, dy); ry <= Math.max(0, dy); ry++) for (let rx = Math.min(0, dx); rx <= Math.max(0, dx); rx++) area.add(cellKey(x + rx, y + ry));
        }
      }
    }
    for (const k of area) inArea.set(k, complexes.length);
    const outer: Loop[] = [], holes: Loop[] = [];
    for (const l of traceLoops([...area])) (loopArea(l) > 0 ? outer : holes).push(l);
    complexes.push({ outer, holes, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  for (const path of bases.edges()) {
    for (let i = 0; i < path.length; i++) {
      tiles.add(path[i]);
      if (!i) continue;
      const a = path[i - 1], b = path[i];
      // A step's connector belongs to its upper / left cell.
      if (keyY(a) === keyY(b)) right.add(keyX(a) < keyX(b) ? a : b);
      else down.add(keyY(a) < keyY(b) ? a : b);
    }
  }
  return { tiles, right, down, complexes, area: inArea, clip: new WeakMap() };
}

/**
 * Border loops of a group of tiles. Tile sides not shared with another member
 * are directed with the inside on the right (y down), so outer loops run
 * clockwise on screen (positive `loopArea`) and holes the other way. Where two
 * tiles touch only at a corner the walk turns right, keeping both corners
 * separate. Only the corners are kept.
 */
function traceLoops(members: number[]): Loop[] {
  const set = new Set(members);
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = cellKey(x0, y0);
    const list = out.get(k);
    if (list) list.push(cellKey(x1, y1));
    else out.set(k, [cellKey(x1, y1)]);
  };
  for (const k of members) {
    const x = keyX(k), y = keyY(k);
    if (!set.has(cellKey(x, y - 1))) add(x, y, x + 1, y);
    if (!set.has(cellKey(x + 1, y))) add(x + 1, y, x + 1, y + 1);
    if (!set.has(cellKey(x, y + 1))) add(x + 1, y + 1, x, y + 1);
    if (!set.has(cellKey(x - 1, y))) add(x, y + 1, x, y);
  }
  const loops: Loop[] = [];
  for (const [start, ends] of out) {
    while (ends.length) {
      const loop: Loop = [];
      let v = start;
      let next = ends.pop()!;
      const dx0 = keyX(next) - keyX(v), dy0 = keyY(next) - keyY(v);
      let dx = dx0, dy = dy0;
      for (;;) {
        v = next;
        if (v === start) {
          if (dx !== dx0 || dy !== dy0) loop.push(keyX(v), keyY(v));
          break;
        }
        const cands = out.get(v)!;
        // Prefer a right turn, then straight on, then a left turn.
        let pick = -1;
        for (const [ex, ey] of [[-dy, dx], [dx, dy], [dy, -dx]]) {
          pick = cands.findIndex((e) => keyX(e) - keyX(v) === ex && keyY(e) - keyY(v) === ey);
          if (pick >= 0) break;
        }
        next = cands.splice(pick, 1)[0];
        const nx = keyX(next) - keyX(v), ny = keyY(next) - keyY(v);
        if (nx !== dx || ny !== dy) loop.push(keyX(v), keyY(v));
        dx = nx;
        dy = ny;
      }
      loops.push(loop);
    }
  }
  return loops;
}

/** Twice the signed area of a loop (shoelace, y down): positive when clockwise on screen. */
function loopArea(l: Loop): number {
  let a = 0;
  for (let i = 0; i < l.length; i += 2) {
    const j = (i + 2) % l.length;
    a += l[i] * l[j + 1] - l[j] * l[i + 1];
  }
  return a;
}

/** A loop of tile-grid corners as a closed path with rounded corners; the caller fills or strokes it. */
function roundLoop(g: Graphics, l: Loop): void {
  const n = l.length;
  // Start halfway along the closing side, so every corner is rounded.
  g.moveTo(((l[n - 2] + l[0]) / 2) * CELL, ((l[n - 1] + l[1]) / 2) * CELL);
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    g.arcTo(l[i] * CELL, l[i + 1] * CELL, l[j] * CELL, l[j + 1] * CELL, COMPLEX_RADIUS);
  }
  g.closePath();
}

/** Centre of the cell at fractional position `t` along a path. */
function pathPoint(path: number[], t: number): { x: number; y: number } {
  const i = Math.min(path.length - 1, Math.floor(t));
  const j = Math.min(path.length - 1, i + 1);
  const f = t - i;
  return {
    x: (keyX(path[i]) + (keyX(path[j]) - keyX(path[i])) * f + 0.5) * CELL,
    y: (keyY(path[i]) + (keyY(path[j]) - keyY(path[i])) * f + 0.5) * CELL,
  };
}

/** Polyline through cell centres from fractional position `a` to `b` along a path; the caller strokes it. */
function drawPathLine(g: Graphics, path: number[], a: number, b: number): void {
  const s = pathPoint(path, a);
  g.moveTo(s.x, s.y);
  for (let i = Math.floor(a) + 1; i < b; i++) g.lineTo((keyX(path[i]) + 0.5) * CELL, (keyY(path[i]) + 0.5) * CELL);
  const e = pathPoint(path, b);
  g.lineTo(e.x, e.y);
}

function drawDrone(g: Graphics, x: number, y: number, color: number, alpha: number, halted: boolean): void {
  g.circle(x, y, CELL * 0.3).fill({ color, alpha: 0.95 * alpha });
  if (halted) {
    const h = CELL * 0.12;
    g.moveTo(x - h, y - h).lineTo(x + h, y + h).moveTo(x + h, y - h).lineTo(x - h, y + h).stroke({ width: 2, color: 0xffffff, alpha: 0.9 * alpha });
  } else {
    g.circle(x, y, CELL * 0.12).fill({ color: 0xffffff, alpha: 0.85 * alpha });
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Clock wipe over a square of half-size h centred on (cx, cy): a pie that
 * starts at 12 o'clock and sweeps clockwise to fraction f, clipped to the
 * square. Leaves the path open for the caller to fill.
 */
function clockWipe(g: Graphics, cx: number, cy: number, h: number, f: number): void {
  if (f >= 1) {
    g.rect(cx - h, cy - h, 2 * h, 2 * h);
    return;
  }
  const end = f * Math.PI * 2;
  const pts = [cx, cy, cx, cy - h];
  // Corners in sweep order: top-right, bottom-right, bottom-left, top-left.
  const corners: Array<[number, number, number]> = [
    [Math.PI / 4, cx + h, cy - h],
    [(3 * Math.PI) / 4, cx + h, cy + h],
    [(5 * Math.PI) / 4, cx - h, cy + h],
    [(7 * Math.PI) / 4, cx - h, cy - h],
  ];
  for (const [a, x, y] of corners) if (a < end) pts.push(x, y);
  const dx = Math.sin(end);
  const dy = -Math.cos(end);
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  pts.push(cx + (dx / m) * h, cy + (dy / m) * h);
  g.poly(pts);
}
