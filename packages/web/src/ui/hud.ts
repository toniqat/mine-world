import type { Game } from '@mine/core';
import { fmt } from '../format';
import { t } from '../i18n';
import { clear, el, svgIcon } from './dom';

export type PanelName = 'base' | 'settings';

export interface HudHandlers {
  cashOut(): void;
  toggleSettings(): void;
  home(): void;
  toggleFlagMode(): void;
}

/** Counters move at least this many units per second... */
const MIN_RATE = 30;
/** ...and otherwise close this fraction of the gap per second, so bigger jumps count faster. */
const CATCH_UP = 5;
/** Gains inside this window float up as one "+N". */
const FLOAT_MS = 140;

/**
 * A shown number that counts towards the real one unit by unit; the bigger
 * the gap, the faster it counts, so it always arrives quickly.
 */
class Counter {
  shown = 0;
  target = 0;

  /** Jump straight to `v` (first frame, a new world). */
  snap(v: number): void {
    this.shown = this.target = v;
  }

  /** Advance; true while still moving. */
  step(dt: number): boolean {
    const d = this.target - this.shown;
    if (d === 0) return false;
    const move = Math.max(MIN_RATE, Math.abs(d) * CATCH_UP) * dt;
    this.shown = Math.abs(d) <= move ? this.target : this.shown + Math.sign(d) * move;
    return true;
  }

  /** Whole units, rounded towards where the counter came from. */
  text(): string {
    const v = this.shown === this.target ? this.target : this.shown < this.target ? Math.floor(this.shown) : Math.ceil(this.shown);
    return fmt(Math.floor(v));
  }
}

/**
 * Three floating capsules instead of a bar: credits (top left), the unbanked
 * pool with its cap, the combo and Cash Out (top centre), and the buttons
 * (top right: flag mode in toggle input, home, settings). Credits and the pool
 * count towards their real values; what the pool gains or loses floats up
 * from it.
 */
export class Hud {
  private credits = new Counter();
  private pool = new Counter();
  private creditsEl!: HTMLElement;
  private creditsPill!: HTMLElement;
  private poolEl!: HTMLElement;
  private capEl!: HTMLElement;
  private fillEl!: HTMLElement;
  private poolPill!: HTMLElement;
  private comboEl!: HTMLElement;
  private multEl!: HTMLElement;
  private cashout!: HTMLButtonElement;
  private flagBtn!: HTMLButtonElement;
  private settingsBtn!: HTMLButtonElement;
  private game: Game | null = null;
  private lastUnbanked = 0;
  /** Pool drop that a Cash Out explains (not floated as a loss). */
  private banking = 0;
  private pending = 0;
  private pendingSince = 0;
  private last = performance.now();

  constructor(
    private hud: HTMLElement,
    private h: HudHandlers,
  ) {
    this.build();
  }

  build(): void {
    clear(this.hud);
    this.creditsEl = el('div', { class: 'value' }, '0');
    this.creditsPill = el('div', { class: 'pill credits' }, el('div', { class: 'label', text: t('hud.credits') }), this.creditsEl);

    this.poolEl = el('span', { class: 'value' }, '0');
    this.capEl = el('span', { class: 'cap' }, '');
    this.fillEl = el('div', { class: 'fill' });
    this.comboEl = el('div', { class: 'value small' }, '0');
    this.multEl = el('div', { class: 'sub' }, '×1.00');
    this.cashout = el('button', { class: 'btn primary cashout', onclick: () => this.h.cashOut() }, t('hud.cashout'));
    this.poolPill = el(
      'div',
      { class: 'pill pool' },
      el('div', { class: 'stat' }, el('div', { class: 'label', text: t('hud.unbanked') }), el('div', { class: 'amount' }, this.poolEl, this.capEl), el('div', { class: 'bar' }, this.fillEl)),
      el('div', { class: 'stat combo' }, el('div', { class: 'label', text: t('hud.streak') }), el('div', { class: 'amount' }, this.comboEl, this.multEl)),
      this.cashout,
    );

    const iconBtn = (icon: Parameters<typeof svgIcon>[0], title: string, onclick: () => void) => el('button', { class: 'btn icon', title, html: svgIcon(icon), onclick });
    this.flagBtn = iconBtn('flag', `${t('hud.flagMode')} (F)`, () => this.h.toggleFlagMode());
    this.settingsBtn = iconBtn('settings', t('hud.settings'), () => this.h.toggleSettings());
    this.hud.append(
      this.creditsPill,
      this.poolPill,
      el('div', { class: 'pill menu' }, this.flagBtn, iconBtn('home', `${t('hud.home')} (H)`, () => this.h.home()), this.settingsBtn),
    );
    if (this.game) this.paint();
  }

  /** Show `game` from scratch (no counting up from the previous world). */
  bind(game: Game): void {
    this.game = game;
    this.credits.snap(game.econ.credits);
    this.pool.snap(game.econ.unbanked);
    this.lastUnbanked = game.econ.unbanked;
    this.banking = 0;
    this.pending = 0;
    this.paint();
  }

  /** A Cash Out moved `amount` from the pool into credits: both counters run, the pool's drop is no loss. */
  cashedOut(amount: number): void {
    this.banking += amount;
    this.creditsPill.classList.remove('gaining');
    void this.creditsPill.offsetWidth;
    this.creditsPill.classList.add('gaining');
  }

  /** The pool is full and something tried to open a tile: shake it. */
  nudgeFull(): void {
    this.poolPill.classList.remove('shake');
    void this.poolPill.offsetWidth;
    this.poolPill.classList.add('shake');
  }

  update(game: Game): void {
    if (game !== this.game) this.bind(game);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const e = game.econ;

    // What the pool gained or lost since the last frame (a Cash Out's drop is not a loss).
    let d = e.unbanked - this.lastUnbanked;
    this.lastUnbanked = e.unbanked;
    if (d < 0 && this.banking > 0) {
      const b = Math.min(this.banking, -d);
      this.banking -= b;
      d += b;
    }
    if (Math.abs(d) > 1e-9) {
      if (this.pending !== 0 && Math.sign(d) !== Math.sign(this.pending)) this.flushFloat();
      if (this.pending === 0) this.pendingSince = now;
      this.pending += d;
    }
    if (this.pending !== 0 && now - this.pendingSince >= FLOAT_MS) this.flushFloat();

    this.credits.target = e.credits;
    this.pool.target = e.unbanked;
    this.credits.step(dt);
    this.pool.step(dt);
    this.paint();
  }

  private paint(): void {
    const g = this.game;
    if (!g) return;
    const e = g.econ;
    this.creditsEl.textContent = this.credits.text();
    this.poolEl.textContent = this.pool.text();
    const cap = e.capacity;
    this.capEl.textContent = isFinite(cap) ? ` / ${fmt(cap)}` : '';
    this.fillEl.style.width = isFinite(cap) && cap > 0 ? `${Math.min(100, (this.pool.shown / cap) * 100)}%` : '0%';
    this.comboEl.textContent = String(e.streak);
    this.multEl.textContent = `×${e.pointMult().toFixed(2)}`;
    const full = e.full();
    this.poolPill.classList.toggle('full', full);
    this.poolPill.title = full ? t('hud.full') : '';
    this.cashout.disabled = e.unbanked <= 0;
  }

  /** Float the gains (or losses) collected since the last float up from the pool. */
  private flushFloat(): void {
    const v = this.pending;
    this.pending = 0;
    if (Math.abs(v) < 0.5) return;
    const node = el('span', { class: 'gain' + (v < 0 ? ' loss' : ''), text: `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}` });
    this.poolPill.append(node);
    setTimeout(() => node.remove(), 1000);
  }

  setActive(name: 'settings' | null): void {
    this.settingsBtn.classList.toggle('active', name === 'settings');
  }

  setFlagMode(on: boolean, visible: boolean): void {
    this.flagBtn.classList.toggle('active', on);
    this.flagBtn.style.display = visible ? '' : 'none';
  }
}
