import { UPGRADES, keyX, keyY, type BaseInfo, type Game } from '@mine/core';
import { fmt } from '../format';
import { getLang, t, upgradeDesc, upgradeName, type StringKey } from '../i18n';
import type { Settings } from '../storage';
import { clear, el } from './dom';
import type { PanelName } from './hud';

export interface PanelHandlers {
  buy(id: string): void;
  gotoCell(x: number, y: number): void;
  upgradeMainBase(): void;
  repairBase(x: number, y: number): void;
  newGame(): void;
  saveNow(): void;
  settingsChanged(s: Settings): void;
  close(): void;
}

/** How long the popover takes to drop in or lift away (matches style.css). */
const POP_MS = 180;

/**
 * Popover under the top-right capsule, like a context menu: the selected
 * base (the main base doubles as the upgrade screen) or settings. It drops in
 * from a little above while fading in, scrolls vertically when it runs long,
 * and is re-rendered from game state on demand.
 */
export class Panels {
  current: PanelName | null = null;
  /** Base shown by the 'base' panel; null shows the main base (or a hint before it exists). */
  base: number | null = null;
  private body: HTMLElement;
  private title: HTMLElement;
  /** Header slot left of the close button (the main base's level-up). */
  private headExtra: HTMLElement;
  private hideTimer = 0;

  constructor(
    private root: HTMLElement,
    private h: PanelHandlers,
  ) {
    this.title = el('h2', {}, '');
    this.body = el('div', { class: 'panel-body' });
    this.headExtra = el('div', { class: 'panel-head-extra' });
    root.append(
      el('div', { class: 'panel-head' }, this.title, el('div', { class: 'panel-head-right' }, this.headExtra, el('button', { class: 'btn small', text: '✕', onclick: () => h.close() }))),
      this.body,
    );
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
    clear(this.headExtra);
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
    const key = this.base ?? bases.main;
    const b = key === null ? null : bases.info(key);
    if (!b) {
      this.title.textContent = t('base.main');
      this.body.append(el('div', { class: 'help', text: t('base.noMain') }));
      return;
    }
    if (b.main) this.renderMainBase(game, b);
    else this.renderOtherBase(game, b);
  }

  /** Main base: level and level-up in the header; multiplier, pool cap and upgrades below. */
  private renderMainBase(game: Game, b: BaseInfo): void {
    const bases = game.bases;
    this.title.textContent = `${t('base.main')} ${t('level', { n: b.level })}`;
    if (bases.maxed()) this.headExtra.append(el('span', { class: 'cost', text: t('maxed') }));
    else {
      const cost = bases.upgradeCost();
      const afford = game.econ.canAfford(cost);
      this.headExtra.append(
        el('span', { class: 'cost' + (afford ? ' ok' : ''), text: fmt(cost) }),
        el('button', { class: 'btn small' + (afford ? ' primary' : ''), disabled: !afford, text: t('base.upgrade.button'), onclick: () => this.h.upgradeMainBase() }),
      );
    }

    let active = 0;
    for (const k of game.econ.owned.keys()) if (bases.isBase(k) && !bases.isolated.has(k)) active++;
    const e = game.econ;
    this.body.append(
      el('div', { class: 'help', text: t('base.mainHint', { tile: e.cfg.tilePoints, base: e.cfg.basePoints, per: e.cfg.multPerBase }) }),
      kv(t('base.mult'), `×${e.baseMult.toFixed(2)}`),
      kv(t('base.active'), String(active)),
    );
    if (bases.isolated.size) this.body.append(kv(t('base.isolatedCount'), String(bases.isolated.size)));
    if (bases.disabled.size) this.body.append(kv(t('base.disabledCount'), String(bases.disabled.size)));
    this.body.append(kv(t('base.capacity'), fmt(e.capacity)));
    if (!bases.maxed()) this.body.append(kv(t('base.nextLevel'), t('base.upgrade.next', { n: b.level + 1, cap: fmt(bases.capacity(b.level + 1)) })));

    this.body.append(el('div', { class: 'section', text: t('base.upgrades') }));
    for (const u of UPGRADES.filter((x) => x.group === 'misc')) this.body.append(this.upgradeRow(game, u.id));

    if (game.cfg.tiers.enabled) {
      this.body.append(el('div', { class: 'section', text: t('base.tech') }), el('div', { class: 'help', text: t('base.techHint') }));
      for (const u of UPGRADES.filter((x) => x.group === 'tech')) this.body.append(this.upgradeRow(game, u.id));
    }
  }

  /** What the next mining level opens: where its tier begins, its mine value and blast range. */
  private miningNow(game: Game, id: string): string | null {
    if (id !== 'mining') return null;
    const tier = game.miningTier() + 1;
    const c = game.cfg.tiers;
    const r = c.radii[tier - 2];
    if (r === undefined) return null;
    const range = game.cfg.blast.radiusByTier[Math.min(game.cfg.blast.radiusByTier.length - 1, tier - 1)];
    return t('up.mining.now', { c: tier - 1, t: tier, r, min: range[0], max: range[1] });
  }

  private upgradeRow(game: Game, id: string): HTMLElement {
    const level = game.upgrades.level(id);
    const cost = game.upgrades.cost(id);
    const blocked = game.upgrades.blocked(id);
    const afford = game.econ.canAfford(cost);
    const now =
      id === 'streak_cap'
        ? t('up.streak_cap.now', { v: (game.econ.cfg.streakMultCap + game.econ.streakCapBonus).toFixed(1) })
        : this.miningNow(game, id);
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
    else {
      right = el(
        'div',
        { style: 'text-align:right' },
        el('div', { class: 'cost' + (afford ? ' ok' : ''), text: fmt(cost) }),
        el('button', { class: 'btn small' + (afford ? ' primary' : ''), disabled: !afford, text: t('buy'), onclick: () => this.h.buy(id) }),
      );
    }
    return el('div', { class: 'row' }, left, right);
  }

  private renderOtherBase(game: Game, b: BaseInfo): void {
    const bases = game.bases;
    const main = bases.main;
    const gotoMain = main === null ? null : el('button', { class: 'btn small', text: t('base.gotoMain'), onclick: () => this.h.gotoCell(keyX(main), keyY(main)) });
    if (b.disabled) {
      this.title.textContent = `${t('base.disabled')} (${b.x}, ${b.y})`;
      const cost = game.repairCost();
      const afford = game.econ.canAfford(cost);
      this.body.append(
        el('div', { class: 'help', text: t('base.disabledHint') }),
        el(
          'div',
          { class: 'row' },
          el('div', { class: 'desc', text: t('base.repairCost') }),
          el(
            'div',
            { style: 'text-align:right' },
            el('div', { class: 'cost' + (afford ? ' ok' : ''), text: fmt(cost) }),
            el('button', { class: 'btn small' + (afford ? ' primary' : ''), disabled: !afford, text: t('base.repair'), onclick: () => this.h.repairBase(b.x, b.y) }),
          ),
        ),
      );
      if (gotoMain) this.body.append(gotoMain);
      return;
    }
    this.title.textContent = `${b.isolated ? t('base.isolated') : t('base.name')} (${b.x}, ${b.y})`;
    if (b.isolated) this.body.append(el('div', { class: 'help', text: t('base.isolatedHint') }));
    this.body.append(kv(t('base.multShare'), `+${b.multShare.toFixed(2)}`));
    if (b.complexSize > 1) this.body.append(kv(t('base.complex'), t('base.complexValue', { n: b.complexSize })));
    if (b.complexBonus > 1) this.body.append(kv(t('base.grand'), `×${b.complexBonus.toFixed(2)}`));
    if (!b.isolated) this.body.append(kv(t('base.route'), b.route ? t('base.routeValue', { n: b.route, hops: b.hops }) : t('base.inMain')));
    if (b.children) this.body.append(kv(t('base.children'), String(b.children)));
    this.body.append(el('div', { class: 'help', text: t('base.normalHint') }));
    if (gotoMain) this.body.append(gotoMain);
    if (b.parent !== null) {
      const k = b.parent;
      const label = k === main ? `${t('base.main')} (${keyX(k)}, ${keyY(k)})` : `(${keyX(k)}, ${keyY(k)})`;
      this.body.append(el('div', {}, el('div', { class: 'section', text: t('base.parent') }), el('span', { class: 'chip', text: label, onclick: () => this.h.gotoCell(keyX(k), keyY(k)) })));
    }
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
      field(
        t('settings.input'),
        select(s.inputMode, [['classic', t('settings.input.classic')], ['toggle', t('settings.input.toggle')]], (v) => {
          s.inputMode = v as Settings['inputMode'];
          emit();
        }),
      ),
      field(
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
      el('div', { class: 'help', text: t('settings.help') }),
      el('div', { class: 'help', text: `v0.1 · ${getLang()}` }),
    );
  }
}

function kv(label: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, el('span', {}, label), el('span', { class: 'v', text: value }));
}
