import type { StorageArea } from '../credential-store.js';
import { LIMITS } from './limits.js';
export interface ReadSlot { id: string; documentId: string; deadlineAt: number }
export interface SchedulerState { active: ReadSlot | null; nextAt: number }
/** Durable single-command ownership. A lost worker keeps its deadline/cooldown. */
export function createReadScheduler(storage: StorageArea, key: string, now = Date.now) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const result = tail.then(f); tail = result.catch(() => undefined); return result; };
  const read = async () => (await storage.get(key))[key] as SchedulerState | undefined ?? { active: null, nextAt: 0 };
  return {
    acquire: (slot: ReadSlot, reuseDocument = false) => serial(async () => {
      const s = await read();
      if (reuseDocument && s.active?.documentId === slot.documentId && s.active.deadlineAt > now()) return { status: 'ready' as const, id: s.active.id, deadlineAt: s.active.deadlineAt };
      const availableAt = Math.max(s.nextAt, s.active?.deadlineAt ?? 0);
      if (availableAt > now()) return { status: 'paused' as const, retryAfterMs: availableAt - now() };
      await storage.set({ [key]: { active: slot, nextAt: slot.deadlineAt + LIMITS.spacingMs } });
      return { status: 'ready' as const, id: slot.id, deadlineAt: slot.deadlineAt };
    }),
    finish: (id: string, cooldownMs: number = LIMITS.spacingMs) => serial(async () => {
      const s = await read(); if (s.active?.id !== id) return;
      await storage.set({ [key]: { active: null, nextAt: now() + Math.max(LIMITS.spacingMs, cooldownMs) } });
    }),
    current: () => serial(read),
  };
}
