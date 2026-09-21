import { Application } from 'pixi.js';
import { CellState, Game, cellKey, isRevealed, keyX, keyY, type SaveData } from '@mine/core';
import { fmt, pct } from './format';
import { resolveLang, setLang, t, upgradeName } from './i18n';
import { InputController } from './input';
import { BoardView } from './render/boardView';
import { Camera } from './render/camera';
import { loadSettings, saveSettings, writeSave, type Settings } from './storage';
import { PALETTES, applyTheme, onSystemThemeChange, resolveTheme } from './theme';
import { Hud, type PanelName } from './ui/hud';
import { Panels } from './ui/panels';
import { Toasts, confirmDialog } from './ui/toast';

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
  private toasts!: Toasts;
  private flagMode = false;
  /** Drone being dragged to another Owned mine (drones exist only with equipment). */
  private drag: { id: number } | null = null;
  private dirty = false;
  private lastSave = 0;
  private saving = false;
  private panelTimer = 0;
  private unsub: Array<() => void> = [];

  constructor(saved: SaveData | null) {
    this.settings = loadSettings();
    setLang(resolveLang(this.settings.lang));
    applyTheme(resolveTheme(this.settings.theme));
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

    this.view = new BoardView(this.app, this.game, palette);
    this.app.stage.addChild(this.view.root);
    this.toasts = new Toasts(document.getElementById('toasts')!);
    this.hud = new Hud(document.getElementById('hud')!, document.getElementById('statusbar')!, {
      cashOut: () => this.cashOut(),
      togglePanel: (n) => this.togglePanel(n),
      toggleMain: () => this.toggleMain(),
      home: () => this.goHome(),
      toggleFlagMode: () => this.setFlagMode(!this.flagMode),
    });
    this.panels = new Panels(document.getElementById('panel')!, {
      buy: (id) => this.buy(id),
      gotoCell: (x, y) => this.gotoCell(x, y),
      upgradeMainBase: () => this.upgradeMainBase(),
      repairBase: (x, y) => this.repairBase(x, y),
      liquidate: () => this.liquidate(),
      newGame: () => this.restart(),
      saveNow: () => this.save(true),
      settingsChanged: (s) => this.applySettings(s),
      close: () => this.togglePanel(null),
    });
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
    this.bindGame();
    this.cam.resize(this.app.screen.width, this.app.screen.height);
    this.centerOnStart();

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
      if (acc >= 0.1) {
        this.game.tick(acc);
        acc = 0;
      }
      this.view.setDroneTiming(acc, this.game.droneActionsPerSec(), this.game.droneMoveSpeed());
      this.view.update(this.cam);
      this.hud.update(this.game);
      this.hud.setRight(`${t('status.zoom')} ${Math.round(this.cam.zoom * 100)}% · ${t('status.seed')} ${this.game.cfg.seed}`);
      if (this.dirty && performance.now() - this.lastSave > 15000) void this.save(false);
      this.panelTimer += dt;
      if (this.panels.current === 'base' && this.panelTimer > 1) {
        this.panelTimer = 0;
        this.refreshPanel();
      }
    });
  }

  // ---------------------------------------------------------------- game glue

  private bindGame(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    const g = this.game;
    const on = g.events.on.bind(g.events);
    this.unsub.push(
      on('cells', (list) => {
        this.view.applyChanges(list);
        this.dirty = true;
      }),
      on('settlement', (ev) => {
        const pal = PALETTES[resolveTheme(this.settings.theme)];
        this.view.pulse(ev.cells, ev.x, ev.y, ev.wrong === 0 ? pal.success : pal.error);
      }),
      on('hit', (h) => {
        if (h.actor.kind === 'drone') this.toasts.show(t('toast.droneHit', { id: h.actor.id }), 'bad', 5000);
        else this.toasts.show(t('toast.hit', { loss: fmt(h.loss) }), 'bad');
        if (h.blast.disabled.length) this.toasts.show(t('toast.blast', { r: h.blast.r.toFixed(1), n: h.blast.disabled.length }), 'bad', 5000);
        const pal = PALETTES[resolveTheme(this.settings.theme)];
        this.view.blast(h.x, h.y, h.blast.r, pal.error, pal.warning);
        if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      }),
      on('grand', (f) => {
        const mult = `×${f.bonus.toFixed(2)}`;
        this.view.grand(f.members, f.cx, f.cy, t('fx.grand', { m: mult }), PALETTES[resolveTheme(this.settings.theme)].accent);
        this.toasts.show(t('toast.grand', { n: f.members.length, m: mult }), 'good', 4000);
      }),
      on('fog', (keys) => {
        this.view.liftFog(keys);
        this.dirty = true;
      }),
      on('tech', (tier) => {
        this.view.refreshAll();
        this.toasts.show(t('toast.tech', { t: tier }), 'good');
      }),
      on('scanners', (list) => this.view.setScanners(list)),
      on('drones', () => this.syncDrones()),
      on('bases', () => {
        this.view.markBasesDirty();
        if (this.panels.current === 'base') this.refreshPanel();
      }),
      on('econ', () => (this.dirty = true)),
      on('log', () => {
        if (this.panels.current === 'log') this.refreshPanel();
      }),
    );
    this.view.setScanners(g.scanners);
    this.syncDrones();
  }

  private syncDrones(): void {
    this.view.setDrones(this.game.drones.drones, this.game.droneRadius());
  }

  private replaceGame(g: Game): void {
    this.game = g;
    this.view.setGame(g);
    this.bindGame();
    this.centerOnStart();
    this.dirty = true;
    this.refreshPanel();
  }

  // ------------------------------------------------------------------ input

  private onPrimary(c: { x: number; y: number }): void {
    if (this.game.baseInfo(c.x, c.y)) return this.selectBase(cellKey(c.x, c.y));
    const s = this.game.cellState(c.x, c.y);
    if (isRevealed(s)) return this.chordAt(c);
    if (this.lockedToast(c)) return;
    if (this.settings.inputMode === 'toggle' && this.flagMode) {
      this.game.cycleMark(c.x, c.y);
      return;
    }
    if (s === CellState.Unknown) this.game.reveal(c.x, c.y);
  }

  /** Chord a number; the closed neighbours it could open (not fogged or locked) that stay closed look pressed. */
  private chordAt(c: { x: number; y: number }): void {
    this.game.chord(c.x, c.y);
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
    if (c) {
      const d = this.game.densityAt(c.x, c.y);
      const tier = this.game.cfg.tiers.enabled && this.game.world.started ? ` · ${t('status.tier')} ${this.game.tierAt(c.x, c.y)}` : '';
      this.hud.setCoords(`(${c.x}, ${c.y})${tier} · ${t('status.density')} ${pct(d)}${this.settings.showDensity ? ` · ${fmt(this.game.mineValueAt(c.x, c.y))}` : ''}`);
    } else this.hud.setCoords('');
  }

  private onKey(code: string, ev: KeyboardEvent): void {
    switch (code) {
      case 'Escape':
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
      case 'KeyL':
        this.togglePanel('log');
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
    this.toasts.show(t('toast.cashout', { amount: fmt(amt) }), 'good');
  }

  private buy(id: string): void {
    const r = this.game.buy(id);
    if (r.ok) this.toasts.show(t('toast.bought', { name: upgradeName(id) }), 'good');
    else if (r.reason === 'money') this.toasts.show(t('toast.noMoney'), 'bad');
    this.refreshPanel();
  }

  private selectBase(key: number): void {
    this.panels.base = key;
    this.view.setSelectedBase(key);
    if (this.panels.current === 'base') {
      this.refreshPanel();
      this.syncHudActive();
    } else this.togglePanel('base');
  }

  /** The HUD's main-base button and a click on the main base open the same panel. */
  private toggleMain(): void {
    const main = this.game.bases.main;
    if (this.panels.current === 'base' && (this.panels.base === null || this.panels.base === main)) return this.togglePanel(null);
    if (main === null) {
      this.panels.base = null;
      this.view.setSelectedBase(null);
      if (this.panels.current === 'base') return this.refreshPanel(), this.syncHudActive();
      return this.togglePanel('base');
    }
    this.selectBase(main);
  }

  private repairBase(x: number, y: number): void {
    const r = this.game.repairBase(x, y);
    if (r.ok) this.toasts.show(t('toast.repaired'), 'good');
    else if (r.reason === 'money') this.toasts.show(t('toast.noMoney'), 'bad');
    this.refreshPanel();
  }

  private upgradeMainBase(): void {
    const r = this.game.upgradeMainBase();
    if (r.ok) this.toasts.show(t('toast.baseUp', { n: this.game.bases.mainLevel }), 'good');
    else if (r.reason === 'money') this.toasts.show(t('toast.noMoney'), 'bad');
    this.refreshPanel();
  }

  private async liquidate(): Promise<void> {
    const ok = await confirmDialog(document.getElementById('modal')!, t('prestige.confirm'), t('confirm.yes'), t('confirm.no'));
    if (!ok) return;
    const gain = this.game.liquidate();
    if (gain === null) return;
    this.toasts.show(t('toast.prestige', { gain }), 'good', 5000);
    this.view.setGame(this.game);
    this.bindGame();
    this.centerOnStart();
    this.refreshPanel();
    void this.save(true);
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

  /** A fresh world is all fog until the first click places the main base; the view starts on the start cell. */
  private centerOnStart(): void {
    const s = this.game.startCell();
    this.cam.centerOnCell(s.x, s.y);
    if (!this.game.world.started) this.toasts.show(t('toast.placeMain'), 'info', 6000);
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
    if (next !== 'base') {
      this.panels.base = null;
      this.view.setSelectedBase(null);
    }
    this.panels.open(next, this.game, this.settings);
    this.syncHudActive();
  }

  private syncHudActive(): void {
    const cur = this.panels.current;
    if (cur !== 'base') return this.hud.setActive(cur);
    const main = this.panels.base === null || this.panels.base === this.game.bases.main;
    this.hud.setActive(main ? 'main' : null);
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

export { keyX, keyY };
