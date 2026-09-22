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

/** How long a dialog takes to drop in or lift away (matches style.css). */
const MODAL_MS = 200;

/** Confirm dialog: the backdrop fades in while the box drops from a little above; closing plays it backwards. */
export function confirmDialog(root: HTMLElement, message: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const close = (v: boolean) => {
      if (done) return;
      done = true;
      root.classList.remove('show');
      resolve(v);
      setTimeout(() => {
        // A new dialog may have opened meanwhile.
        if (root.classList.contains('show')) return;
        root.hidden = true;
        root.replaceChildren();
      }, MODAL_MS);
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
    void root.offsetWidth;
    root.classList.add('show');
    root.onclick = (e) => {
      if (e.target === root) close(false);
    };
  });
}
