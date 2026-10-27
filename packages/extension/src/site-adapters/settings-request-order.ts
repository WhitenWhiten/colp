/** A mutation owns the visible state until its reply; earlier polls cannot undo that reply. */
export function createSettingsRequestOrder() {
  let generation = 0, readNumber = 0, pending: string | null = null;
  return {
    get pending() { return pending; },
    read() {
      const ownGeneration = generation, ownRead = ++readNumber, allowed = pending === null;
      return () => allowed && pending === null && ownGeneration === generation && ownRead === readNumber;
    },
    action(kind: string) {
      if (pending) return null;
      pending = kind; const ownGeneration = ++generation;
      return {
        current: () => ownGeneration === generation,
        finish() { if (ownGeneration === generation) pending = null; },
      };
    },
  };
}
