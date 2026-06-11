type Listener = (payload: unknown) => void;

/**
 * Tiny strongly-typed event emitter.
 *
 * `E` maps event keys to payload types (see `GameEvents` in types.ts).
 */
export class Emitter<E> {
  private listeners = new Map<keyof E, Set<Listener>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof E>(key: K, fn: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(key, set);
    }
    const listener = fn as Listener;
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (current !== undefined) {
        current.delete(listener);
        if (current.size === 0) this.listeners.delete(key);
      }
    };
  }

  emit<K extends keyof E>(key: K, payload: E[K]): void {
    const set = this.listeners.get(key);
    if (set === undefined || set.size === 0) return;
    // Defensive copy: listeners may subscribe/unsubscribe during emit.
    for (const fn of [...set]) fn(payload);
  }

  /** Remove all listeners for all events. */
  clear(): void {
    this.listeners.clear();
  }
}
