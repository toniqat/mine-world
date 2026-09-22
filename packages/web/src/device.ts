/**
 * Touch devices (a coarse primary pointer: phones, tablets) play by touch
 * rules: tapping a closed tile cycles its mark instead of opening it, and
 * there is no long press or flag mode. Decided per device, not per event, so
 * a mouse plugged into a tablet still follows the touch rules.
 */
const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;

export function isTouchDevice(): boolean {
  return coarse?.matches ?? false;
}

/** Call `fn` when the device switches between touch and mouse rules (e.g. a convertible). */
export function onTouchDeviceChange(fn: () => void): void {
  coarse?.addEventListener('change', fn);
}
