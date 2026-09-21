import { Container, Graphics, Rectangle, Text, type Renderer, type Texture } from 'pixi.js';
import { CellState } from '@mine/core';
import { hex, type Palette } from '../theme';

/** Cell size in world units (pixels at zoom 1). */
export const CELL = 32;

export interface CellTextures {
  unknown: Texture;
  unknownHover: Texture;
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
  return { unknown, unknownHover, revealed, flag, flagGlyph, owned, ownedIsolated, ownedDisabled, lost, exploded, digits, empty };
}

export function destroyTextures(t: CellTextures): void {
  // digits[0] is `empty`; destroy it once.
  for (const tex of [t.unknown, t.unknownHover, t.revealed, t.flag, t.flagGlyph, t.owned, t.ownedIsolated, t.ownedDisabled, t.lost, t.exploded, t.empty, ...t.digits.slice(1)]) tex.destroy(true);
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
    default:
      return s >= CellState.RevealedBase ? t.revealed : t.unknown;
  }
}
