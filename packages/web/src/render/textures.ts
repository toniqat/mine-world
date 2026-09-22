import { Container, Graphics, Rectangle, Text, type Renderer, type Texture } from 'pixi.js';
import { CellState } from '@mine/core';
import { hex, type Palette } from '../theme';

/** Cell size in world units (pixels at zoom 1). */
export const CELL = 32;

export interface CellTextures {
  unknown: Texture;
  unknownHover: Texture;
  /** An Unknown cell marked "?" (a plain note), and its hover state. */
  question: Texture;
  questionHover: Texture;
  revealed: Texture;
  flag: Texture;
  /** Flag pole + pennant on a transparent cell, for the marking animation. */
  flagGlyph: Texture;
  owned: Texture;
  /** An Owned mine in an isolated complex: the same mark, translucent. */
  ownedIsolated: Texture;
  /** An Owned mine knocked out by an explosion: a muted mark struck through. */
  ownedDisabled: Texture;
  lost: Texture;
  exploded: Texture;
  /** Terrain walls: full-bleed fills (no tile edge) so neighbouring walls merge into one shape. */
  mountain: Texture;
  water: Texture;
  /** Fog of war: a faint tile with a dashed outline; hides whether a wall lies under it. */
  fog: Texture;
  /** A tile in a mining tier whose technology is not learned yet: its own colour and a padlock. */
  locked: Texture;
  digits: Texture[]; // index 1..8
  empty: Texture;
}

const RES = 2;
/** Radius of the base (Owned mine) dot. */
const BASE_R = 4;

function gen(renderer: Renderer, draw: (g: Graphics) => void): Texture {
  const g = new Graphics();
  draw(g);
  const tex = renderer.generateTexture({ target: g, resolution: RES, frame: new Rectangle(0, 0, CELL, CELL) });
  g.destroy();
  return tex;
}

function tile(g: Graphics, fill: number, grid: number): void {
  g.rect(0, 0, CELL, CELL).fill(grid);
  g.roundRect(1, 1, CELL - 2, CELL - 2, 3).fill(fill);
}

/** Build the per-theme texture atlas. Everything is vector-drawn at 2x, so it stays crisp when zoomed. */
export function buildTextures(renderer: Renderer, p: Palette): CellTextures {
  const c = CELL / 2;
  const unknown = gen(renderer, (g) => tile(g, p.cellUnknown, p.cellGrid));
  const unknownHover = gen(renderer, (g) => tile(g, p.cellUnknownHover, p.cellGrid));
  const revealed = gen(renderer, (g) => {
    g.rect(0, 0, CELL, CELL).fill(p.cellGrid);
    g.rect(0.5, 0.5, CELL - 1, CELL - 1).fill(p.cellRevealed);
  });
  // Pole + pennant, one colour.
  const drawFlag = (g: Graphics) => {
    g.moveTo(c - 4, c - 8).lineTo(c - 4, c + 9).stroke({ width: 2, color: p.accent });
    g.poly([c - 3, c - 8, c + 8, c - 3, c - 3, c + 2]).fill(p.accent);
  };
  const flag = gen(renderer, (g) => {
    tile(g, p.cellUnknown, p.cellGrid);
    drawFlag(g);
  });
  const flagGlyph = gen(renderer, drawFlag);
  const owned = gen(renderer, (g) => {
    tile(g, p.cellRevealed, p.cellGrid);
    g.circle(c, c, BASE_R).fill(p.cellOwned);
    g.circle(c, c, BASE_R / 2).fill({ color: 0xffffff, alpha: 0.35 });
  });
  const ownedIsolated = gen(renderer, (g) => {
    tile(g, p.cellRevealed, p.cellGrid);
    g.circle(c, c, BASE_R).fill({ color: p.cellOwned, alpha: 0.35 });
  });
  const ownedDisabled = gen(renderer, (g) => {
    tile(g, p.cellRevealed, p.cellGrid);
    g.circle(c, c, BASE_R).fill({ color: p.fgMuted, alpha: 0.35 });
    g.moveTo(c - 5, c + 5).lineTo(c + 5, c - 5).stroke({ width: 2, color: p.error, alpha: 0.85 });
  });
  const lost = gen(renderer, (g) => {
    tile(g, p.cellRevealed, p.cellGrid);
    g.poly([c, c - 8, c + 8, c, c, c + 8, c - 8, c]).fill(p.cellLost);
    g.moveTo(c - 6, c - 6).lineTo(c + 6, c + 6).stroke({ width: 2, color: p.cellRevealed });
  });
  const exploded = gen(renderer, (g) => {
    tile(g, p.cellRevealed, p.cellGrid);
    g.circle(c, c, 7).fill(p.error);
    g.circle(c, c, 3).fill({ color: 0xffffff, alpha: 0.5 });
  });
  const mountain = gen(renderer, (g) => {
    g.rect(0, 0, CELL, CELL).fill(p.cellMountain);
    g.poly([c - 6, c + 4, c, c - 5, c + 6, c + 4]).fill({ color: p.fg, alpha: 0.12 });
  });
  const water = gen(renderer, (g) => {
    g.rect(0, 0, CELL, CELL).fill(p.cellWater);
    g.moveTo(c - 7, c + 1).quadraticCurveTo(c - 3.5, c - 3, c, c + 1).quadraticCurveTo(c + 3.5, c + 5, c + 7, c + 1).stroke({ width: 1.5, color: p.fg, alpha: 0.15 });
  });
  const fog = gen(renderer, (g) => {
    g.roundRect(1, 1, CELL - 2, CELL - 2, 3).fill({ color: p.cellUnknown, alpha: 0.22 });
    dashedRect(g, 1.5, 1.5, CELL - 3, CELL - 3);
    g.stroke({ width: 1, color: p.cellFog, alpha: 0.55 });
  });
  const drawLock = (g: Graphics) => {
    g.roundRect(c - 4, c - 1, 8, 6, 1).fill({ color: p.fgMuted, alpha: 0.55 });
    g.arc(c, c - 1, 2.75, Math.PI, 0).stroke({ width: 1.5, color: p.fgMuted, alpha: 0.55 });
  };
  const locked = gen(renderer, (g) => (tile(g, p.cellLocked, p.cellGrid), drawLock(g)));
  const questionTile = (fill: number) => {
    const text = new Text({
      text: '?',
      style: { fontFamily: 'Cascadia Code, SF Mono, Consolas, Roboto Mono, monospace', fontSize: 17, fontWeight: '700', fill: hex(p.fgMuted) },
    });
    text.anchor.set(0.5);
    text.position.set(c, c + 1);
    const holder = new Container();
    const g = new Graphics();
    tile(g, fill, p.cellGrid);
    holder.addChild(g, text);
    const tex = renderer.generateTexture({ target: holder, resolution: RES, frame: new Rectangle(0, 0, CELL, CELL) });
    holder.destroy({ children: true });
    return tex;
  };
  const question = questionTile(p.cellUnknown);
  const questionHover = questionTile(p.cellUnknownHover);
  const empty = gen(renderer, () => {});
  const digits: Texture[] = [empty];
  for (let n = 1; n <= 8; n++) {
    const text = new Text({
      text: String(n),
      style: {
        fontFamily: 'Cascadia Code, SF Mono, Consolas, Roboto Mono, monospace',
        fontSize: 17,
        fontWeight: '700',
        fill: hex(p.digit),
      },
    });
    text.anchor.set(0.5);
    text.position.set(c, c + 1);
    const holder = new Container();
    holder.addChild(text);
    const tex = renderer.generateTexture({ target: holder, resolution: RES, frame: new Rectangle(0, 0, CELL, CELL) });
    holder.destroy({ children: true });
    digits.push(tex);
  }
  return { unknown, unknownHover, question, questionHover, revealed, flag, flagGlyph, owned, ownedIsolated, ownedDisabled, lost, exploded, mountain, water, fog, locked, digits, empty };
}

/** Outline of a rect as dashes (call `stroke` afterwards). */
function dashedRect(g: Graphics, x: number, y: number, w: number, h: number, dash = 3, gap = 2.5): void {
  const edge = (x0: number, y0: number, dx: number, dy: number, len: number) => {
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(len, d + dash);
      g.moveTo(x0 + dx * d, y0 + dy * d).lineTo(x0 + dx * e, y0 + dy * e);
    }
  };
  edge(x, y, 1, 0, w);
  edge(x + w, y, 0, 1, h);
  edge(x + w, y + h, -1, 0, w);
  edge(x, y + h, 0, -1, h);
}

export function destroyTextures(t: CellTextures): void {
  // digits[0] is `empty`; destroy it once.
  for (const tex of [t.unknown, t.unknownHover, t.question, t.questionHover, t.revealed, t.flag, t.flagGlyph, t.owned, t.ownedIsolated, t.ownedDisabled, t.lost, t.exploded, t.mountain, t.water, t.fog, t.locked, t.empty, ...t.digits.slice(1)]) tex.destroy(true);
}

/** Background texture for a cell state. */
export function stateTexture(t: CellTextures, s: number): Texture {
  switch (s) {
    case CellState.Flag:
      return t.flag;
    case CellState.Owned:
      return t.owned;
    case CellState.Lost:
      return t.lost;
    case CellState.Exploded:
      return t.exploded;
    case CellState.Mountain:
      return t.mountain;
    case CellState.Water:
      return t.water;
    default:
      return s >= CellState.RevealedBase ? t.revealed : t.unknown;
  }
}
