import { Application, UPDATE_PRIORITY } from 'pixi.js';
import { CellState, Game, MirrorGame, SIGNATURE_COLORS, cellKey, forEachNeighbor, isKnownMine, isRevealed, keyX, keyY, makeConfig, numberOf, type SaveData, type ServerMsg, type WelcomeMsg } from '@mine/core';
import { DemoPlayer } from './demo';
import { isTouchDevice, onTouchDeviceChange } from './device';
import { fmt } from './format';
import { resolveLang, setLang, t, upgradeName, type StringKey } from './i18n';
import { InputController } from './input';
import { ConnectError, NetClient, saveToken, savedToken, serverUrl } from './net';
import { BoardView, DIGIT_MIN_ZOOM } from './render/boardView';
import { Camera } from './render/camera';
import { CELL } from './render/textures';
import { loadSettings, saveSettings, writeSave, type Settings } from './storage';
import { PALETTES, applyTheme, hex, onSystemThemeChange, resolveTheme, type Palette } from './theme';
import { LockedBubble, RepairBubble } from './ui/bubble';
import { Hud, type PanelName } from './ui/hud';
import { Panels } from './ui/panels';
import { StartHint, TITLE_LEAVE_MS, TitleScreen, ViewHint } from './ui/title';
import { Toasts, confirmDialog, messageDialog } from './ui/toast';

/** The demo board behind the title fades out over this long once Start is pressed. */
const DEMO_FADE_MS = 500;
/** Zoom of the title-screen demo (a wider view than play, so the camera barely moves). */
const DEMO_ZOOM = 0.75;
/** A finished demo world fades to black over this long (seconds), stays black, then the next one fades in. */
const DEMO_SWAP_FADE = 0.9;
const DEMO_SWAP_HOLD = 0.5;
/**
 * Earth mode: below this zoom tiles are too small to play; the view is look-only
 * (numbers stop being drawn at the same zoom).
 */
const VIEW_ONLY_ZOOM = DIGIT_MIN_ZOOM;
/** After a lost connection the next try waits this long, doubling up to `RECONNECT_MAX_MS`. */
const RECONNECT_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
/** Game over: the blast plays this long before the dialog. */
const GAME_OVER_DELAY_MS = 1300;

/**
 * Wires core Game <-> Pixi renderer <-> DOM chrome. The endless world is a
 * local `Game`; the Earth map is played online, through a `MirrorGame` fed by
 * the server (`net`).
 */
export class App {
  game: Game;
  /** The endless world (saved in the browser); `game` while it is played. */
  private solo: Game;
  settings: Settings;
  private app!: Application;
  private cam = new Camera();
  private view!: BoardView;
  private input!: InputController;
  private hud!: Hud;
  private panels!: Panels;
  private bubble!: RepairBubble;
  private lockedBubble!: LockedBubble;
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
  private viewHint: ViewHint | null = null;
  private readonly hasSave: boolean;
  /** Online: the connection to the server (null while reconnecting). */
  private net: NetClient | null = null;
  /** The title's multi button is waiting for the server. */
  private connecting = false;
  private reconnectTimer = 0;
  private readonly appEl = document.getElementById('app')!;

  constructor(saved: SaveData | null) {
    this.settings = loadSettings();
    setLang(resolveLang(this.settings.lang));
    applyTheme(resolveTheme(this.settings.theme));
    this.hasSave = saved !== null;
    this.solo = saved ? Game.fromSave(saved) : this.newGame();
    this.game = this.solo;
  }

  /** A fresh endless world. */
  private newGame(seed = (Date.now() % 1_000_000) + 1): Game {
    return new Game(makeConfig({ seed }));
  }

  /**
   * The theme's palette. Online the theme's accent gives way to my signature
   * colour (flags, highlights, the chrome's accent), and land nobody owns any
   * more is drawn muted.
   */
  private palette(): Palette {
    const base = PALETTES[resolveTheme(this.settings.theme)];
    const g = this.game;
    if (!(g instanceof MirrorGame)) return base;
    return { ...base, accent: SIGNATURE_COLORS[g.me], cellOwned: base.fgMuted };
  }

  /** Push the palette to the renderer and the chrome (the CSS accent follows my colour online). */
  private applyPalette(): void {
    const pal = this.palette();
    const root = document.documentElement.style;
    if (this.game instanceof MirrorGame) {
      root.setProperty('--accent', hex(pal.accent));
      root.setProperty('--accent-hover', hex(pal.accent));
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-hover');
    }
    if (!this.app) return;
    this.app.renderer.background.color = pal.bg;
    this.view.setPalette(pal);
  }

  async start(): Promise<void> {
    const stage = document.getElementById('stage')!;
    const palette = this.palette();
    this.app = new Application();
    await this.app.init({ resizeTo: stage, background: palette.bg, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
    stage.append(this.app.canvas);

    // The title screen plays a throwaway demo world until Start is pressed.
    this.demo = new DemoPlayer();
    this.view = new BoardView(this.app, this.demo.game, palette);
    this.app.stage.addChild(this.view.root, this.view.screen);
    this.toasts = new Toasts(document.getElementById('toasts')!);
    this.hud = new Hud(document.getElementById('hud')!, {
      cashOut: () => this.cashOut(),
      toggleSettings: () => this.togglePanel('settings'),
      toggleMainBase: () => this.toggleMain(),
      toggleFlagMode: () => this.setFlagMode(!this.flagMode),
      gotoPlayer: (color) => this.gotoPlayer(color),
    });
    this.panels = new Panels(document.getElementById('panel')!, {
      buy: (id) => this.buy(id),
      upgradeMainBase: () => this.upgradeMainBase(),
      newGame: () => this.restart(),
      saveNow: () => this.save(true),
      settingsChanged: (s) => this.applySettings(s),
    });
    this.bubble = new RepairBubble(this.appEl, (x, y) => this.repairBase(x, y));
    this.lockedBubble = new LockedBubble(this.appEl);
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
    // A convertible switching between touch and mouse swaps the rules live.
    onTouchDeviceChange(() => this.applySettings(this.settings));
    this.cam.resize(this.app.screen.width, this.app.screen.height);
    this.openTitle();
    this.viewHint = new ViewHint(this.appEl);

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
      this.constrainCamera();
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
      this.lockedBubble.update(this.game, this.cam);
      this.viewHint?.set(!this.demo && this.input.enabled && !this.hint && this.viewOnly());
      if (this.dirty && performance.now() - this.lastSave > 15000) void this.save(false);
      this.panelTimer += dt;
      if (this.panels.current === 'base' && this.panelTimer > 1) {
        this.panelTimer = 0;
        this.refreshPanel();
      }
    });
    // After the stage is drawn: the other end of the Earth map where the view crosses the seam.
    this.app.ticker.add(() => this.view.renderSeam(this.app.renderer), undefined, UPDATE_PRIORITY.UTILITY);
  }

  /**
   * Earth mode: the camera wraps east-west, keeps the map on screen vertically
   * and may zoom out until the whole map fits; the endless world keeps its
   * default limits.
   */
  private constrainCamera(): void {
    const cam = this.cam;
    const map = this.demo ? null : this.game.world.map;
    cam.wrap = map ? map.w : 0;
    cam.rows = map ? map.h : 0;
    cam.minZoom = map ? Math.min(0.2, cam.width / (map.w * CELL), cam.height / (map.h * CELL)) : 0.2;
    if (cam.zoom < cam.minZoom) cam.zoom = cam.minZoom;
    cam.constrain();
  }

  /** Earth mode zoomed out past `VIEW_ONLY_ZOOM`: tiles cannot be acted on. */
  private viewOnly(): boolean {
    return this.game.wrap > 0 && this.cam.zoom < VIEW_ONLY_ZOOM;
  }

  /** Board coordinates from the input, with the column made canonical (Earth mode wraps). */
  private canon(c: { x: number; y: number }): { x: number; y: number } {
    return { x: this.game.wx(c.x), y: c.y };
  }

  // ------------------------------------------------------------ title screen

  /** The title over the demo: at launch, and again after a game over online. */
  private openTitle(): void {
    if (!this.demo) {
      this.demo = new DemoPlayer();
      this.view.setGame(this.demo.game);
    }
    this.view.root.alpha = 1;
    this.bindGame(this.demo.game, true);
    this.cam.zoom = DEMO_ZOOM;
    this.cam.centerOnCell(0, 0);
    this.input.enabled = false;
    this.appEl.classList.add('titling');
    this.title = new TitleScreen(this.appEl, this.hasSave || this.solo.world.started, savedToken() !== null, {
      single: () => void this.leaveTitle(false),
      singleNew: () => void this.leaveTitle(true),
      multi: () => void this.leaveTitle(false, true),
      multiNew: () => void this.leaveTitle(true, true),
    });
  }

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
   * A mode picked: the title slides away and the demo fades out, then the
   * player's world appears tile by tile in a diagonal wave. `fresh` (the
   * New game button under a Continue) replaces the saved world, keeping cores.
   * `earth` (the multi button) joins an online session instead (or rejoins
   * mine; `fresh` gives up the kept seat at once and joins anew): the title
   * stays until the server has welcomed us.
   */
  private async leaveTitle(fresh: boolean, earth = false): Promise<void> {
    if (!this.title || this.leavingAt || this.connecting) return;
    if (earth) {
      const leave = fresh ? savedToken() : null;
      if (leave) {
        const ok = await confirmDialog(document.getElementById('modal')!, t('title.multiNew.confirm'), t('confirm.yes'), t('confirm.no'));
        if (!ok || !this.title) return;
      }
      this.connecting = true;
      this.title.connecting(true);
      let res: { net: NetClient; welcome: WelcomeMsg };
      try {
        res = await NetClient.connect(serverUrl(), leave ? null : savedToken(), leave);
      } catch (e) {
        this.title?.connecting(false);
        this.toasts.show(this.netError(e), 'bad', 5000);
        return;
      } finally {
        this.connecting = false;
      }
      if (!this.title) return res.net.close();
      this.game = this.goOnline(res.net, res.welcome);
    } else this.game = this.solo;
    if (fresh && !earth) {
      const ok = await confirmDialog(document.getElementById('modal')!, t('settings.newGame.confirm'), t('confirm.yes'), t('confirm.no'));
      if (!ok || !this.title) return;
      const g = this.newGame();
      g.econ.cores = this.game.econ.cores;
      g.econ.lifetime = this.game.econ.lifetime;
      this.game = this.solo = g;
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
    this.applyPalette();
    this.view.root.alpha = 1;
    this.bindGame(this.game);
    this.cam.zoom = 1;
    this.centerOnStart();
    this.constrainCamera();
    const g = this.game;
    if (g instanceof MirrorGame) this.toasts.show(t('net.joined', { c: t(`color.${g.me}` as StringKey) }), 'info', 4000);
    await wait(this.view.intro());
    this.appEl.classList.remove('intro');
    this.input.enabled = true;
    this.syncHint();
    if (fresh && !earth) void this.save(true);
  }

  // ---------------------------------------------------------------- online

  /** A welcome from the server: the mirror of my session, wired to the connection. */
  private goOnline(net: NetClient, w: WelcomeMsg): MirrorGame {
    const g = new MirrorGame(w);
    g.send = (m) => this.net?.send(m);
    this.net = net;
    saveToken(w.token);
    net.onMessage = (m) => this.onServer(g, m);
    net.onClose = () => this.lostConnection(g);
    return g;
  }

  private onServer(g: MirrorGame, m: ServerMsg): void {
    if (g !== this.game) return;
    const pal = this.palette();
    switch (m.t) {
      case 'cells':
        g.applyCells(m.cells);
        break;
      case 'players':
        g.setPlayers(m.players);
        this.syncHint();
        break;
      case 'blast':
        this.view.explosion(m.x, m.y, m.r, [], pal.error, pal.warning);
        if (m.color === g.me && navigator.vibrate) navigator.vibrate([30, 40, 30]);
        break;
      case 'settle': {
        const color = SIGNATURE_COLORS[m.color];
        this.view.pulse(m.cells, m.x, m.y, m.wrong === 0 ? color : pal.error);
        // Each new base shows the points it earned rising from its tile, in its owner's colour.
        if (m.wrong === 0 && m.correct > 0) for (const k of m.cells) this.view.floatText(keyX(k), keyY(k), `+${fmt(m.payout / m.correct)}`, color);
        break;
      }
      case 'gameover':
        void this.gameOver(m.score);
        break;
      case 'error':
        this.toasts.show(this.netError(new ConnectError(m.code)), 'bad');
        break;
    }
  }

  private netError(e: unknown): string {
    const code = e instanceof ConnectError ? e.code : 'unreachable';
    if (code === 'water') return t('err.water');
    if (code === 'tooClose') return t('err.tooClose');
    if (code === 'version') return t('net.version');
    if (code === 'full') return t('net.full');
    return t('net.unreachable');
  }

  /** The connection dropped: keep the board and try again (my token resumes my player). */
  private lostConnection(g: MirrorGame): void {
    if (g !== this.game) return;
    this.net = null;
    this.toasts.show(t('net.lost'), 'bad', 4000);
    this.reconnect(RECONNECT_MS);
  }

  private reconnect(delay: number): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(async () => {
      if (!this.game.online) return;
      try {
        const { net, welcome } = await NetClient.connect(serverUrl(), savedToken());
        if (!this.game.online) return net.close();
        const g = this.goOnline(net, welcome);
        this.game = g;
        this.view.setGame(g);
        this.bindGame();
        this.applyPalette();
        if (!g.world.started) this.centerOnStart();
        this.syncHint();
        this.toasts.show(t('net.back'), 'good');
      } catch (e) {
        if (e instanceof ConnectError && e.code === 'version') return void this.toasts.show(t('net.version'), 'bad', 8000);
        this.reconnect(Math.min(RECONNECT_MAX_MS, delay * 2));
      }
    }, delay);
  }

  /**
   * I stepped on a mine: the server already took my land back. Once the blast
   * has played, a dialog shows the final score and the title comes back.
   */
  private async gameOver(score: number): Promise<void> {
    saveToken(null);
    this.net?.close();
    this.net = null;
    this.input.enabled = false;
    this.togglePanel(null);
    await wait(GAME_OVER_DELAY_MS);
    await messageDialog(document.getElementById('modal')!, t('over.title'), [{ text: t('over.body') }, { text: t('over.score'), small: true }, { text: fmt(score), big: true }], t('over.button'));
    this.hint?.hide();
    this.hint = null;
    this.game = this.solo;
    this.applyPalette();
    this.openTitle();
  }

  /** A world nobody has opened yet asks for the first click (it founds the main base). */
  private syncHint(): void {
    const want = !this.demo && !this.game.world.started;
    if (want && !this.hint) this.hint = new StartHint(this.appEl, this.game.wrap > 0);
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
        const pal = this.palette();
        this.view.pulse(ev.cells, ev.x, ev.y, ev.wrong === 0 ? pal.success : pal.error);
        // Each new base shows the points it earned rising from its tile.
        if (ev.wrong === 0 && ev.correct > 0) {
          const each = `+${fmt(ev.payout / ev.correct)}`;
          for (const k of ev.cells) this.view.floatText(keyX(k), keyY(k), each, pal.accent);
        }
      }),
      on('hit', (h) => {
        if (demo) {
          const pal = this.palette();
          return this.view.explosion(h.x, h.y, h.blast.r, h.blast.chain, pal.error, pal.warning);
        }
        // No toast: the pool and the combo in the HUD show what the hit cost.
        if (h.actor.kind === 'drone') this.toasts.show(t('toast.droneHit', { id: h.actor.id }), 'bad', 5000);
        const pal = this.palette();
        this.view.explosion(h.x, h.y, h.blast.r, h.blast.chain, pal.error, pal.warning);
        if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      }),
      on('grand', (f) => {
        const mult = `×${f.bonus.toFixed(2)}`;
        this.view.grand(f.members, f.cx, f.cy, t('fx.grand', { m: mult }), this.palette().accent);
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
    this.lockedBubble.hide();
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

  private onPrimary(raw: { x: number; y: number }): void {
    if (this.swallowPrimary) return void (this.swallowPrimary = false);
    if (this.viewOnly()) return;
    const c = this.canon(raw);
    if (!this.game.online && this.game.baseInfo(c.x, c.y)) return this.selectBase(cellKey(c.x, c.y));
    this.view.setSelectedBase(null);
    const s = this.game.cellState(c.x, c.y);
    if (isRevealed(s)) return this.chordAt(c);
    if (this.lockedNotice(c)) return;
    // Touch devices never open a tile by tapping it (tiles open through chords;
    // only the first tap, placing the main base, opens): a tap cycles the mark
    // like a right-click.
    const mark = isTouchDevice() ? this.game.world.started : this.settings.inputMode === 'toggle' && this.flagMode;
    if (mark) {
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
    this.chordLocked(c);
    this.view.rippleFrom = cellKey(c.x, c.y);
    try {
      if (this.game.chord(c.x, c.y).full) this.poolFull();
    } finally {
      this.view.rippleFrom = null;
    }
    const keys: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = this.game.wx(c.x + dx), y = c.y + dy;
        if (this.game.cellState(x, y) === CellState.Unknown && !this.game.fogged(x, y) && !this.game.locked(x, y)) keys.push(cellKey(x, y));
      }
    }
    if (keys.length) this.view.press(keys);
  }

  /** A closed, visible cell of a tier not learned yet: a bubble over it says the mining technology needs upgrading. */
  private lockedNotice(c: { x: number; y: number }): boolean {
    const s = this.game.cellState(c.x, c.y);
    if ((s !== CellState.Unknown && s !== CellState.Flag) || this.game.fogged(c.x, c.y) || !this.game.locked(c.x, c.y)) return false;
    this.lockedBubble.show(cellKey(c.x, c.y));
    return true;
  }

  /**
   * A chord that would open locked neighbours (its flags and known mines match
   * the number) puts the locked-tile bubble over the first of them.
   */
  private chordLocked(c: { x: number; y: number }): void {
    const n = numberOf(this.game.cellState(c.x, c.y));
    let marked = 0;
    let locked: number | null = null;
    forEachNeighbor(
      c.x,
      c.y,
      (x, y) => {
        const s = this.game.cellState(x, y);
        if (s === CellState.Flag || isKnownMine(s)) marked++;
        else if (s === CellState.Unknown && locked === null && !this.game.fogged(x, y) && this.game.locked(x, y)) locked = cellKey(x, y);
      },
      this.game.wrap,
    );
    if (marked === n && locked !== null) this.lockedBubble.show(locked);
  }

  private onSecondary(raw: { x: number; y: number }): void {
    if (this.swallowPrimary) return void (this.swallowPrimary = false);
    if (this.viewOnly()) return;
    const c = this.canon(raw);
    const s = this.game.cellState(c.x, c.y);
    if (this.lockedNotice(c)) return;
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
    this.view.setHover(c && !this.viewOnly() ? this.canon(c) : null);
  }

  private onKey(code: string, ev: KeyboardEvent): void {
    switch (code) {
      case 'Escape':
        this.bubble.hide();
        this.view.setSelectedBase(null);
        this.togglePanel(null);
        break;
      case 'KeyF':
        if (!isTouchDevice()) this.setFlagMode(!this.flagMode);
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
    this.hud.setFlagMode(on, this.flagModeShown());
  }

  /** The flag-mode button only exists in toggle input, and not on touch devices (a tap already marks). */
  private flagModeShown(): boolean {
    return this.settings.inputMode === 'toggle' && !isTouchDevice();
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
    // Online there is no main-base panel (no levels, no upgrades).
    if (this.game.online) return;
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
    this.solo = g;
    this.replaceGame(g);
    void this.save(true);
  }

  /**
   * A fresh world is all fog until the first click places the main base
   * (`syncHint` asks for it); the view starts on the start cell. A fresh Earth
   * world starts zoomed out on the whole map, to pick where to found it.
   */
  private centerOnStart(): void {
    const map = this.game.world.map;
    if (map && !this.game.world.started) {
      this.cam.zoom = 0;
      this.cam.centerOnCell(map.w / 2, map.h / 2);
      return;
    }
    const s = this.game.startCell();
    this.cam.centerOnCell(s.x, s.y);
  }

  private goHome(): void {
    if (!this.game.world.started) return this.centerOnStart();
    const s = this.game.startCell();
    this.gotoCell(s.x, s.y);
  }

  /** Online: the camera goes to a player's main base (zoomed in far enough to play), flashing it in their colour. */
  private gotoPlayer(color: number): void {
    const g = this.game;
    if (!(g instanceof MirrorGame) || !this.input.enabled) return;
    const main = g.players.find((p) => p.color === color)?.main ?? null;
    if (main === null) return;
    if (this.cam.zoom < VIEW_ONLY_ZOOM) this.cam.zoom = 1;
    this.cam.centerOnCell(keyX(main), keyY(main));
    this.view.flash([main], SIGNATURE_COLORS[color], 1500);
  }

  private gotoCell(x: number, y: number): void {
    this.cam.centerOnCell(x, y);
    this.view.flash([cellKey(x, y)], this.palette().accent, 1500);
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
    applyTheme(resolveTheme(s.theme));
    this.applyPalette();
    setLang(resolveLang(s.lang));
    this.viewHint?.relabel();
    const touch = isTouchDevice();
    document.documentElement.classList.toggle('touch', touch);
    if (this.hud) {
      this.hud.build();
      this.hud.setFlagMode(this.flagMode, this.flagModeShown());
      this.syncHudActive();
    }
    if (rerender) this.refreshPanel();
  }

  /** Only the endless world is saved here; online sessions live on the server. */
  private async save(force: boolean): Promise<void> {
    if (this.saving || this.game.online) return;
    if (!force && !this.dirty) return;
    this.saving = true;
    try {
      await writeSave(this.game.toSave(), 'main');
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
