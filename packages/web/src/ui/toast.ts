import { el } from './dom';

/** Non-blocking toasts (bottom centre) and a minimal confirm modal. */
export class Toasts {
  constructor(private root: HTMLElement) {}

  show(text: string, kind: 'good' | 'bad' | 'info' = 'info', ms = 3200): void {
    const node = el('div', { class: `toast ${kind}`, text });
    this.root.append(node);
    requestAnimationFrame(() => node.classList.add('show'));
    while (this.root.children.length > 4) this.root.removeChild(this.root.firstChild!);
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 200);
    }, ms);
  }
}

export function confirmDialog(root: HTMLElement, message: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      root.hidden = true;
      root.replaceChildren();
      resolve(v);
    };
    const box = el(
      'div',
      { class: 'box' },
      el('p', { text: message }),
      el(
        'div',
        { class: 'buttons' },
        el('button', { class: 'btn', text: no, onclick: () => close(false) }),
        el('button', { class: 'btn primary', text: yes, onclick: () => close(true) }),
      ),
    );
    root.replaceChildren(box);
    root.hidden = false;
    root.onclick = (e) => {
      if (e.target === root) close(false);
    };
  });
}
