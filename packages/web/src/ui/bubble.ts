import { keyX, keyY, type Game } from '@mine/core';
import { t } from '../i18n';
import type { Camera } from '../render/camera';
import { CELL } from '../render/textures';
import { el } from './dom';
import { costButton } from './panels';

/**
 * Speech bubble over a disabled base with its Repair button (the credit cost
 * inside, dimmed while unaffordable). It follows the base as the camera
 * moves; the app closes it on any click outside it.
 */
export class RepairBubble {
  /** Base the bubble points at, or null while hidden. */
  key: number | null = null;
  private box: HTMLElement | null = null;
  /** Cost and affordability last rendered, to rebuild only when they change. */
  private shown = '';

  constructor(
    private root: HTMLElement,
    private repair: (x: number, y: number) => void,
  ) {}

  show(key: number, game: Game): void {
    this.hide();
    this.key = key;
    this.box = el('div', { class: 'bubble' });
    this.root.append(this.box);
    this.render(game);
  }

  hide(): void {
    this.box?.remove();
    this.box = null;
    this.key = null;
    this.shown = '';
  }

  contains(target: EventTarget | null): boolean {
    return this.box !== null && target instanceof Node && this.box.contains(target);
  }

  /** Per frame: follow the base on screen, refresh the button when credits change; hides once the base is no longer disabled. */
  update(game: Game, cam: Camera): void {
    if (this.key === null || !this.box) return;
    if (!game.bases.disabled.has(this.key)) return this.hide();
    this.render(game);
    const p = cam.worldToScreen((keyX(this.key) + 0.5) * CELL, (keyY(this.key) + 0.15) * CELL);
    this.box.style.left = `${Math.round(p.x)}px`;
    this.box.style.top = `${Math.round(p.y)}px`;
  }

  private render(game: Game): void {
    const key = this.key!;
    const cost = game.repairCost();
    const afford = game.econ.canAfford(cost);
    const sig = `${cost}|${afford}`;
    if (sig === this.shown) return;
    this.shown = sig;
    this.box!.replaceChildren(
      el('div', { class: 'name', text: t('base.disabled') }),
      el('div', { class: 'desc', text: t('base.disabledHint') }),
      costButton(t('base.repair'), cost, afford, () => this.repair(keyX(key), keyY(key))),
    );
  }
}
