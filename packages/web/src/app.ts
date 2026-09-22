import { Application } from 'pixi.js';
import { CellState, Game, cellKey, isRevealed, keyX, keyY, type SaveData } from '@mine/core';
import { DemoPlayer } from './demo';
import { fmt } from './format';
import { resolveLang, setLang, t, upgradeName } from './i18n';
import { InputController } from './input';
import { BoardView } from './render/boardView';
import { Camera } from './render/camera';
import { CELL } from './render/textures';
import { loadSettings, saveSettings, writeSave, type Settings } from './storage';
import { PALETTES, applyTheme, onSystemThemeChange, resolveTheme } from './theme';
import { RepairBubble } from './ui/bubble';
import { Hud, type PanelName } from './ui/hud';
import { Panels } from './ui/panels';
import { StartHint, TITLE_LEAVE_MS, TitleScreen } from './ui/title';
import { Toasts, confirmDialog } from './ui/toast';

/** The demo board behind the title fades out over this long once Start is pressed. */
const DEMO_FADE_MS = 500;
/** Zoom of the title-screen demo (a wider view than play, so the camera barely moves). */
const DEMO_ZOOM = 0.75;
/** A finished demo world fades to black over this long (seconds), stays black, then the next one fades in. */
const DEMO_SWAP_FADE = 0.9;
const DEMO_SWAP_HOLD = 0.5;

/** Wires core Game <-> Pixi renderer <-> DOM chrome. */
export class App {
  game: Game;
  settings: Settings;
  private app!: Application;
  private cam = new Camera();
  private view!: BoardView;
  private input!: InputController;
  private hud!: Hud;
  private panels!: Panels;
  private bubble!: RepairBubble;
  /** The board click of this gesture only dismissed a modal (the repair bubble): it does nothing else. */
  private swallowPrimary = false;
  /** The next DOM click only dismissed a modal: it is stopped before it reaches a button. */
  private swallowClick = false;
  /** Popover a pointerdown outside it closed in this gesture (clicking the main base then does not reopen it). */
  private dismissed: PanelName | null = null;
  private toasts!: Toasts;
  private flagMode = false;
  /** Drone being dragged to another Owned mine (drones exist only with equipment). */
  private drag: { id: number } | null = null;
  private dirty = false;
  /** Cell the current opening started from; fog it lifts spreads from there. */
  private fogFrom: number | null = null;
  private lastSave = 0;
  private saving = false;
  private panelTimer = 0;
  private unsub: Array<() => void> = [];
  /** Title-screen demo; null once the player pressed Start. */
  private demo: DemoPlayer | null = null;
  private title: TitleScreen | null = null;
  /** When Start was pressed: the demo board fades out from then. */
  private leavingAt = 0;
  /** A finished demo world fading to black, holding, or the next one fading in. */
  private demoSwap: { phase: 'out' | 'black' | 'in'; t: number } | null = null;
  private hint: StartHint | null = null;
  private readonly hasSave: boolean;
  private readonly appEl = document.getElementById('app')!;

  constructor(saved: SaveData | null) {
    this.settings = loadSettings();
    setLang(resolveLang(this.settings.lang));
    applyTheme(resolveTheme(this.settings.theme));
    this.hasSave = saved !== null;
    this.game = saved ? Game.fromSave(saved) : this.newGame();
  }

  private newGame(seed = (Date.now() % 1_000_000) + 1): Game {
    return new Game({ seed, resolve: { interventionMode: this.settings.interventionMode } } as never);
  }

  async start(): Promise<void> {
    const stage = document.getElementById('stage')!;
    const palette = PALETTES[resolveTheme(this.settings.theme)];
    this.app = new Application();
    await this.app.init({ resizeTo: stage, background: palette.bg, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
    stage.append(this.app.canvas);

    // The title screen plays a throwaway demo world until Start is pressed.
    this.demo = new DemoPlayer();
    this.view = new BoardView(this.app, this.demo.game, palette);
    this.app.stage.addChild(this.view.root);
    this.toasts = new Toasts(document.getElementById('toasts')!);
    this.hud = new Hud(document.getElementById('hud')!, {
      cashOut: () => this.cashOut(),
      toggleSettings: () => this.togglePanel('settings'),
      toggleMainBase: () => this.toggleMain(),
      toggleFlagMode: () => this.setFlagMode(!this.flagMode),
    });
    this.panels = new Panels(document.getElementById('panel')!, {
      buy: (id) => this.buy(id),
      upgradeMainBase: () => this.upgradeMainBase(),
      newGame: () => this.restart(),
      saveNow: () => this.save(true),
      settingsChanged: (s) => this.applySettings(s),
    });
    this.bubble = new RepairBubble(this.appEl, (x, y) => this.repairBase(x, y));
    document.addEventListener('pointerdown', (e) => this.onDocPointerDown(e), true);
    document.addEventListener(
      'click',
      (e) => {
        if (!this.swallowClick) return;
        this.swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    this.input = new InputController(this.app.canvas, this.cam, {
      primary: (c) => this.onPrimary(c),
      secondary: (c) => this.onSecondary(c),
      hover: (c) => this.onHover(c),
      key: (code, ev) => this.onKey(code, ev),
      grab: (c) => this.onGrab(c),
      grabMove: (w, c) => this.onGrabMove(w, c),
      grabEnd: (c) => this.onGrabEnd(c),
    });
    this.applySettings(this.settings, false);
    this.bindGame(this.demo.game, true);
    this.cam.resize(this.app.screen.width, this.app.screen.height);
    this.cam.zoom = DEMO_ZOOM;
    this.cam.centerOnCell(0, 0);
    this.input.enabled = false;
    this.appEl.classList.add('titling');
    this.title = new TitleScreen(this.appEl, this.hasSave, {
      start: () => void this.leaveTitle(false),
      newGame: () => void this.leaveTitle(true),
    });

    onSystemThemeChange(() => this.applySettings(this.settings, false));
    window.addEventListener('beforeunload', () => void this.save(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.save(true);
    });

    let acc = 0;
    this.app.ticker.add((tk) => {
      const dt = Math.min(0.25, tk.deltaMS / 1000);
      this.cam.resize(this.app.screen.width, this.app.screen.height);
      this.input.tick(dt);
      acc += dt;
      if (this.demo) {
        this.tickDemo(this.demo, dt, acc >= 0.1 ? acc : 0);
        if (acc >= 0.1) acc = 0;
      } else if (acc >= 0.1) {
        this.game.tick(acc);
        acc = 0;
      }
      this.view.setDroneTiming(acc, this.game.droneActionsPerSec(), this.game.droneMoveSpeed());
      this.view.update(this.cam);
      this.hud.update(this.game);
      this.bubble.update(this.game, this.cam);
      if (this.dirty && performance.now() - this.lastSave > 15000) void this.save(false);
      this.panelTimer += dt;
      if (this.panels.current === 'base' && this.panelTimer > 1) {
        this.panelTimer = 0;
        this.refreshPanel();
      }
    });
  }

  // ------------------------------------------------------------ title screen

  /**
   * The demo plays itself; the camera drifts slowly after the patch it digs.
   * When the bot is stuck the board fades out to black, the next world is
   * made while the screen is black, and it fades in.
   */
  private tickDemo(demo: DemoPlayer, dt: number, gameDt: number): void {
    if (this.leavingAt) {
      this.view.root.alpha = Math.min(this.view.root.alpha, Math.max(0, 1 - (performance.now() - this.leavingAt) / DEMO_FADE_MS));
      return;
    }
    const swap = this.demoSwap;
    if (swap) {
      swap.t += dt;
      let dark = 1;
      if (swap.phase === 'out') {
        dark = Math.min(1, swap.t / DEMO_SWAP_FADE);
        if (swap.t >= DEMO_SWAP_FADE) {
          demo.next();
          this.view.setGame(demo.game);
          this.bindGame(demo.game, true);
          this.cam.zoom = DEMO_ZOOM;
          this.cam.centerOnCell(0, 0);
          this.demoSwap = { phase: 'black', t: 0 };
        }
      } else if (swap.phase === 'black') {
        if (swap.t >= DEMO_SWAP_HOLD) this.demoSwap = { phase: 'in', t: 0 };
      } else {
        dark = Math.max(0, 1 - swap.t / DEMO_SWAP_FADE);
        if (swap.t >= DEMO_SWAP_FADE) this.demoSwap = null;
      }
      this.view.root.alpha = 1 - dark;
      this.title?.setBlack(dark);
    }
    if (!swap || swap.phase === 'in') demo.tick(dt);
    if (!this.demoSwap && demo.over) this.demoSwap = { phase: 'out', t: 0 };
    if (gameDt) demo.game.tick(gameDt);
    const k = 1 - Math.exp(-dt * 0.8);
    this.cam.x += ((demo.view.x + 0.5) * CELL - this.cam.x) * k;
    this.cam.y += ((demo.view.y + 0.5) * CELL - this.cam.y) * k;
  }

  /**
   * Start pressed: the title slides away and the demo fades out, then the
   * player's world appears tile by tile in a diagonal wave. `fresh` (the
   * New game button next to Continue) replaces the saved world, keeping cores.
   */
  private async leaveTitle(fresh: boolean): Promise<void> {
    if (!this.title || this.leavingAt) return;
    if (fresh) {
      const ok = await confirmDialog(document.getElementById('modal')!, t('settings.newGame.confirm'), t('confirm.yes'), t('confirm.no'));
      if (!ok || !this.title) return;
      const g = this.newGame();
      g.econ.cores = this.game.econ.cores;
      g.econ.lifetime = this.game.econ.lifetime;
      this.game = g;
      this.dirty = true;
    }
    this.title.leave();
    this.title = null;
    this.demoSwap = null;
    this.leavingAt = performance.now();
    this.appEl.classList.remove('titling');
    this.appEl.classList.add('intro');
    await wait(TITLE_LEAVE_MS);
    this.demo = null;
    this.leavingAt = 0;
    this.view.setGame(this.game);
    this.view.root.alpha = 1;
    this.bindGame(this.game);
    this.cam.zoom = 1;
    this.centerOnStart();
    await wait(this.view.intro());
    this.appEl.classList.remove('intro');
    this.input.enabled = true;
    this.syncHint();
    if (fresh) void this.save(true);
  }

  /** A world nobody has opened yet asks for the first click (it founds the main base). */
  private syncHint(): void {
    const want = !this.demo && !this.game.world.started;
    if (want && !this.hint) this.hint = new StartHint(this.appEl);
    else if (!want && this.hint) {
      this.hint.hide();
      this.hint = null;
    }
  }

  // ---------------------------------------------------------------- game glue

  /** `demo`: the title-screen world, which only drives the board (no toasts, saves or panels). */
  private bindGame(g: Game = this.game, demo = false): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    const on = g.events.on.bind(g.events);
    this.unsub.push(
      on('cells', (list) => {
        this.view.applyChanges(list);
        if (demo) return;
        this.dirty = true;
        if (this.hint) this.syncHint();
      }),
      on('settlement', (ev) => {
        const pal = PALETTES[resolveTheme(this.settings.theme)];
        this.view.pulse(ev.cells, ev.x, ev.y, ev.wrong === 0 ? pal.success : pal.error);
        // Each new base shows the points it earned rising from its tile.
        if (ev.wrong === 0 && ev.correct > 0) {
          const each = `+${fmt(ev.payout / ev.correct)}`;
          for (const k of ev.cells) this.view.floatText(keyX(k), keyY(k), each, pal.accent);
        }
      }),
      on('hit', (h) => {
        if (demo) {
          const pal = PALETTES[resolveTheme(this.settings.theme)];
          return this.view.explosion(h.x, h.y, h.blast.r, h.blast.chain, pal.error, pal.warning);
        }
        // No toast: the pool and the combo in the HUD show what the hit cost.
        if (h.actor.kind === 'drone') this.toasts.show(t('toast.droneHit', { id: h.actor.id }), 'bad', 5000);
        const pal = PALETTES[resolveTheme(this.settings.theme)];
        this.view.explosion(h.x, h.y, h.blast.r, h.blast.chain, pal.error, pal.warning);
        if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      }),
      on('grand', (f) => {
        const mult = `×${f.bonus.toFixed(2)}`;
        this.view.grand(f.members, f.cx, f.cy, t('fx.grand', { m: mult }), PALETTES[resolveTheme(this.settings.theme)].accent);
        if (!demo) this.toasts.show(t('toast.grand', { n: f.members.length, m: mult }), 'good', 4000);
      }),
      on('fog', (keys) => {
        this.view.liftFog(keys, this.fogFrom ?? this.view.rippleFrom ?? undefined);
        this.dirty = true;
      }),
      on('tech', (tier) => {
        this.view.refreshAll();
        this.toasts.show(t('toast.tech', { t: tier }), 'good');
      }),
      on('scanners', (list) => this.view.setScanners(list)),
      on('drones', () => this.syncDrones(g)),
      on('bases', () => {
        this.view.markBasesDirty();
        if (!demo && this.panels.current === 'base') this.refreshPanel();
      }),
    );
    if (!demo) this.unsub.push(on('econ', () => (this.dirty = true)));
    this.view.setScanners(g.scanners);
    this.syncDrones(g);
  }

  private syncDrones(g: Game = this.game): void {
    this.view.setDrones(g.drones.drones, g.droneRadius());
  }

  private replaceGame(g: Game): void {
    this.game = g;
    this.view.setGame(g);
    this.bindGame();
    this.centerOnStart();
    this.dirty = true;
    this.bubble.hide();
    this.refreshPanel();
    this.syncHint();
  }

  // ------------------------------------------------------------------ input

  /**
   * A press anywhere outside the open popover closes it (modeless: the click
   * still does what it would, except on the popover's own HUD button, which
   * toggles it). A press outside the repair bubble closes it and does nothing
   * else (modal).
   */
  private onDocPointerDown(e: PointerEvent): void {
    this.swallowPrimary = false;
    this.swallowClick = false;
    this.dismissed = null;
    const target = e.target instanceof Element ? e.target : null;
    const inside = (id: string) => target !== null && target.closest(`#${id}`) !== null;
    if (inside('modal') || inside('toasts')) return;
    if (this.bubble.key !== null && !this.bubble.contains(target)) {
      this.bubble.hide();
      this.view.setSelectedBase(null);
      if (this.app.canvas.contains(target)) this.swallowPrimary = true;
      else this.swallowClick = true;
      return;
    }
    if (this.panels.current && !inside('panel') && !inside('hud')) {
      this.dismissed = this.panels.current;
      this.togglePanel(null);
    }
  }

  private onPrimary(c: { x: number; y: number }): void {
    if (this.swallowPrimary) return void (this.swallowPrimary = false);
    if (this.game.baseInfo(c.x, c.y)) return this.selectBase(cellKey(c.x, c.y));
    this.view.setSelectedBase(null);
    const s = this.game.cellState(c.x, c.y);
    if (isRevealed(s)) return this.chordAt(c);
    if (this.lockedToast(c)) return;
    if (this.settings.inputMode === 'toggle' && this.flagMode) {
      this.game.cycleMark(c.x, c.y);
      return;
    }
    // Fog this opening lifts spreads from the clicked cell (the first click: from the new main base).
    this.fogFrom = cellKey(c.x, c.y);
    try {
      if (s === CellState.Unknown && this.game.reveal(c.x, c.y).full) this.poolFull();
    } finally {
      this.fogFrom = null;
    }
  }

  /** Something tried to open a tile while the unbanked pool is full: say Cash Out comes first. */
  private poolFull(): void {
    this.hud.nudgeFull();
    this.toasts.show(t('toast.full'), 'bad');
  }

  /**
   * Chord a number: its neighbours open in one ripple from the number, not one per
   * neighbour; the closed ones it could open (not fogged or locked) that stay closed look pressed.
   */
  private chordAt(c: { x: number; y: number }): void {
    this.view.rippleFrom = cellKey(c.x, c.y);
    try {
      if (this.game.chord(c.x, c.y).full) this.poolFull();
    } finally {
      this.view.rippleFrom = null;
    }
    const keys: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = c.x + dx, y = c.y + dy;
        if (this.game.cellState(x, y) === CellState.Unknown && !this.game.fogged(x, y) && !this.game.locked(x, y)) keys.push(cellKey(x, y));
      }
    }
    if (keys.length) this.view.press(keys);
  }

  /** A closed, visible cell of a tier not learned yet: say which technology it needs. */
  private lockedToast(c: { x: number; y: number }): boolean {
    const s = this.game.cellState(c.x, c.y);
    if ((s !== CellState.Unknown && s !== CellState.Flag) || this.game.fogged(c.x, c.y) || !this.game.locked(c.x, c.y)) return false;
    this.toasts.show(t('toast.locked', { t: this.game.tierAt(c.x, c.y), l: this.game.tierAt(c.x, c.y) - 1 }), 'bad');
    return true;
  }

  private onSecondary(c: { x: number; y: number }): void {
    if (this.swallowPrimary) return void (this.swallowPrimary = false);
    const s = this.game.cellState(c.x, c.y);
    if (this.lockedToast(c)) return;
    if (isRevealed(s)) this.chordAt(c);
    // Unknown -> flag -> "?" -> Unknown.
    else this.game.cycleMark(c.x, c.y);
  }

  /** Pressing on a placed drone picks it up; it pauses until dropped. */
  private onGrab(c: { x: number; y: number }): boolean {
    const d = this.game.drones.drones.find((d) => d.placed && d.x === c.x && d.y === c.y);
    if (!d) return false;
    this.drag = { id: d.id };
    this.game.holdDrone(d.id, true);
    return true;
  }

  private onGrabMove(w: { x: number; y: number }, c: { x: number; y: number }): void {
    if (!this.drag) return;
    this.view.setDrag({ id: this.drag.id, wx: w.x, wy: w.y, valid: this.game.canPlaceDrone(this.drag.id, c.x, c.y) });
  }

  /** Drop on a free Owned mine moves the drone; anywhere else it resumes where it was. */
  private onGrabEnd(c: { x: number; y: number } | null): void {
    if (!this.drag) return;
    const id = this.drag.id;
    this.drag = null;
    this.view.setDrag(null);
    const d = this.game.drones.get(id);
    const moved = c !== null && d !== undefined && (c.x !== d.x || c.y !== d.y) && this.game.placeDrone(id, c.x, c.y);
    if (!moved) this.game.holdDrone(id, false);
    // Releasing on the drone's own tile is a click on the base under it.
    if (c && d && c.x === d.x && c.y === d.y) this.selectBase(cellKey(c.x, c.y));
    if (c && !moved && d && (c.x !== d.x || c.y !== d.y)) this.toasts.show(t('toast.droneNeedsOwned'), 'bad');
    this.refreshPanel();
  }

  private onHover(c: { x: number; y: number } | null): void {
    this.view.setHover(c);
  }

  private onKey(code: string, ev: KeyboardEvent): void {
    switch (code) {
      case 'Escape':
        this.bubble.hide();
        this.view.setSelectedBase(null);
        this.togglePanel(null);
        break;
      case 'KeyF':
        this.setFlagMode(!this.flagMode);
        break;
      case 'KeyH':
        this.goHome();
        break;
      case 'Space':
        ev.preventDefault();
        this.cashOut();
        break;
      case 'Equal':
      case 'NumpadAdd':
        this.cam.zoomAt(this.cam.width / 2, this.cam.height / 2, 1.2);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        this.cam.zoomAt(this.cam.width / 2, this.cam.height / 2, 1 / 1.2);
        break;
      case 'KeyU':
        this.toggleMain();
        break;
    }
  }

  private setFlagMode(on: boolean): void {
    this.flagMode = on;
    this.hud.setFlagMode(on, this.settings.inputMode === 'toggle');
  }

  // ---------------------------------------------------------------- actions

  private cashOut(): void {
    if (this.game.econ.unbanked <= 0) return;
    const amt = this.game.cashOut();
    this.hud.cashedOut(amt);
  }

  private buy(id: string): void {
    const r = this.game.buy(id);
    if (r.ok) this.toasts.show(t('toast.bought', { name: upgradeName(id) }), 'good');
    else if (r.reason === 'money') this.toasts.show(t('toast.noMoney'), 'bad');
    this.refreshPanel();
  }

  /**
   * Clicking a base lights it up (and its route); clicking it again lets go.
   * The main base also opens its popover; a disabled base shows the repair bubble.
   */
  private selectBase(key: number): void {
    if (key === this.game.bases.main) {
      if (this.dismissed === 'base') return this.view.setSelectedBase(null);
      return this.toggleMain();
    }
    if (this.panels.current) this.togglePanel(null);
    if (this.view.selected === key && this.bubble.key === null) return this.view.setSelectedBase(null);
    this.view.setSelectedBase(key);
    if (this.game.bases.disabled.has(key)) {
      this.bubble.show(key, this.game);
      this.bubble.update(this.game, this.cam);
    }
  }

  /** `U`, the HUD button and a click on the main base open (or close) the main-base popover. */
  private toggleMain(): void {
    this.bubble.hide();
    if (this.panels.current === 'base') return this.togglePanel(null);
    this.togglePanel('base');
    this.view.setSelectedBase(this.game.bases.main);
  }

  private repairBase(x: number, y: number): void {
    const r = this.game.repairBase(x, y);
    if (r.ok) {
      this.toasts.show(t('toast.repaired'), 'good');
      this.bubble.hide();
    } else if (r.reason === 'money') this.toasts.show(t('toast.noMoney'), 'bad');
  }

  private upgradeMainBase(): void {
    const r = this.game.upgradeMainBase();
    if (r.ok) this.toasts.show(t('toast.baseUp', { n: this.game.bases.mainLevel }), 'good');
    else if (r.reason === 'money') this.toasts.show(t('toast.noMoney'), 'bad');
    this.refreshPanel();
  }


  private async restart(): Promise<void> {
    const ok = await confirmDialog(document.getElementById('modal')!, t('settings.newGame.confirm'), t('confirm.yes'), t('confirm.no'));
    if (!ok) return;
    const cores = this.game.econ.cores;
    const lifetime = this.game.econ.lifetime;
    const g = this.newGame();
    g.econ.cores = cores;
    g.econ.lifetime = lifetime;
    this.replaceGame(g);
    void this.save(true);
  }

  /** A fresh world is all fog until the first click places the main base (`syncHint` asks for it); the view starts on the start cell. */
  private centerOnStart(): void {
    const s = this.game.startCell();
    this.cam.centerOnCell(s.x, s.y);
  }

  private goHome(): void {
    const s = this.game.startCell();
    this.gotoCell(s.x, s.y);
  }

  private gotoCell(x: number, y: number): void {
    this.cam.centerOnCell(x, y);
    this.view.flash([cellKey(x, y)], PALETTES[resolveTheme(this.settings.theme)].accent, 1500);
    if (window.innerWidth < 720) this.togglePanel(null);
  }

  private togglePanel(name: PanelName | null): void {
    const next = name === null || this.panels.current === name ? null : name;
    // Leaving the main-base popover lets go of the main base.
    if (this.panels.current === 'base' && next !== 'base' && this.view.selected === this.game.bases.main) this.view.setSelectedBase(null);
    this.panels.open(next, this.game, this.settings);
    this.syncHudActive();
  }

  private syncHudActive(): void {
    this.hud.setActive(this.panels.current);
  }

  private refreshPanel(): void {
    if (this.panels.current) this.panels.render(this.game, this.settings);
  }

  private applySettings(s: Settings, rerender = true): void {
    this.settings = s;
    saveSettings(s);
    const theme = resolveTheme(s.theme);
    applyTheme(theme);
    const pal = PALETTES[theme];
    if (this.app) {
      this.app.renderer.background.color = pal.bg;
      this.view.setPalette(pal);
      this.view.setDensityOverlay(s.showDensity);
    }
    setLang(resolveLang(s.lang));
    if (this.input) this.input.longPressMs = s.longPressMs;
    if (this.hud) {
      this.hud.build();
      this.hud.setFlagMode(this.flagMode, s.inputMode === 'toggle');
      this.syncHudActive();
    }
    if (rerender) this.refreshPanel();
  }

  private async save(force: boolean): Promise<void> {
    if (this.saving) return;
    if (!force && !this.dirty) return;
    this.saving = true;
    try {
      await writeSave(this.game.toSave());
      this.dirty = false;
      this.lastSave = performance.now();
    } catch (e) {
      console.warn('save failed', e);
    } finally {
      this.saving = false;
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { keyX, keyY };
