const RETRY_KEY = 'known.bookmark.recovery-retry.v1';
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 300_000;

interface Ports {
  readonly name: string;
  readonly now?: () => number;
  readonly alarms: {
    get(name: string): Promise<{ scheduledTime: number } | undefined>;
    create(name: string, info: { when: number }): void | Promise<void>;
  };
  readonly storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
  };
}

/** Persist the backoff across MV3 worker eviction without postponing a pending wake. */
export function createBookmarkRecoveryScheduler(ports: Ports) {
  let lane = Promise.resolve();
  const run = (work: () => Promise<void>) => {
    const next = lane.then(work);
    lane = next.catch(() => { /* the caller receives the original rejection */ });
    return next;
  };
  return {
    schedule: () => run(async () => {
      const now = (ports.now ?? Date.now)();
      const alarm = await ports.alarms.get(ports.name);
      if (alarm && alarm.scheduledTime >= now) return;
      const stored = (await ports.storage.get(RETRY_KEY))[RETRY_KEY];
      const attempts = typeof stored === 'number' && Number.isSafeInteger(stored)
        ? Math.min(4, Math.max(0, stored)) : 0;
      await ports.alarms.create(ports.name, { when: now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts) });
      await ports.storage.set({ [RETRY_KEY]: Math.min(4, attempts + 1) });
    }),
    reset: () => run(() => ports.storage.set({ [RETRY_KEY]: 0 })),
  };
}
