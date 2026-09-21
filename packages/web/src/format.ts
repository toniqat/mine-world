/** Compact number formatting for the HUD (1.2K, 3.4M ...). */
const UNITS = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'];

export function fmt(n: number, digits = 1): string {
  if (!isFinite(n)) return '∞';
  const neg = n < 0;
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  let s: string;
  if (u === 0) s = v < 100 ? v.toFixed(v < 10 && v % 1 !== 0 ? digits : 0) : Math.round(v).toString();
  else s = v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0);
  return (neg ? '-' : '') + s + UNITS[u];
}

export function pct(v: number, digits = 0): string {
  return (v * 100).toFixed(digits) + '%';
}

export function clock(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
