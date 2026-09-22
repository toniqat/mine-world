import { t } from '../i18n';
import { el } from './dom';

/** How long the title takes to leave (logo up, buttons down, film fading). */
export const TITLE_LEAVE_MS = 700;

/**
 * Title screen: the MINEWORLD logo (top centre), a large start button
 * (bottom centre; with a save it continues, and a smaller button starts a new
 * game) and a film layer (grain, scanlines, vignette, a faint flicker) over
 * the demo that plays behind it, so it reads as a recording.
 */
export class TitleScreen {
  private root: HTMLElement;
  /** Black layer between the demo and the film, for the fade from one demo world to the next. */
  private black: HTMLElement;

  constructor(
    host: HTMLElement,
    hasSave: boolean,
    private on: { start: () => void; newGame: () => void },
  ) {
    const grain = el('div', { class: 'film-grain' });
    grain.style.backgroundImage = `url(${noiseTile()})`;
    this.black = el('div', { class: 'demo-black' });
    const primary = el('button', { class: 'btn primary title-start', text: hasSave ? t('title.continue') : t('title.start'), onclick: () => this.on.start() });
    this.root = el(
      'div',
      { class: 'title' },
      this.black,
      el('div', { class: 'film' }, grain, el('div', { class: 'film-lines' }), el('div', { class: 'film-flicker' }), el('div', { class: 'film-vignette' })),
      el('h1', { class: 'title-logo', text: 'MINEWORLD' }),
      el('div', { class: 'title-actions' }, primary, hasSave ? el('button', { class: 'btn title-new', text: t('title.newGame'), onclick: () => this.on.newGame() }) : null),
    );
    host.append(this.root);
    requestAnimationFrame(() => primary.focus());
  }

  /** How black the demo is (0 clear, 1 black). */
  setBlack(v: number): void {
    this.black.style.opacity = String(v);
  }

  /** Slide the logo up and the buttons down while everything fades; removes itself when done. */
  leave(): void {
    this.root.classList.add('leaving');
    for (const b of this.root.querySelectorAll('button')) b.disabled = true;
    setTimeout(() => this.root.remove(), TITLE_LEAVE_MS + 50);
  }
}

/** "Click anywhere to found the main base", shown on a fresh world until the first cell opens. */
export class StartHint {
  private node: HTMLElement;

  constructor(host: HTMLElement) {
    this.node = el('div', { class: 'start-hint', text: t('title.hint') });
    host.append(this.node);
    requestAnimationFrame(() => this.node.classList.add('show'));
  }

  hide(): void {
    this.node.classList.remove('show');
    setTimeout(() => this.node.remove(), 300);
  }
}

/** A small tile of monochrome noise for the grain layer. */
function noiseTile(size = 128): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
