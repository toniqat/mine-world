/**
 * Theme tokens modelled on VS Code "Light Modern" / "Dark Modern":
 * flat surfaces, thin 1px borders, one accent, muted secondary text.
 * CSS variables drive the DOM; the numeric palette drives Pixi.
 */
export type ThemeName = 'light' | 'dark';
export type ThemeSetting = 'auto' | ThemeName;

export interface Palette {
  name: ThemeName;
  bg: number;
  surface: number;
  border: number;
  fg: number;
  fgMuted: number;
  accent: number;
  error: number;
  warning: number;
  success: number;
  cellUnknown: number;
  cellUnknownHover: number;
  cellRevealed: number;
  cellGrid: number;
  cellOwned: number;
  cellLost: number;
  /** Terrain walls (no tile): mountains and rivers. */
  cellMountain: number;
  cellWater: number;
  /** Fog of war: unseen cells (walls included) all look the same: a faint tile with a dashed outline in this colour. */
  cellFog: number;
  /** Tiles in a mining tier whose technology is not learned yet (drawn with a padlock); unlocked tiles use cellUnknown. */
  cellLocked: number;
  /** Single colour for all neighbour counts. */
  digit: number;
  probLow: number;
  probHigh: number;
}

export const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    name: 'dark',
    bg: 0x1f1f1f,
    surface: 0x181818,
    border: 0x2b2b2b,
    fg: 0xcccccc,
    fgMuted: 0x9d9d9d,
    accent: 0x0078d4,
    error: 0xf14c4c,
    warning: 0xcca700,
    success: 0x89d185,
    cellUnknown: 0x333333,
    cellUnknownHover: 0x3f3f3f,
    cellRevealed: 0x161616,
    cellGrid: 0x1f1f1f,
    cellOwned: 0x0078d4,
    cellLost: 0x4d4d4d,
    cellMountain: 0x3a3226,
    cellWater: 0x1d3347,
    cellFog: 0x6e6e6e,
    cellLocked: 0x3a3550,
    digit: 0xcccccc,
    probLow: 0x89d185,
    probHigh: 0xf14c4c,
  },
  light: {
    name: 'light',
    bg: 0xffffff,
    surface: 0xf8f8f8,
    border: 0xe5e5e5,
    fg: 0x3b3b3b,
    fgMuted: 0x616161,
    accent: 0x005fb8,
    error: 0xe51400,
    warning: 0xbf8803,
    success: 0x388a34,
    cellUnknown: 0xdcdcdc,
    cellUnknownHover: 0xcfcfcf,
    cellRevealed: 0xfafafa,
    cellGrid: 0xeeeeee,
    cellOwned: 0x005fb8,
    cellLost: 0xb0b0b0,
    cellMountain: 0xc9b99a,
    cellWater: 0xa9cbe6,
    cellFog: 0x9a9a9a,
    cellLocked: 0xd4cce8,
    digit: 0x3b3b3b,
    probLow: 0x388a34,
    probHigh: 0xe51400,
  },
};

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolveTheme(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') return mq && mq.matches ? 'dark' : 'light';
  return setting;
}

export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
}

export function onSystemThemeChange(fn: () => void): () => void {
  if (!mq) return () => {};
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}

export function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}
