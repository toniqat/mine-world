import { MULTI, SIGNATURE_COLORS, type Game, type MirrorGame, type PlayerInfo } from '@mine/core';
import { fmt } from '../format';
import { t, type StringKey } from '../i18n';
import { hex } from '../theme';
import { clear, el, svgIcon } from './dom';

export type PanelName = 'base' | 'settings';

export interface HudHandlers {
  cashOut(): void;
  toggleSettings(): void;
  toggleMainBase(): void;
  toggleFlagMode(): void;
  /** Online: a scoreboard row was clicked; the camera goes to that player's main base. */
  gotoPlayer(color: number): void;
  /** Online, session complete: show the final standings again. */
  showStandings(): void;
  /** Online, session complete: join another session. */
  nextSession(): void;
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
 * Floating capsules instead of a bar: the unbanked pool with its cap and Cash
 * Out, the combo next to it (top centre), and at the top right the credits next
 * to the buttons (flag mode in toggle input, main base, settings). Credits and
 * the pool count towards their real values; what the pool gains or loses in
 * one go floats out of it as one sum, and a broken combo floats out of the
 * combo.
 *
 * Online (Earth multiplayer) there is no pool, combo, credits or main-base
 * panel: the top right shows my score next to the buttons (flag mode,
 * settings) and the session's scoreboard under them. At the top left, from
 * `MULTI.progressFrom` of the land opened, the session's progress with a mark
 * where it ends (`MULTI.endUnlock`); once it is complete, a capsule that
 * brings the standings back or joins the next session.
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
  private baseBtn!: HTMLButtonElement;
  private comboStat!: HTMLElement;
  private lastStreak = 0;
  /** A Cash Out resets the combo too; that is no break. */
  private cashing = false;
  private game: Game | null = null;
  private lastUnbanked = 0;
  /** Pool drop that a Cash Out explains (not floated as a loss). */
  private banking = 0;
  private pending = 0;
  private pendingSince = 0;
  private last = performance.now();
  /** Built for an online game (score + scoreboard) rather than the pool and credits. */
  private onlineMode = false;
  private score = new Counter();
  private lastScore = 0;
  private scoreEl!: HTMLElement;
  private scorePill!: HTMLElement;
  private boardEl!: HTMLElement;
  /** Scoreboard as last drawn (the mirror replaces the array on every change). */
  private shownPlayers: PlayerInfo[] | null = null;
  private progressPill!: HTMLElement;
  private progressEl!: HTMLElement;
  private progressFill!: HTMLElement;
  private donePill!: HTMLElement;
  /** Progress as last drawn: tenths of a percent, or -1 hidden, -2 complete. */
  private shownProgress: number | null = null;

  constructor(
    private hud: HTMLElement,
    private h: HudHandlers,
  ) {
    this.build();
  }

  build(): void {
    clear(this.hud);
    if (this.onlineMode) return this.buildOnline();
    this.creditsEl = el('div', { class: 'value' }, '0');
    this.creditsPill = el('div', { class: 'pill credits' }, el('div', { class: 'label', text: t('hud.credits') }), this.creditsEl);

    this.poolEl = el('span', { class: 'value' }, '0');
    this.capEl = el('span', { class: 'cap' }, '');
    this.fillEl = el('div', { class: 'fill' });
    this.comboEl = el('div', { class: 'value small' }, '0');
    this.multEl = el('div', { class: 'sub' }, '×1.00');
    this.cashout = el('button', { class: 'btn primary cashout', onclick: () => this.h.cashOut() }, t('hud.cashout'));
    this.comboStat = el('div', { class: 'pill combo' }, el('div', { class: 'stat' }, el('div', { class: 'label', text: t('hud.streak') }), el('div', { class: 'amount' }, this.comboEl, this.multEl)));
    this.poolPill = el(
      'div',
      { class: 'pill pool' },
      el('div', { class: 'stat' }, el('div', { class: 'label', text: t('hud.unbanked') }), el('div', { class: 'amount' }, this.poolEl, this.capEl), el('div', { class: 'bar' }, this.fillEl)),
      this.cashout,
    );

    const iconBtn = (icon: Parameters<typeof svgIcon>[0], title: string, onclick: () => void) => el('button', { class: 'btn icon', title, html: svgIcon(icon), onclick });
    this.flagBtn = iconBtn('flag', `${t('hud.flagMode')} (F)`, () => this.h.toggleFlagMode());
    this.settingsBtn = iconBtn('settings', t('hud.settings'), () => this.h.toggleSettings());
    this.baseBtn = iconBtn('base', `${t('hud.mainBase')} (U)`, () => this.h.toggleMainBase());
    this.hud.append(
      el('div', { class: 'hud-center' }, this.poolPill, this.comboStat),
      el('div', { class: 'hud-right' }, this.creditsPill, el('div', { class: 'pill menu' }, this.flagBtn, this.baseBtn, this.settingsBtn)),
    );
    if (this.game) this.paint();
  }

  /** Online: my score and the buttons in one row at the top right, the scoreboard under them. */
  private buildOnline(): void {
    const iconBtn = (icon: Parameters<typeof svgIcon>[0], title: string, onclick: () => void) => el('button', { class: 'btn icon', title, html: svgIcon(icon), onclick });
    this.scoreEl = el('div', { class: 'value' }, '0');
    this.scorePill = el('div', { class: 'pill credits score' }, el('div', { class: 'label', text: t('hud.score') }), this.scoreEl);
    this.flagBtn = iconBtn('flag', `${t('hud.flagMode')} (F)`, () => this.h.toggleFlagMode());
    this.settingsBtn = iconBtn('settings', t('hud.settings'), () => this.h.toggleSettings());
    this.baseBtn = iconBtn('base', t('hud.mainBase'), () => this.h.toggleMainBase());
    this.boardEl = el('div', { class: 'scoreboard' });
    this.shownPlayers = null;
    this.progressEl = el('span', { class: 'value small' }, '');
    this.progressFill = el('div', { class: 'fill' });
    const end = el('div', { class: 'end' });
    end.style.left = `${MULTI.endUnlock * 100}%`;
    this.progressPill = el(
      'div',
      { class: 'pill progress' },
      el(
        'div',
        { class: 'stat' },
        el('div', { class: 'amount' }, el('span', { class: 'label', text: t('progress.label') }), this.progressEl),
        el('div', { class: 'bar' }, this.progressFill, end),
        el('div', { class: 'warn', text: t('progress.warn', { p: Math.round(MULTI.endUnlock * 100) }) }),
      ),
    );
    this.donePill = el(
      'div',
      { class: 'pill done' },
      el('div', { class: 'label', text: t('done.label') }),
      el('button', { class: 'btn small', text: t('done.standings'), onclick: () => this.h.showStandings() }),
      el('button', { class: 'btn small primary', text: t('done.next'), onclick: () => this.h.nextSession() }),
    );
    this.shownProgress = null;
    this.hud.append(el('div', { class: 'hud-left' }, this.progressPill, this.donePill));
    this.hud.append(el('div', { class: 'hud-right online' }, el('div', { class: 'hud-row' }, this.scorePill, el('div', { class: 'pill menu' }, this.flagBtn, this.settingsBtn)), this.boardEl));
    if (this.game) this.paint();
  }

  /** Show `game` from scratch (no counting up from the previous world). */
  bind(game: Game): void {
    this.game = game;
    if (game.online !== this.onlineMode) {
      this.onlineMode = game.online;
      this.build();
    }
    this.lastScore = (game as MirrorGame).mine?.()?.score ?? 0;
    this.score.snap(this.lastScore);
    this.credits.snap(game.econ.credits);
    this.pool.snap(game.econ.unbanked);
    this.lastUnbanked = game.econ.unbanked;
    this.lastStreak = game.econ.streak;
    this.cashing = false;
    this.banking = 0;
    this.pending = 0;
    this.paint();
  }

  /** A Cash Out moved `amount` from the pool into credits: both counters run, the pool's drop is no loss. */
  cashedOut(amount: number): void {
    this.banking += amount;
    this.cashing = true;
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
    if (this.onlineMode) return this.updateOnline(game as MirrorGame, now, dt);
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

    // A combo broken by a mine or a wrong flag (not by a Cash Out) floats out of the combo.
    if (e.streak < this.lastStreak && !this.cashing) this.float(this.comboStat, `−${this.lastStreak - e.streak}`, true);
    this.lastStreak = e.streak;
    this.cashing = false;

    this.credits.target = e.credits;
    this.pool.target = e.unbanked;
    this.credits.step(dt);
    this.pool.step(dt);
    this.paint();
  }

  /** Online: my score counts up and its gains float out of it, like the pool's. */
  private updateOnline(g: MirrorGame, now: number, dt: number): void {
    const sc = g.mine()?.score ?? this.lastScore;
    const d = sc - this.lastScore;
    this.lastScore = sc;
    if (d !== 0) {
      if (this.pending !== 0 && Math.sign(d) !== Math.sign(this.pending)) this.flushFloat();
      if (this.pending === 0) this.pendingSince = now;
      this.pending += d;
    }
    if (this.pending !== 0 && now - this.pendingSince >= FLOAT_MS) this.flushFloat();
    this.score.target = sc;
    this.score.step(dt);
    this.paint();
  }

  /**
   * The session's players by score: colour, name (mine marked), score; offline
   * players dimmed. A player with a main base can be clicked to go there.
   */
  private paintBoard(g: MirrorGame): void {
    if (this.shownPlayers === g.players) return;
    this.shownPlayers = g.players;
    clear(this.boardEl);
    this.boardEl.append(el('div', { class: 'sb-head', text: t('board.title', { n: g.players.length, max: MULTI.maxPlayers }) }));
    for (const p of g.players) {
      const me = p.color === g.me;
      const dot = el('span', { class: 'sb-dot' });
      dot.style.background = hex(SIGNATURE_COLORS[p.color]);
      const name = el('span', { class: 'sb-name' }, t(`color.${p.color}` as StringKey), me ? el('span', { class: 'sb-you', text: t('board.you') }) : null, p.online ? null : el('span', { class: 'sb-off', text: t('board.offline') }));
      const jump = p.main !== null;
      const row = el('div', { class: `sb-row${me ? ' me' : ''}${p.online ? '' : ' off'}${jump ? ' jump' : ''}` }, dot, name, el('span', { class: 'sb-score', text: fmt(p.score) }));
      if (jump) row.addEventListener('click', () => this.h.gotoPlayer(p.color));
      this.boardEl.append(row);
    }
  }

  /** The session's progress from `MULTI.progressFrom` on, or the complete capsule. */
  private paintProgress(g: MirrorGame): void {
    const v = g.final ? -2 : g.unlock >= MULTI.progressFrom ? Math.floor(g.unlock * 1000) : -1;
    if (v === this.shownProgress) return;
    this.shownProgress = v;
    this.progressPill.style.display = v >= 0 ? '' : 'none';
    this.donePill.style.display = v === -2 ? '' : 'none';
    if (v < 0) return;
    this.progressEl.textContent = `${(v / 10).toFixed(1)}%`;
    this.progressFill.style.width = `${Math.min(100, v / 10)}%`;
  }

  private paint(): void {
    const g = this.game;
    if (!g) return;
    if (this.onlineMode) {
      this.scoreEl.textContent = this.score.text();
      this.paintBoard(g as MirrorGame);
      this.paintProgress(g as MirrorGame);
      return;
    }
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
    this.float(this.onlineMode ? this.scorePill : this.poolPill, `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}`, v < 0);
  }

  private float(parent: HTMLElement, text: string, loss: boolean): void {
    const node = el('span', { class: 'gain' + (loss ? ' loss' : ''), text });
    parent.append(node);
    setTimeout(() => node.remove(), 1000);
  }

  /** The open popover's button shows a blue circle. */
  setActive(name: PanelName | null): void {
    this.settingsBtn.classList.toggle('active', name === 'settings');
    this.baseBtn.classList.toggle('active', name === 'base');
  }

  setFlagMode(on: boolean, visible: boolean): void {
    this.flagBtn.classList.toggle('active', on);
    this.flagBtn.style.display = visible ? '' : 'none';
  }
}
