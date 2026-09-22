import { SIGNATURE_COLORS, type PlayerInfo } from '@mine/core';
import { fmt } from '../format';
import { t, type StringKey } from '../i18n';
import { hex } from '../theme';
import { el } from './dom';

/** How long the dialog takes to drop in or lift away (matches style.css). */
const MODAL_MS = 200;

/**
 * Final standings of a complete session (user decision 2026-09-22): the top
 * three on a podium in the order 2, 1, 3 at the top, everyone from 4th on in
 * a list under it, then Close (keep looking at the frozen world) and Next
 * session. `players` is sorted by score, the winner first. The backdrop does
 * not close it.
 */
export function standingsDialog(root: HTMLElement, players: PlayerInfo[], me: number): Promise<'close' | 'next'> {
  return new Promise((resolve) => {
    const close = (v: 'close' | 'next') => {
      root.classList.remove('show');
      resolve(v);
      setTimeout(() => {
        if (root.classList.contains('show')) return;
        root.hidden = true;
        root.replaceChildren();
      }, MODAL_MS);
    };
    const name = (p: PlayerInfo) =>
      el('span', { class: 'st-name' }, t(`color.${p.color}` as StringKey), p.color === me ? el('span', { class: 'sb-you', text: t('board.you') }) : null);
    const dot = (p: PlayerInfo, cls: string) => {
      const d = el('span', { class: cls });
      d.style.background = hex(SIGNATURE_COLORS[p.color]);
      return d;
    };

    const podium = el('div', { class: 'podium' });
    for (const rank of [2, 1, 3]) {
      const p = players[rank - 1];
      if (!p) continue;
      const block = el('div', { class: 'st-block', text: String(rank) });
      block.style.borderTopColor = hex(SIGNATURE_COLORS[p.color]);
      podium.append(el('div', { class: `st-place p${rank}${p.color === me ? ' me' : ''}` }, dot(p, 'st-dot'), name(p), el('span', { class: 'st-score', text: fmt(p.score) }), block));
    }

    const rest = players.slice(3).map((p, i) =>
      el('div', { class: `sb-row${p.color === me ? ' me' : ''}` }, el('span', { class: 'st-rank', text: String(i + 4) }), dot(p, 'sb-dot'), name(p), el('span', { class: 'sb-score', text: fmt(p.score) })),
    );

    const winner = players[0];
    const next = el('button', { class: 'btn primary', text: t('standings.next'), onclick: () => close('next') });
    root.replaceChildren(
      el(
        'div',
        { class: 'box standings' },
        el('h3', { text: t('standings.title') }),
        winner ? el('p', { class: 'small', text: t('standings.winner', { c: t(`color.${winner.color}` as StringKey) }) }) : null,
        podium,
        rest.length ? el('div', { class: 'st-list' }, ...rest) : null,
        el('div', { class: 'buttons' }, el('button', { class: 'btn', text: t('standings.close'), onclick: () => close('close') }), next),
      ),
    );
    root.hidden = false;
    void root.offsetWidth;
    root.classList.add('show');
    root.onclick = null;
    requestAnimationFrame(() => next.focus());
  });
}
