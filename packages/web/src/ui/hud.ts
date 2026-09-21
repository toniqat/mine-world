import type { Game } from '@mine/core';
import { fmt } from '../format';
import { t } from '../i18n';
import { clear, el, svgIcon } from './dom';

export type PanelName = 'base' | 'log' | 'stats' | 'settings';
/** HUD buttons that can show as active: the panels, plus 'main' for the base panel showing the main base. */
export type HudButton = Exclude<PanelName, 'base'> | 'main';

export interface HudHandlers {
  cashOut(): void;
  togglePanel(name: PanelName): void;
  /** Open (or close) the base panel on the main base. */
  toggleMain(): void;
  home(): void;
  toggleFlagMode(): void;
}

/** Top bar (money, cash-out, panel buttons) and bottom status bar. */
export class Hud {
  private credits!: HTMLElement;
  private income!: HTMLElement;
  private unbanked!: HTMLElement;
  private streak!: HTMLElement;
  private cashout!: HTMLButtonElement;
  private buttons = new Map<HudButton, HTMLButtonElement>();
  private statusLeft!: HTMLElement;
  private statusMode!: HTMLElement;
  private statusTarget!: HTMLElement;
  private statusRight!: HTMLElement;

  constructor(
    private hud: HTMLElement,
    private status: HTMLElement,
    private h: HudHandlers,
  ) {
    this.build();
  }

  build(): void {
    clear(this.hud);
    clear(this.status);
    this.credits = el('div', { class: 'value' }, '0');
    this.income = el('div', { class: 'sub' }, '+0/s');
    this.unbanked = el('div', { class: 'value' }, '0');
    this.streak = el('div', { class: 'sub' }, '×1.00');
    this.cashout = el('button', { class: 'btn primary cashout', onclick: () => this.h.cashOut() }, t('hud.cashout'));
    const iconBtn = (name: HudButton, icon: Parameters<typeof svgIcon>[0], title: string, onclick: () => void) => {
      const b = el('button', { class: 'btn icon', title, html: svgIcon(icon), onclick });
      this.buttons.set(name, b);
      return b;
    };
    this.hud.append(
      el(
        'div',
        { class: 'hud-left' },
        el('div', { class: 'stat' }, el('div', { class: 'label' }, t('hud.credits')), this.credits),
        el('div', { class: 'stat income' }, el('div', { class: 'label' }, ' '), this.income),
      ),
      el(
        'div',
        { class: 'hud-center' },
        el('div', { class: 'stat unbanked' }, el('div', { class: 'label' }, t('hud.unbanked')), this.unbanked),
        el('div', { class: 'stat' }, el('div', { class: 'label' }, t('hud.streak')), this.streak),
        this.cashout,
      ),
      el(
        'div',
        { class: 'hud-right' },
        el('button', { class: 'btn icon', title: 'Home (H)', html: svgIcon('home'), onclick: () => this.h.home() }),
        iconBtn('main', 'base', `${t('hud.mainBase')} (U)`, () => this.h.toggleMain()),
        iconBtn('log', 'log', t('hud.log'), () => this.h.togglePanel('log')),
        iconBtn('stats', 'stats', t('hud.stats'), () => this.h.togglePanel('stats')),
        iconBtn('settings', 'settings', t('hud.settings'), () => this.h.togglePanel('settings')),
      ),
    );
    this.statusLeft = el('span', { class: 'coords' }, '');
    this.statusMode = el('span', { class: 'mode', onclick: () => this.h.toggleFlagMode() }, t('status.mode.open'));
    this.statusTarget = el('span', { class: 'target' }, '');
    this.statusRight = el('span', { class: 'optional' }, '');
    this.status.append(this.statusMode, this.statusLeft, this.statusTarget, el('span', { class: 'spacer' }), this.statusRight);
  }

  update(game: Game): void {
    const e = game.econ;
    this.credits.textContent = fmt(e.credits);
    this.income.textContent = `+${fmt(e.incomeRate)}${t('hud.income')}`;
    this.unbanked.textContent = fmt(e.unbanked);
    this.streak.textContent = `×${e.streakMult().toFixed(2)} · ${e.streak}`;
    this.cashout.disabled = e.unbanked <= 0;
  }

  setActive(name: HudButton | null): void {
    for (const [k, b] of this.buttons) b.classList.toggle('active', k === name);
  }

  setFlagMode(on: boolean, visible: boolean): void {
    this.statusMode.textContent = on ? t('status.mode.flag') : t('status.mode.open');
    this.statusMode.classList.toggle('flag', on);
    this.statusMode.style.display = visible ? '' : 'none';
  }

  setCoords(text: string): void {
    this.statusLeft.textContent = text;
  }

  setTargetText(text: string): void {
    this.statusTarget.textContent = text;
  }

  setRight(text: string): void {
    this.statusRight.textContent = text;
  }
}
