import { isTouchDevice } from '../device';
import { t, type StringKey } from '../i18n';
import { el } from './dom';

/** How long the title takes to leave (logo up, buttons down, film fading). */
export const TITLE_LEAVE_MS = 700;

/**
 * Title screen: the MINEWORLD logo (top centre), two mode buttons of the same
 * size side by side (bottom centre): single player on the left, Earth
 * multiplayer on the right. A mode with something to go back to (a save, a
 * kept seat) says Continue and has a small New game button under it. A film
 * layer (grain, scanlines, vignette, a faint flicker) lies over the demo that
 * plays behind it, so it reads as a recording.
 */
export class TitleScreen {
  private root: HTMLElement;
  /** Black layer between the demo and the film, for the fade from one demo world to the next. */
  private black: HTMLElement;
  private timers = new Set<number>();
  private multiBtn: HTMLButtonElement;
  private multiLabel: string;

  constructor(
    host: HTMLElement,
    /** The endless world has a save: the single button continues it. */
    hasSave: boolean,
    /** A multiplayer token is kept: the multi button rejoins that player. */
    multiRejoin: boolean,
    private on: { single: () => void; singleNew: () => void; multi: () => void; multiNew: () => void },
  ) {
    const grain = el('div', { class: 'film-grain' });
    grain.style.backgroundImage = `url(${noiseTile()})`;
    const flicker = el('div', { class: 'film-flicker' });
    this.black = el('div', { class: 'demo-black' });
    const single = el('button', { class: 'btn primary title-start', text: t(hasSave ? 'title.singleContinue' : 'title.single'), onclick: () => this.on.single() });
    this.multiLabel = t(multiRejoin ? 'title.multiContinue' : 'title.multi');
    this.multiBtn = el('button', { class: 'btn primary title-start', text: this.multiLabel, onclick: () => this.on.multi() });
    const mode = (main: HTMLElement, fresh: (() => void) | null) =>
      el('div', { class: 'title-mode' }, main, fresh ? el('button', { class: 'btn small title-new', text: t('title.newGame'), onclick: fresh }) : null);
    this.root = el(
      'div',
      { class: 'title' },
      this.black,
      el('div', { class: 'film' }, grain, el('div', { class: 'film-lines' }), flicker, el('div', { class: 'film-vignette' })),
      el('h1', { class: 'title-logo', text: 'MINEWORLD' }),
      el(
        'div',
        { class: 'title-actions' },
        mode(single, hasSave ? () => this.on.singleNew() : null),
        mode(this.multiBtn, multiRejoin ? () => this.on.multiNew() : null),
      ),
    );
    host.append(this.root);
    requestAnimationFrame(() => single.focus());
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

  /** While the multi button waits for the server: every button is off and it says so. */
  connecting(on: boolean): void {
    for (const b of this.root.querySelectorAll('button')) b.disabled = on;
    this.multiBtn.textContent = on ? t('title.connecting') : this.multiLabel;
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

/** "Click anywhere to found the main base" ("click land" on the Earth map), shown on a fresh world until the first cell opens. */
export class StartHint {
  private node: HTMLElement;

  constructor(host: HTMLElement, earth = false) {
    const key = earth ? 'title.hint.earth' : 'title.hint';
    this.node = el('div', { class: 'start-hint', text: t((isTouchDevice() ? `${key}.touch` : key) as StringKey) });
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

/** Earth mode zoomed out past the scale tiles can be played at: a quiet note that the view is look-only. */
export class ViewHint {
  private node: HTMLElement;
  private on = false;

  constructor(host: HTMLElement) {
    this.node = el('div', { class: 'start-hint view-hint', text: t('view.only') });
    host.append(this.node);
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.node.classList.toggle('show', on);
  }

  /** Language changed. */
  relabel(): void {
    this.node.textContent = t('view.only');
  }
}
