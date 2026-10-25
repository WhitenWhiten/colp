import type { StorageArea } from '../credential-store.js';
import type { SyncScope } from '../sync-state-store.js';
import { readHealthRecord } from './replica-health-delivery.js';

/** A report that keeps failing for this long means the Sync center's picture of this browser is probably old. */
export const HEALTH_DELIVERY_GRACE_MS = 5 * 60_000;

export interface HealthDeliveryFailure {
  /** Why the last send failed (`health_http_503`, `health_unreachable`, …). */
  readonly code: string;
  /** When sends began to fail (epoch milliseconds). */
  readonly since: number;
}

/**
 * Whether the reporter has been unable to tell the server about this browser
 * for long enough to matter. One failed send is retried a minute later and is
 * not news; several minutes of failure is, because the Sync center then shows
 * a state this browser left a while ago.
 */
export function healthDeliveryFailure(record: unknown, now: number): HealthDeliveryFailure | undefined {
  const failed = record && typeof record === 'object' ? (record as { readonly failed?: unknown }).failed : undefined;
  if (!failed || typeof failed !== 'object') return undefined;
  const { code, since, at } = failed as { readonly code?: unknown; readonly since?: unknown; readonly at?: unknown };
  const from = typeof since === 'number' ? since : typeof at === 'number' ? at : undefined;
  if (from === undefined || now - from < HEALTH_DELIVERY_GRACE_MS) return undefined;
  return { code: typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : 'health_unreachable', since: from };
}

export async function readHealthDeliveryFailure(storage: Pick<StorageArea, 'get'>, scope: SyncScope,
  now: number): Promise<HealthDeliveryFailure | undefined> {
  try { return healthDeliveryFailure(await readHealthRecord(storage, scope), now); } catch { return undefined; }
}
