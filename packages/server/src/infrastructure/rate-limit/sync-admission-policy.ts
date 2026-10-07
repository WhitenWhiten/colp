import { createHash } from 'node:crypto';

export const SYNC_ADMISSION_PURPOSES = Object.freeze([
  'session',
  'snapshot',
  'push',
  'pull',
  'conflict',
  'effect-page',
  'ack',
  'retire',
] as const);

export type SyncAdmissionPurpose = (typeof SYNC_ADMISSION_PURPOSES)[number];

export type SyncAdmissionOutcome =
  | { readonly kind: 'allowed'; readonly retryAfterSeconds: number }
  | { readonly kind: 'denied'; readonly retryAfterSeconds: number }
  | { readonly kind: 'failed'; readonly reason: 'limiter_unavailable' };

export interface SyncAdmissionBudget {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export type SyncAdmissionBudgets = Partial<Record<SyncAdmissionPurpose, SyncAdmissionBudget>>;

export interface SyncAdmissionReadiness {
  readonly status: 'healthy' | 'degraded';
  readonly reason: 'none' | 'connecting' | 'last_command_failed' | 'closed';
}

export interface SyncAdmissionPolicy {
  admitPreAuth(input: {
    readonly purpose: SyncAdmissionPurpose;
    readonly clientKey: string;
  }): Promise<SyncAdmissionOutcome>;
  admitSubject(input: {
    readonly purpose: SyncAdmissionPurpose;
    readonly subjectKey: string;
  }): Promise<SyncAdmissionOutcome>;
  readiness(): SyncAdmissionReadiness;
  close(): Promise<void>;
}

/** The aggregate quota belongs to the verified principal, not wire-supplied IDs. */
export function syncAdmissionSubjectKey(input: {
  readonly credential: { readonly issuer: string; readonly subject: string; readonly clientId: string; readonly credentialId: string };
  readonly replicaId?: string;
  readonly sessionId?: string;
}): string {
  // Credential/client, replica and session rotation must not replenish quota.
  // JSON framing prevents delimiter collisions; hash to keep identifiers out of keys.
  return `subject:${createHash('sha256').update(JSON.stringify([
    input.credential.issuer, input.credential.subject,
  ])).digest('hex')}`;
}

export function syncAdmissionPolicyHeader(
  purpose: SyncAdmissionPurpose,
  budget: SyncAdmissionBudget,
): string {
  return `"sync-${purpose}";q=${budget.maxRequests};w=${Math.ceil(budget.windowMs / 1_000)}`;
}

export function createMemorySyncAdmissionPolicy(input: {
  readonly budgets: SyncAdmissionBudgets;
  readonly now?: () => number;
  /** Capacity per lane; unauthenticated identities cannot fill the subject lane. */
  readonly maxBuckets?: number;
}): SyncAdmissionPolicy {
  const now = input.now ?? Date.now;
  const maxBuckets = input.maxBuckets ?? 10_000;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new TypeError('Sync admission maxBuckets must be a positive safe integer');
  }
  type Bucket = { count: number; resetAt: number };
  const buckets = { preauth: new Map<string, Bucket>(), subject: new Map<string, Bucket>() };
  const sweepIntervalMs = 1_000;
  let nextSweepAt = now() + sweepIntervalMs;
  let closed = false;
  const sweep = (t: number): void => {
    for (const lane of Object.values(buckets)) {
      for (const [key, bucket] of lane) if (t >= bucket.resetAt) lane.delete(key);
    }
    nextSweepAt = t + sweepIntervalMs;
  };
  // Reclaim expired identities even when requests stop; never keep Node alive.
  const timer = setInterval(() => sweep(now()), sweepIntervalMs);
  timer.unref();
  const consume = async (
    lane: 'preauth' | 'subject',
    purpose: SyncAdmissionPurpose,
    identity: string,
  ): Promise<SyncAdmissionOutcome> => {
    const budget = input.budgets[purpose];
    if (closed || budget === undefined || !Number.isSafeInteger(budget.maxRequests)
      || budget.maxRequests < 0 || !Number.isSafeInteger(budget.windowMs) || budget.windowMs < 1) {
      return { kind: 'failed', reason: 'limiter_unavailable' };
    }
    const t = now();
    if (t >= nextSweepAt) sweep(t);
    const pool = buckets[lane];
    const key = `${purpose}:${createHash('sha256').update(identity).digest('hex')}`;
    let bucket = pool.get(key);
    if (!bucket || t >= bucket.resetAt) {
      if (!bucket && pool.size >= maxBuckets) {
        // Fail closed: evicting a live bucket would replenish an attacker's quota.
        return { kind: 'denied', retryAfterSeconds: Math.max(1, Math.ceil((nextSweepAt - t) / 1_000)) };
      }
      bucket = { count: 0, resetAt: t + budget.windowMs };
      pool.set(key, bucket);
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - t) / 1_000));
    if (bucket.count >= budget.maxRequests) {
      return { kind: 'denied', retryAfterSeconds };
    }
    bucket.count += 1;
    return { kind: 'allowed', retryAfterSeconds };
  };
  return {
    admitPreAuth: ({ purpose, clientKey }) => consume('preauth', purpose, clientKey),
    admitSubject: ({ purpose, subjectKey }) => consume('subject', purpose, subjectKey),
    readiness: () => closed ? { status: 'degraded', reason: 'closed' } : { status: 'healthy', reason: 'none' },
    close: async () => {
      closed = true;
      clearInterval(timer);
      buckets.preauth.clear();
      buckets.subject.clear();
    },
  };
}

export function resolveSyncAdmissionPolicy(
  injected: SyncAdmissionPolicy | undefined,
  purpose: SyncAdmissionPurpose,
  budget: SyncAdmissionBudget,
  now?: () => number,
): SyncAdmissionPolicy {
  if (injected !== undefined) return injected;
  return createMemorySyncAdmissionPolicy({
    budgets: { [purpose]: budget },
    ...(now === undefined ? {} : { now }),
  });
}
