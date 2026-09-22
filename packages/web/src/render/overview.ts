import { BufferImageSource, Container, Graphics, Texture, TilingSprite } from 'pixi.js';
import { CellState, SIGNATURE_COLORS, isKnownMine, isRevealed, isWall, keyX, keyY, type Game } from '@mine/core';
import type { Palette } from '../theme';
import type { Camera } from './camera';
import { CELL, FOG_WATER_ALPHA, mixColor } from './textures';

/** Opacity of a fogged land cell over the background (the fog tile's fill). */
const FOG_LAND_ALPHA = 0.3;
/** Screen size of the main-base marker (half the diamond's diagonal, px). */
const MARKER_R = 5;

/**
 * Earth mode, zoomed out: the whole map as one texel per cell (water, land,
 * fog, opened cells, bases), repeated east-west, in screen space. Tiles are
 * too small to draw one by one there. Cell changes and fog lifts repaint
 * their texels; the texture is re-uploaded at most once per frame.
 */
export class Overview {
  readonly root = new Container();
  private readonly w: number;
  private readonly h: number;
  private readonly data: Uint8Array;
  private readonly source: BufferImageSource;
  private readonly sprite: TilingSprite;
  private readonly marker = new Graphics();
  private colors!: Record<'fogLand' | 'fogWater' | 'water' | 'unknown' | 'locked' | 'flag' | 'revealed' | 'owned' | 'lost' | 'exploded', number>;
  /** Online: opened land per signature colour (bases use the colour itself). */
  private ownerLand: number[] = [];
  private markerColor = 0;
  private markerBg = 0;
  private dirty = false;

  constructor(
    private game: Game,
    palette: Palette,
  ) {
    const map = game.world.map!;
    this.w = map.w;
    this.h = map.h;
    this.data = new Uint8Array(this.w * this.h * 4);
    this.source = new BufferImageSource({ resource: this.data, width: this.w, height: this.h, scaleMode: 'nearest' });
    this.sprite = new TilingSprite({ texture: new Texture({ source: this.source }), width: 1, height: 1 });
    this.root.addChild(this.sprite, this.marker);
    this.root.visible = false;
    this.setPalette(palette);
  }

  setPalette(p: Palette): void {
    const mix = mixColor;
    this.ownerLand = SIGNATURE_COLORS.map((c) => mix(p.cellRevealed, c, 0.55));
    this.colors = {
      fogLand: mix(p.bg, p.cellUnknown, FOG_LAND_ALPHA),
      fogWater: mix(p.bg, p.cellWater, FOG_WATER_ALPHA),
      water: p.cellWater,
      unknown: p.cellUnknown,
      locked: p.cellLocked,
      flag: mix(p.cellUnknown, p.accent, 0.6),
      revealed: p.cellRevealed,
      owned: p.cellOwned,
      lost: p.cellLost,
      exploded: p.error,
    };
    this.markerColor = p.cellOwned;
    this.markerBg = p.bg;
    this.repaint();
  }

  /** Repaint every texel (a new palette, a mining technology unlocking a tier). */
  repaint(): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.paint(x, y);
  }

  /** Cells changed (keys or coordinates). */
  paintKeys(keys: Iterable<number>): void {
    for (const k of keys) this.paint(keyX(k), keyY(k));
  }

  paint(x: number, y: number): void {
    if (y < 0 || y >= this.h) return;
    x = this.game.wx(x);
    const c = this.colorOf(x, y);
    const i = (y * this.w + x) * 4;
    this.data[i] = (c >> 16) & 255;
    this.data[i + 1] = (c >> 8) & 255;
    this.data[i + 2] = c & 255;
    this.data[i + 3] = 255;
    this.dirty = true;
  }

  private colorOf(x: number, y: number): number {
    const g = this.game;
    const s = g.cellState(x, y);
    const c = this.colors;
    if (g.fogged(x, y)) return isWall(s) ? c.fogWater : c.fogLand;
    if (isWall(s)) return c.water;
    if (s === CellState.Unknown) return g.locked(x, y) ? c.locked : c.unknown;
    if (s === CellState.Flag) return c.flag;
    const owner = g.online ? g.cellOwner(x, y) : -1;
    if (owner >= 0 && s === CellState.Owned) return SIGNATURE_COLORS[owner];
    if (owner >= 0 && isRevealed(s)) return this.ownerLand[owner];
    if (s === CellState.Owned) return c.owned;
    if (s === CellState.Exploded) return c.exploded;
    if (isKnownMine(s)) return c.lost;
    return isRevealed(s) ? c.revealed : c.unknown;
  }

  /** Per frame: follow the camera; `alpha` 0 hides it. */
  update(cam: Camera, alpha: number): void {
    this.root.visible = alpha > 0;
    if (!this.root.visible) return;
    this.root.alpha = alpha;
    if (this.dirty) {
      this.dirty = false;
      this.source.update();
    }
    const scale = CELL * cam.zoom;
    const o = cam.worldToScreen(0, 0);
    this.sprite.position.set(0, o.y);
    this.sprite.width = cam.width;
    this.sprite.height = this.h * scale;
    this.sprite.tileScale.set(scale);
    this.sprite.tilePosition.set(o.x, 0);
    const g = this.marker;
    g.clear();
    // Online: every player's main base in their colour; offline: mine.
    const mains = this.game.online ? this.game.mainBases().map((m) => ({ key: m.key, color: SIGNATURE_COLORS[m.color] })) : this.game.bases.main === null ? [] : [{ key: this.game.bases.main, color: this.markerColor }];
    const r = MARKER_R;
    for (const m of mains) {
      const p = cam.worldToScreen((cam.nearCellX(keyX(m.key)) + 0.5) * CELL, (keyY(m.key) + 0.5) * CELL);
      g.poly([p.x, p.y - r - 2, p.x + r + 2, p.y, p.x, p.y + r + 2, p.x - r - 2, p.y]).fill({ color: this.markerBg, alpha: 0.9 });
      g.poly([p.x, p.y - r, p.x + r, p.y, p.x, p.y + r, p.x - r, p.y]).fill({ color: m.color });
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.source.destroy();
  }
}
