import { UPGRADES, keyX, keyY, type BaseInfo, type Game, type LogEntry, type UpgradeGroup } from '@mine/core';
import { clock, fmt } from '../format';
import { getLang, t, upgradeDesc, upgradeName, type StringKey } from '../i18n';
import type { Settings } from '../storage';
import { clear, el } from './dom';
import type { PanelName } from './hud';

export interface PanelHandlers {
  buy(id: string): void;
  gotoCell(x: number, y: number): void;
  upgradeMainBase(): void;
  repairBase(x: number, y: number): void;
  liquidate(): void;
  newGame(): void;
  saveNow(): void;
  settingsChanged(s: Settings): void;
  close(): void;
}

/**
 * Right-hand side panel: the selected base (the main base doubles as the
 * upgrade screen), log, stats and settings. Re-rendered from game state on demand.
 */
export class Panels {
  current: PanelName | null = null;
  /** Base shown by the 'base' panel; null shows the main base (or a hint before it exists). */
  base: number | null = null;
  private body: HTMLElement;
  private title: HTMLElement;
  /** Header slot left of the close button (the main base's level-up). */
  private headExtra: HTMLElement;

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
    this.current = name;
    this.root.hidden = name === null;
    if (name) this.render(game, settings);
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
      case 'log':
        this.renderLog(game);
        break;
      case 'stats':
        this.renderStats(game);
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

  /** Main base: level and level-up in the header; network summary and upgrades below. */
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
    const rate = game.econ.incomeRate;
    this.body.append(
      el('div', { class: 'help', text: t('base.mainHint', { g: bases.cfg.levelProdGrowth.toFixed(2) }) }),
      kv(t('base.network'), `${t('base.perSec', { v: fmt(rate) })} · ${t('base.perHour', { v: fmt(rate * 3600) })}`),
      kv(t('base.active'), String(active)),
    );
    if (bases.isolated.size) this.body.append(kv(t('base.isolatedCount'), String(bases.isolated.size)));
    if (bases.disabled.size) this.body.append(kv(t('base.disabledCount'), String(bases.disabled.size)));
    if (!bases.maxed()) this.body.append(kv(t('base.nextLevel'), t('base.upgrade.next', { n: b.level + 1, prod: bases.levelMult(b.level + 1).toFixed(2) })));

    this.body.append(el('div', { class: 'section', text: t('base.upgrades') }));
    const groups: UpgradeGroup[] = ['network', 'misc'];
    for (const g of groups) for (const u of UPGRADES.filter((x) => x.group === g)) this.body.append(this.upgradeRow(game, u.id));
  }

  private upgradeRow(game: Game, id: string): HTMLElement {
    const level = game.upgrades.level(id);
    const cost = game.upgrades.cost(id);
    const blocked = game.upgrades.blocked(id);
    const afford = game.econ.canAfford(cost);
    const now =
      id === 'transport_speed'
        ? t('up.transport_speed.now', { v: fmt(game.bases.speed()) })
        : id === 'streak_cap'
          ? t('up.streak_cap.now', { v: (game.econ.cfg.streakMultCap + game.econ.streakCapBonus).toFixed(1) })
          : null;
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
    this.body.append(
      kv(t('base.rate'), `${t('base.perSec', { v: fmt(b.rate) })} · ${t('base.perHour', { v: fmt(b.rate * 3600) })}`),
      kv(t('base.produced'), fmt(b.produced)),
      kv(t('base.level'), t('level', { n: b.level })),
    );
    if (b.complexSize > 1) this.body.append(kv(t('base.complex'), t('base.complexValue', { n: b.complexSize, v: fmt(b.complexRate) })));
    if (b.complexBonus > 1) this.body.append(kv(t('base.grand'), `×${b.complexBonus.toFixed(2)}`));
    if (!b.isolated) {
      const eta = clock(Math.ceil(b.route / bases.speed()));
      this.body.append(kv(t('base.route'), b.route ? t('base.routeValue', { n: b.route, hops: b.hops, t: eta }) : t('base.inMain')));
    }
    if (b.children) this.body.append(kv(t('base.children'), String(b.children)));
    this.body.append(el('div', { class: 'help', text: t('base.normalHint') }));
    if (gotoMain) this.body.append(gotoMain);
    if (b.parent !== null) {
      const k = b.parent;
      const label = k === main ? `${t('base.main')} (${keyX(k)}, ${keyY(k)})` : `(${keyX(k)}, ${keyY(k)})`;
      this.body.append(el('div', {}, el('div', { class: 'section', text: t('base.parent') }), el('span', { class: 'chip', text: label, onclick: () => this.h.gotoCell(keyX(k), keyY(k)) })));
    }
  }

  private renderLog(game: Game): void {
    const entries = game.log.slice().reverse();
    if (!entries.length) {
      this.body.append(el('div', { class: 'help', text: t('log.empty') }));
      return;
    }
    for (const e of entries.slice(0, 120)) this.body.append(this.logRow(e));
  }

  private logRow(e: LogEntry): HTMLElement {
    const d = e.data as Record<string, number | string | number[]>;
    let text: string;
    switch (e.kind) {
      case 'hit':
        text = (d.disabled as number) > 0 ? t('log.hitBlast', { x: e.x!, y: e.y!, loss: fmt(d.loss as number), n: d.disabled as number }) : t('log.hit', { x: e.x!, y: e.y!, loss: fmt(d.loss as number) });
        break;
      case 'repair':
        text = t('log.repair', { x: e.x!, y: e.y!, cost: fmt(d.cost as number) });
        break;
      case 'settlement':
        text = t('log.settlement', { x: e.x!, y: e.y!, correct: d.correct as number, wrong: d.wrong as number, payout: fmt(d.payout as number) });
        break;
      case 'drone_explode':
        text = t('log.drone_explode', { drone: d.drone as number, x: e.x!, y: e.y!, n: (d.basis as number[]).length });
        break;
      case 'audit':
        text = t('log.audit', { wrong: d.wrong as number, total: d.total as number });
        break;
      case 'scanner':
        text = t('log.scanner', { x: e.x!, y: e.y!, r: d.r as number, n: d.n as number });
        break;
      case 'probe':
        text = t('log.probe', { x: e.x!, y: e.y!, result: d.mine ? t('log.probe.mine') : t('log.probe.safe') });
        break;
      case 'prestige':
        text = t('log.prestige', { gain: d.gain as number });
        break;
      case 'cashout':
        text = t('log.cashout', { amount: fmt(d.amount as number) });
        break;
      case 'purchase':
        text = t('log.purchase', { name: upgradeName(String(d.id)) });
        break;
      default:
        text = String(d.text ?? e.kind);
    }
    const hasPos = e.x !== undefined && e.y !== undefined;
    const textEl = el('span', { class: 'text' + (hasPos ? ' link' : ''), text, onclick: () => hasPos && this.h.gotoCell(e.x!, e.y!) });
    const row = el('div', { class: `log-entry ${e.kind}` }, el('span', { class: 'time', text: clock(e.t) }), textEl);
    if (e.kind === 'drone_explode' && (d.basis as number[]).length) {
      const chips = el('div', {});
      for (const k of (d.basis as number[]).slice(0, 12)) {
        chips.append(el('span', { class: 'chip', text: `(${keyX(k)}, ${keyY(k)})`, onclick: () => this.h.gotoCell(keyX(k), keyY(k)) }));
      }
      textEl.append(el('div', { class: 'desc', text: t('log.basis') }), chips);
    }
    return row;
  }

  private renderStats(game: Game): void {
    const e = game.econ;
    const L = e.lifetime;
    const kv = (label: string, value: string) => el('div', { class: 'kv' }, el('span', {}, label), el('span', { class: 'v', text: value }));
    this.body.append(
      el('div', { class: 'section', text: t('stats.session') }),
      kv(t('stats.owned'), String(e.owned.size)),
      kv(t('stats.incomeRate'), fmt(e.incomeRate)),
      kv(t('stats.flags'), String(game.board.flagCount)),
      kv(t('stats.cellsRevealed'), String(game.board.revealedCount)),
      kv(t('stats.interventions'), String(game.stats.interventions)),
      kv(t('stats.time'), clock(game.time)),
      el('div', { class: 'section', text: t('stats.lifetime') }),
      kv(t('stats.earned'), fmt(L.earned)),
      kv(t('stats.minesOwned'), String(L.minesOwned)),
      kv(t('stats.settlements'), String(L.settlements)),
      kv(t('stats.cellsRevealed'), String(L.cellsRevealed)),
      kv(t('stats.hits'), String(L.hits)),
      kv(t('stats.wrongFlags'), String(L.wrongFlags)),
      kv(t('stats.bestStreak'), String(L.bestStreak)),
      kv(t('stats.bestUnbanked'), fmt(L.bestUnbanked)),
    );
    const p = game.prestigePreview();
    const box = el(
      'div',
      { class: 'prestige' },
      el('h3', { text: t('prestige.title') }),
      el('p', { text: t('prestige.desc') }),
      kv(t('prestige.cores'), String(e.cores)),
      kv(t('prestige.gain'), `+${p.gain}`),
    );
    if (!p.allowed) box.append(el('p', { text: t('prestige.need', { n: game.cfg.econ.prestigeMinOwned, have: p.owned }) }));
    box.append(el('button', { class: 'btn danger', disabled: !p.allowed || p.gain <= 0, text: t('prestige.button'), onclick: () => this.h.liquidate() }));
    this.body.append(box);
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
