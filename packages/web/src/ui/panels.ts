import { UPGRADES, type BaseInfo, type Game } from '@mine/core';
import { fmt } from '../format';
import { getLang, t, upgradeDesc, upgradeName, type StringKey } from '../i18n';
import { isTouchDevice } from '../device';
import type { Settings } from '../storage';
import { clear, el } from './dom';
import type { PanelName } from './hud';

export interface PanelHandlers {
  buy(id: string): void;
  upgradeMainBase(): void;
  newGame(): void;
  saveNow(): void;
  settingsChanged(s: Settings): void;
}

/** How long the popover takes to drop in or lift away (matches style.css). */
const POP_MS = 180;

/**
 * Popover under the top-right capsule, like a context menu: the main base
 * (its level-up and the upgrades) or settings. There is no close button: the
 * app closes it on a click anywhere outside it (or its own HUD button again).
 * It drops in from a little above while fading in, scrolls vertically when it
 * runs long, and is re-rendered from game state on demand.
 */
export class Panels {
  current: PanelName | null = null;
  private body: HTMLElement;
  private title: HTMLElement;
  private hideTimer = 0;

  constructor(
    private root: HTMLElement,
    private h: PanelHandlers,
  ) {
    this.title = el('h2', {}, '');
    this.body = el('div', { class: 'panel-body' });
    root.append(el('div', { class: 'panel-head' }, this.title), this.body);
  }

  open(name: PanelName | null, game: Game, settings: Settings): void {
    const was = this.current;
    this.current = name;
    clearTimeout(this.hideTimer);
    if (name === null) {
      if (was === null) return;
      this.root.classList.remove('show');
      this.hideTimer = window.setTimeout(() => (this.root.hidden = true), POP_MS);
      return;
    }
    this.render(game, settings);
    if (was === name && !this.root.hidden) return;
    // Switching from one popover to another drops the new one in again.
    this.root.classList.remove('show');
    this.root.hidden = false;
    void this.root.offsetWidth;
    this.root.classList.add('show');
    this.body.scrollTop = 0;
  }

  render(game: Game, settings: Settings): void {
    if (!this.current) return;
    this.title.textContent = t(`panel.${this.current}` as StringKey);
    const scroll = this.body.scrollTop;
    clear(this.body);
    switch (this.current) {
      case 'base':
        this.renderBase(game);
        break;
      case 'settings':
        this.renderSettings(game, settings);
        break;
    }
    this.body.scrollTop = scroll;
  }

  private renderBase(game: Game): void {
    const bases = game.bases;
    const b = bases.main === null ? null : bases.info(bases.main);
    if (!b) {
      this.title.textContent = t('base.main');
      this.body.append(el('div', { class: 'help', text: t('base.noMain') }));
      return;
    }
    this.renderMainBase(game, b);
  }

  /** Main base: multiplier and pool cap, the next level with its level-up button, then the upgrades. */
  private renderMainBase(game: Game, b: BaseInfo): void {
    const bases = game.bases;
    this.title.textContent = `${t('base.main')} ${t('level', { n: b.level })}`;
    let active = 0;
    for (const k of game.econ.owned.keys()) if (bases.isBase(k) && !bases.isolated.has(k)) active++;
    const e = game.econ;
    this.body.append(kv(t('base.mult'), `×${e.baseMult.toFixed(2)}`), kv(t('base.active'), String(active)));
    if (bases.isolated.size) this.body.append(kv(t('base.isolatedCount'), String(bases.isolated.size)));
    if (bases.disabled.size) this.body.append(kv(t('base.disabledCount'), String(bases.disabled.size)));
    this.body.append(kv(t('base.capacity'), fmt(e.capacity)));
    if (bases.maxed()) this.body.append(kv(t('base.nextLevel'), t('maxed')));
    else {
      const cost = bases.upgradeCost();
      this.body.append(
        kv(t('base.nextLevel'), t('base.upgrade.next', { n: b.level + 1, cap: fmt(bases.capacity(b.level + 1)) })),
        costButton(t('base.upgrade.button'), cost, game.econ.canAfford(cost), () => this.h.upgradeMainBase(), 'wide'),
      );
    }

    this.body.append(el('div', { class: 'section', text: t('base.upgrades') }));
    const shown = UPGRADES.filter((x) => x.group === 'misc' || (x.group === 'tech' && game.cfg.tiers.enabled));
    for (const u of shown) this.body.append(this.upgradeRow(game, u.id));
  }

  private upgradeRow(game: Game, id: string): HTMLElement {
    const level = game.upgrades.level(id);
    const cost = game.upgrades.cost(id);
    const blocked = game.upgrades.blocked(id);
    const now = id === 'streak_cap' ? t('up.streak_cap.now', { v: (game.econ.cfg.streakMultCap + game.econ.streakCapBonus).toFixed(1) }) : null;
    const left = el(
      'div',
      {},
      el('div', { class: 'name' }, upgradeName(id), level > 0 ? el('span', { class: 'badge on', text: t('level', { n: level }) }) : null),
      el('div', { class: 'desc', text: upgradeDesc(id) }),
      now ? el('div', { class: 'desc', text: now }) : null,
    );
    let right: HTMLElement;
    if (blocked === 'maxed') right = el('span', { class: 'cost', text: t('maxed') });
    else if (blocked === 'requires') right = el('span', { class: 'cost', text: t('requires', { name: upgradeName(UPGRADES.find((u) => u.id === id)!.requires!) }) });
    else right = costButton(t('buy'), cost, game.econ.canAfford(cost), () => this.h.buy(id));
    return el('div', { class: 'row' }, left, right);
  }

  private renderSettings(game: Game, s: Settings): void {
    const field = (label: string, control: HTMLElement) => el('div', { class: 'field' }, el('span', {}, label), control);
    const select = (value: string, options: Array<[string, string]>, onchange: (v: string) => void) => {
      const sel = el('select', { onchange: (e) => onchange((e.target as HTMLSelectElement).value) });
      for (const [v, label] of options) sel.append(el('option', { value: v, selected: v === value, text: label }));
      return sel;
    };
    const check = (value: boolean, onchange: (v: boolean) => void) =>
      el('input', { type: 'checkbox', checked: value, onchange: (e) => onchange((e.target as HTMLInputElement).checked) });
    const emit = () => this.h.settingsChanged(s);
    // Touch devices have one input: a tap marks (no input mode, no long press).
    const touch = isTouchDevice();
    this.body.append(
      field(
        t('settings.theme'),
        select(s.theme, [['auto', t('settings.theme.auto')], ['light', t('settings.theme.light')], ['dark', t('settings.theme.dark')]], (v) => {
          s.theme = v as Settings['theme'];
          emit();
        }),
      ),
      field(
        t('settings.lang'),
        select(s.lang, [['auto', t('settings.lang.auto')], ['ko', '한국어'], ['en', 'English']], (v) => {
          s.lang = v as Settings['lang'];
          emit();
        }),
      ),
      touch ? '' : field(
        t('settings.input'),
        select(s.inputMode, [['classic', t('settings.input.classic')], ['toggle', t('settings.input.toggle')]], (v) => {
          s.inputMode = v as Settings['inputMode'];
          emit();
        }),
      ),
      touch ? '' : field(
        t('settings.longPress'),
        el('input', {
          type: 'number',
          min: 200,
          max: 1500,
          step: 50,
          value: s.longPressMs,
          onchange: (e) => {
            s.longPressMs = Number((e.target as HTMLInputElement).value) || 450;
            emit();
          },
        }),
      ),
      field(
        t('settings.showDensity'),
        check(s.showDensity, (v) => {
          s.showDensity = v;
          emit();
        }),
      ),
      field(
        t('settings.intervention'),
        select(
          s.interventionMode,
          [['FAIR', t('settings.intervention.FAIR')], ['FORGIVING', t('settings.intervention.FORGIVING')], ['STRICT', t('settings.intervention.STRICT')]],
          (v) => {
            s.interventionMode = v as Settings['interventionMode'];
            emit();
          },
        ),
      ),
      el(
        'div',
        { class: 'field' },
        el('span', {}, `${t('status.seed')} ${game.cfg.seed}`),
        el('div', {}, el('button', { class: 'btn small', text: t('settings.save'), onclick: () => this.h.saveNow() }), ' ', el('button', { class: 'btn small danger', text: t('settings.newGame'), onclick: () => this.h.newGame() })),
      ),
      el('div', { class: 'help', text: t(touch ? 'settings.help.touch' : 'settings.help') }),
      el('div', { class: 'help', text: `v0.1 · ${getLang()}` }),
    );
  }
}

/** A buy button with its credit cost inside; dimmed while unaffordable. */
export function costButton(label: string, cost: number, afford: boolean, onclick: () => void, extra = ''): HTMLElement {
  return el(
    'button',
    { class: `btn cost-btn${afford ? ' primary' : ''}${extra ? ' ' + extra : ''}`, disabled: !afford, onclick },
    el('span', { text: label }),
    el('span', { class: 'cost-in', text: fmt(cost) }),
  );
}

function kv(label: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, el('span', {}, label), el('span', { class: 'v', text: value }));
}
