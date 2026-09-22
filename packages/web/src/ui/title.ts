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
  private timers = new Set<number>();

  constructor(
    host: HTMLElement,
    hasSave: boolean,
    private on: { start: () => void; newGame: () => void },
  ) {
    const grain = el('div', { class: 'film-grain' });
    grain.style.backgroundImage = `url(${noiseTile()})`;
    const flicker = el('div', { class: 'film-flicker' });
    this.black = el('div', { class: 'demo-black' });
    const primary = el('button', { class: 'btn primary title-start', text: hasSave ? t('title.continue') : t('title.start'), onclick: () => this.on.start() });
    this.root = el(
      'div',
      { class: 'title' },
      this.black,
      el('div', { class: 'film' }, grain, el('div', { class: 'film-lines' }), flicker, el('div', { class: 'film-vignette' })),
      el('h1', { class: 'title-logo', text: 'MINEWORLD' }),
      el('div', { class: 'title-actions' }, primary, hasSave ? el('button', { class: 'btn title-new', text: t('title.newGame'), onclick: () => this.on.newGame() }) : null),
    );
    host.append(this.root);
    requestAnimationFrame(() => primary.focus());
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.animateFilm(grain, flicker);
  }

  /**
   * Grain and flicker on irregular timers. A CSS keyframe loop repeats the same
   * few offsets and the same flashes on a fixed period, which the eye picks up
   * as a regular wobble; random offsets and random gaps read as film instead.
   */
  private animateFilm(grain: HTMLElement, flicker: HTMLElement): void {
    const later = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        fn();
      }, ms);
      this.timers.add(id);
    };
    const shift = () => {
      const x = -Math.floor(Math.random() * 128);
      const y = -Math.floor(Math.random() * 128);
      grain.style.transform = `translate(${x}px, ${y}px) scale(${Math.random() < 0.5 ? -1 : 1}, ${Math.random() < 0.5 ? -1 : 1})`;
      later(60 + Math.random() * 50, shift);
    };
    // Rare, faint and never on a beat: one or two short lifts, then a long random gap.
    const flash = () => {
      const lifts = Math.random() < 0.3 ? 2 : 1;
      let at = 0;
      for (let i = 0; i < lifts; i++) {
        later(at, () => (flicker.style.opacity = String(0.006 + Math.random() * 0.01)));
        at += 60 + Math.random() * 70;
        later(at, () => (flicker.style.opacity = '0'));
        at += 80 + Math.random() * 120;
      }
      later(at + 4000 + Math.random() * 9000, flash);
    };
    shift();
    later(2000 + Math.random() * 5000, flash);
  }

  /** How black the demo is (0 clear, 1 black). */
  setBlack(v: number): void {
    this.black.style.opacity = String(v);
  }

  /** Slide the logo up and the buttons down while everything fades; removes itself when done. */
  leave(): void {
    this.root.classList.add('leaving');
    for (const b of this.root.querySelectorAll('button')) b.disabled = true;
    setTimeout(() => {
      for (const id of this.timers) clearTimeout(id);
      this.root.remove();
    }, TITLE_LEAVE_MS + 50);
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
