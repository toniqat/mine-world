/** Minimal typed event emitter. Core emits, UI subscribes (INV-6). */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) (fn as (p: Events[K]) => void)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
