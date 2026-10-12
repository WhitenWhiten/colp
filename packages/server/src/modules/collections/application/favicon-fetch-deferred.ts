/** Admission/cooldown is scheduling, not a failed image attempt. */
export class FaviconFetchDeferred extends Error {
  constructor(readonly retryAt: Date) {
    super('favicon source is waiting for its next permitted request');
    this.name = 'FaviconFetchDeferred';
  }
}

/** A provider response; the shared scheduler persists its cooldown. */
export class FaviconProviderThrottled extends Error {
  constructor(readonly retryAfter: string | null) {
    super('favicon provider returned HTTP 429');
    this.name = 'FaviconProviderThrottled';
  }
}

export function faviconRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds * 1000) && seconds * 1000 + now <= 8.64e15 ? seconds * 1000 : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
