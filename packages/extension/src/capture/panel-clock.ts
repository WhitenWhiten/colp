/** Counts eligible visible time only. A browser close is never a timeout acceptance. */
export function createPanelClock(durationMs: number, now: () => number) {
  let remaining = durationMs, startedAt: number | null = null, presented = false, terminal = false;
  const pauses = new Set<string>();
  const consume = () => { if (startedAt !== null) { remaining = Math.max(0, remaining - Math.max(0, now() - startedAt)); startedAt = now(); } };
  return {
    present() { if (presented || terminal) return; presented = true; if (durationMs > 0 && !pauses.size) startedAt = now(); },
    pause(reason: string) { consume(); pauses.add(reason); startedAt = null; },
    resume(reason: string) { pauses.delete(reason); if (!pauses.size && presented && !terminal && durationMs > 0) {
      remaining = Math.max(remaining, 1200); startedAt = now();
    } },
    stop() { terminal = true; startedAt = null; },
    ready() { consume(); return presented && !terminal && durationMs > 0 && pauses.size === 0 && remaining === 0; },
    finish(): boolean { consume(); if (!presented || terminal || durationMs === 0 || pauses.size || remaining > 0) return false;
      terminal = true; startedAt = null; return true; },
    remaining() { consume(); return remaining; },
  };
}
