/**
 * P4A-I05/P4A-I15 attachments capability readiness.
 *
 * The readiness payload is intentionally minimal and contains no sensitive
 * fields: never a bucket, prefix, origin query, secret reference, or key
 * material. Status values follow the cache/feed/notifications capability
 * convention (`ready` -> 200; `disabled`/`degraded`/`not-ready` -> 503 on the
 * capability endpoint) while the global API probe stays independent.
 *
 * P4A-I15 extends the evaluation with live facts: API (durable admission
 * switch), Worker (verification + cleanup backlog gauges) and Delivery (host
 * availability gauge). The evaluator is a PURE function of facts — it never
 * performs destructive operations and never touches the network. When no
 * facts are supplied the legacy payload is returned unchanged (enabled +
 * validly configured -> ready; invalid config never reaches this point
 * because `loadConfig` fails closed first).
 *
 * P4A-P10 adds the two NECESSARY-dependency facts — PostgreSQL (`database`)
 * and the object store / R2 (`objectStore`): when either degrades, the
 * attachments capability FAILS CLOSED (`not-ready` + `dependency_unavailable`)
 * while the API component stays ready, so a partial attachments dependency
 * failure never drags the global API down (plan §9 P10: "全局 API 不因
 * attachments 依赖故障无条件下线"). The dependency verdicts follow the RL04
 * rule: they only ever degrade or block, never upgrade an already worse
 * verdict.
 */
import type { AttachmentsFeatureConfig } from './attachments-config.js';

export type AttachmentsCapabilityStatus = 'ready' | 'degraded' | 'not-ready' | 'disabled';

export type AttachmentsCapabilityReason =
  | 'none'
  | 'not_enabled'
  | 'dependency_unavailable'
  | 'admission_stopped'
  | 'worker_degraded'
  | 'worker_unavailable'
  | 'delivery_unavailable';

/** Worker backlog thresholds (fixed; not sensitive). */
export const ATTACHMENTS_WORKER_VERIFICATION_BACKLOG_DEGRADED = 1_000;
export const ATTACHMENTS_WORKER_VERIFICATION_BACKLOG_NOT_READY = 10_000;
export const ATTACHMENTS_WORKER_CLEANUP_BACKLOG_DEGRADED = 1_000;
export const ATTACHMENTS_WORKER_CLEANUP_BACKLOG_NOT_READY = 10_000;

export interface AttachmentsComponentStatus {
  readonly status: 'ready' | 'degraded' | 'not-ready';
  /** Fixed reason code; never free-form or sensitive text. */
  readonly reason:
    | 'none'
    | 'not_reported'
    | 'admission_stopped'
    | 'backlog_elevated'
    | 'backlog_exceeded'
    | 'delivery_host_unavailable';
}

export interface AttachmentsCapabilityReadiness {
  readonly capability: 'attachments';
  readonly status: AttachmentsCapabilityStatus;
  readonly reason: AttachmentsCapabilityReason;
  /** P4A-I15: present only when live facts were supplied. */
  readonly components?: Readonly<{
    readonly api: AttachmentsComponentStatus;
    readonly worker: AttachmentsComponentStatus & { readonly verificationBacklog: number; readonly cleanupBacklog: number };
    readonly delivery: AttachmentsComponentStatus & { readonly hostAvailable?: boolean };
  }>;
}

/** P4A-I15 live readiness facts; absent fields are reported as `not_reported`. */
export interface AttachmentsReadinessFacts {
  readonly admission?: { readonly enabled: boolean };
  readonly worker?: { readonly verificationBacklog?: number; readonly cleanupBacklog?: number };
  readonly delivery?: { readonly hostAvailable?: boolean };
  /**
   * P4A-RL04 distributed admission limiter fact (plan §13.1 step 3/4): a
   * degraded limiter degrades the attachments capability, and only
   * `enforce + required` (`blocksAttachments`) makes the capability not-ready.
   */
  readonly rateLimit?: { readonly status: 'healthy' | 'degraded'; readonly blocksAttachments: boolean };
  /**
   * P4A-P10 PostgreSQL necessary-dependency fact: `degraded` fails the
   * capability closed (the ledger is the authority for every attachments
   * fact). Absent = not_reported (legacy behavior unchanged).
   */
  readonly database?: { readonly status: 'healthy' | 'degraded' };
  /**
   * P4A-P10 object store / R2 necessary-dependency fact: `degraded` fails
   * the capability closed (blobs live in R2; without the store the
   * capability cannot upload, verify or deliver). Absent = not_reported.
   */
  readonly objectStore?: { readonly status: 'healthy' | 'degraded' };
}

function workerStatus(facts: AttachmentsReadinessFacts['worker']): AttachmentsComponentStatus & { readonly verificationBacklog: number; readonly cleanupBacklog: number } {
  if (!facts) {
    return { status: 'ready', reason: 'not_reported', verificationBacklog: 0, cleanupBacklog: 0 };
  }
  const verificationBacklog = facts.verificationBacklog ?? 0;
  const cleanupBacklog = facts.cleanupBacklog ?? 0;
  if (verificationBacklog >= ATTACHMENTS_WORKER_VERIFICATION_BACKLOG_NOT_READY
    || cleanupBacklog >= ATTACHMENTS_WORKER_CLEANUP_BACKLOG_NOT_READY) {
    return { status: 'not-ready', reason: 'backlog_exceeded', verificationBacklog, cleanupBacklog };
  }
  if (verificationBacklog >= ATTACHMENTS_WORKER_VERIFICATION_BACKLOG_DEGRADED
    || cleanupBacklog >= ATTACHMENTS_WORKER_CLEANUP_BACKLOG_DEGRADED) {
    return { status: 'degraded', reason: 'backlog_elevated', verificationBacklog, cleanupBacklog };
  }
  return { status: 'ready', reason: 'none', verificationBacklog, cleanupBacklog };
}

export function evaluateAttachmentsCapabilityReadiness(
  config: AttachmentsFeatureConfig | undefined,
  facts?: AttachmentsReadinessFacts,
): AttachmentsCapabilityReadiness {
  if (config === undefined) {
    return Object.freeze({ capability: 'attachments', status: 'disabled', reason: 'not_enabled' });
  }
  if (facts === undefined) {
    // Legacy I05 path: enabled + validly configured -> ready. Real dependency
    // probing belongs to the facts providers (I06+/I15 gauges).
    return Object.freeze({ capability: 'attachments', status: 'ready', reason: 'none' });
  }

  const api: AttachmentsComponentStatus = facts.admission === undefined
    ? { status: 'ready', reason: 'not_reported' }
    : facts.admission.enabled
      ? { status: 'ready', reason: 'none' }
      : { status: 'degraded', reason: 'admission_stopped' };
  const worker = workerStatus(facts.worker);
  const delivery: AttachmentsComponentStatus = facts.delivery === undefined
    ? { status: 'ready', reason: 'not_reported' }
    : facts.delivery.hostAvailable
      ? { status: 'ready', reason: 'none' }
      : { status: 'not-ready', reason: 'delivery_host_unavailable' };

  let status: AttachmentsCapabilityStatus = 'ready';
  let reason: AttachmentsCapabilityReason = 'none';
  if (worker.status === 'not-ready' || delivery.status === 'not-ready') {
    status = 'not-ready';
    reason = worker.status === 'not-ready' ? 'worker_unavailable' : 'delivery_unavailable';
  } else if (worker.status === 'degraded' || api.status === 'degraded' || delivery.status === 'degraded') {
    status = 'degraded';
    reason = worker.status === 'degraded' ? 'worker_degraded' : 'admission_stopped';
  }

  // P4A-RL04 (plan §13.1 step 3/4): the rate-limit fact only ever degrades
  // or blocks, never upgrades an already worse verdict. `enforce + required`
  // with a degraded store blocks the attachments capability (not-ready);
  // shadow / optional enforce degrade without blocking.
  if (facts.rateLimit !== undefined) {
    if (facts.rateLimit.blocksAttachments) {
      status = 'not-ready';
      reason = 'dependency_unavailable';
    } else if (facts.rateLimit.status === 'degraded' && status !== 'not-ready') {
      status = 'degraded';
      reason = 'dependency_unavailable';
    }
  }

  // P4A-P10: PostgreSQL and R2 are NECESSARY dependencies — degradation
  // fails the capability closed while the API component stays ready (partial
  // failure never drags the global API down). Same monotonic rule as the
  // rate-limit fact: never upgrade an already worse verdict.
  if (facts.database !== undefined && facts.database.status === 'degraded') {
    status = 'not-ready';
    reason = 'dependency_unavailable';
  }
  if (facts.objectStore !== undefined && facts.objectStore.status === 'degraded') {
    status = 'not-ready';
    reason = 'dependency_unavailable';
  }

  return Object.freeze({
    capability: 'attachments',
    status,
    reason,
    components: Object.freeze({
      api,
      worker: Object.freeze(worker),
      delivery: Object.freeze(facts.delivery === undefined
        ? delivery
        : { ...delivery, hostAvailable: facts.delivery.hostAvailable }),
    }),
  });
}