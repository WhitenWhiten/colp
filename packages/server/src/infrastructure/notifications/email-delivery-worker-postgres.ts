import type { Pool } from 'pg';
import {
  createEmailDeliveryRetryPolicy,
  createEmailTemplateRenderers,
  decideEmailProcessingFailure,
  processEmailDeliveryClaim,
  reconcileEmailCallback,
  type EmailCallbackDeliveryRow,
  type EmailCallbackReconcilerRepository,
  type EmailCallbackFact,
  type EmailCallbackReconciliationResult,
  type EmailDeliveryAttempt,
  type EmailDeliveryAttemptFence,
  type EmailDeliveryClaim,
  type EmailDeliveryRetryPolicy,
  type EmailDeliveryWorkerRepository,
  type EmailProviderAdapter,
  type EmailSuppressionFacts,
  type EmailSuppressionSource,
  type EmailTemplateContext,
  type EmailTemplateNotificationType,
  type EmailTemplateRenderers,
} from '../../modules/notifications/index.js';
import { redactSensitiveText, type Metrics } from '../telemetry/index.js';
import {
  defaultEmailSkinMap,
  wrapEmailTemplateRenderers,
  type EmailSkinMap,
} from '../email/message-skins.js';

interface EmailDeliveryClaimRow {
  delivery_id: string; notification_id: string; recipient_account_id: string;
  attempt_count: number;
}
interface EmailDeliveryAttemptRow {
  delivery_id: string; notification_id: string; recipient_account_id: string;
  state: EmailDeliveryAttempt['state']; attempt_count: number; state_revision: string;
  next_attempt_at: Date; leased_until: Date | null;
  last_error_category: EmailDeliveryAttempt['lastErrorCategory'];
  provider_message_id: string | null;
}
interface EmailCallbackDeliveryRowDb {
  delivery_id: string; notification_id: string; recipient_account_id: string;
  state: 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';
  attempt_count: number; state_revision: string;
  leased_until: Date | null;
}

/**
 * P5-29 production email delivery repository/loop.
 *
 * Consumes ONLY `notification_deliveries` rows with `channel='email'`. Every
 * mutation is a CAS fenced on the claimed attempt so an old lease owner can
 * never overwrite a newer attempt or suppression state:
 * - claim: pending|retryable due rows, or EXPIRED leased rows (lease takeover);
 *   every claim clears `last_error_category` (m1) so a retried attempt never
 *   carries the previous failure's stale category while in flight;
 * - final transitions: `state='leased' AND leased_until > now AND
 *   attempt_count=<claimed>`.
 * - bounded failure (FIX-M-026): an unclassified process-phase exception
 *   (repository/renderer/adapter throw) is mapped to the stable `other`
 *   category and written through the same attempt-fenced `failDelivery` -
 *   retryable+backoff below maxAttempts, dead_letter retry_exhausted at/above
 *   it - so a poisoned delivery can never churn lease takeovers with an
 *   unbounded attempt_count (dead_letter rows are never claimed again).
 *   heartbeat/lease_lost is classified separately: a claim whose lease was
 *   lost is reported lease_lost and NEVER written by the old owner.
 * - `last_error_category` state semantics (m1): NULL on pending/leased/delivered/
 *   suppressed; the last failure category only on retryable/dead_letter. All
 *   suppression paths clear it, `completeDelivery` clears it, the dead_letter ->
 *   retryable re-arm KEEPS it (the P5-25/29 guard requires the same category on
 *   that transition), the retryable -> delivered callback finalization clears it
 *   (delivered is terminal error-free), and the next claim clears it again.
 */
export function createPostgresEmailDeliveryWorkerRepository(
  pool: Pool,
): EmailDeliveryWorkerRepository & EmailCallbackReconcilerRepository {
  return Object.freeze({
    async claimDue(input: { readonly limit: number; readonly leaseDurationMs: number })
    : Promise<readonly EmailDeliveryClaim[]> {
      // Both branches have matching ordered indexes (pending: migration 202610080000).
      // Only their bounded union needs the final due-time sort. The lock needs the
      // join: `skip locked` is illegal on a UNION arm and INERT on a set-operation
      // subquery, so a held row blocks the claim. `order by due.due_at` keeps expired
      // leases from starving behind pending rows.
      const result = await pool.query<EmailDeliveryClaimRow>(`with due as (
          (select delivery_id, next_attempt_at as due_at from notification_deliveries
             where channel='email' and state in ('pending','retryable')
               and next_attempt_at <= current_timestamp
             order by next_attempt_at, delivery_id limit $1)
          union all
          (select delivery_id, leased_until as due_at from notification_deliveries
             where channel='email' and state='leased' and leased_until <= current_timestamp
             order by leased_until, delivery_id limit $1)
        ), candidates as (
          select delivery.delivery_id from notification_deliveries delivery
          join due on due.delivery_id = delivery.delivery_id
          order by due.due_at, delivery.delivery_id
          for update of delivery skip locked
          limit $1)
        update notification_deliveries delivery
        set state='leased', attempt_count=attempt_count+1, state_revision=state_revision+1,
            leased_until=current_timestamp + ($2 * interval '1 millisecond'),
            last_error_category=null,
            updated_at=current_timestamp
        from candidates
        where delivery.delivery_id=candidates.delivery_id and delivery.channel='email'
          and ((delivery.state in ('pending','retryable')
                and delivery.next_attempt_at <= current_timestamp)
            or (delivery.state='leased' and delivery.leased_until <= current_timestamp))
        returning delivery.delivery_id, delivery.notification_id,
          delivery.recipient_account_id, delivery.attempt_count`,
      [input.limit, input.leaseDurationMs]);
      return Object.freeze(result.rows.map((row) => Object.freeze({
        deliveryId: row.delivery_id, notificationId: row.notification_id,
        recipientAccountId: row.recipient_account_id, attemptCount: row.attempt_count })));
    },

    async heartbeat(fence: EmailDeliveryAttemptFence, leaseDurationMs: number): Promise<boolean> {
      // Every update must bump state_revision, and the leased->leased branch needs
      // the same attempt_count with a longer leased_until; the CAS predicate
      // preserves the fence (P5-29).
      const result = await pool.query(`update notification_deliveries
        set leased_until=current_timestamp + ($3 * interval '1 millisecond'),
          state_revision=state_revision+1,
          updated_at=current_timestamp
        where delivery_id=$1 and channel='email' and state='leased' and attempt_count=$2
          and leased_until > current_timestamp`,
      [fence.deliveryId, fence.attemptCount, leaseDurationMs]);
      if (result.rowCount === 1) return true;
      // A heartbeat that races this attempt's own failDelivery/completeDelivery
      // sees state already off 'leased'. That is not a competing owner; treating
      // it as loss would abort a finished send and flake the timeout-retry suite
      // under CI scheduling jitter.
      const peek = await pool.query<{ state: string; attempt_count: number }>(
        `select state, attempt_count from notification_deliveries
         where delivery_id=$1 and channel='email'`,
        [fence.deliveryId]);
      const row = peek.rows[0];
      return row !== undefined
        && row.attempt_count === fence.attemptCount
        && row.state !== 'leased';
    },

    async loadAttempt(fence: EmailDeliveryAttemptFence): Promise<EmailDeliveryAttempt | null> {
      const result = await pool.query<EmailDeliveryAttemptRow>(`select delivery_id, notification_id,
          recipient_account_id, state, attempt_count, state_revision::text, next_attempt_at,
          leased_until, last_error_category, provider_message_id
        from notification_deliveries
        where delivery_id=$1 and channel='email' and state='leased' and attempt_count=$2
          and leased_until > current_timestamp`,
      [fence.deliveryId, fence.attemptCount]);
      const row = result.rows[0];
      return row ? Object.freeze({ deliveryId: row.delivery_id,
        notificationId: row.notification_id, recipientAccountId: row.recipient_account_id,
        state: row.state, attemptCount: row.attempt_count, stateRevision: row.state_revision,
        nextAttemptAt: row.next_attempt_at, leasedUntil: row.leased_until,
        lastErrorCategory: row.last_error_category, providerMessageId: row.provider_message_id })
        : null;
    },

    async readSuppressionFacts(recipientAccountId: string): Promise<EmailSuppressionFacts> {
      const [preference, account, suppression] = await Promise.all([
        pool.query<{ enabled: boolean }>(`select enabled from notification_preferences
          where recipient_account_id=$1 and channel='email'`, [recipientAccountId]),
        pool.query<{ status: string; deleted_at: Date | null; email: string | null }>(`select status,
          deleted_at, email from accounts where id=$1`, [recipientAccountId]),
        pool.query<{ source: EmailSuppressionSource }>(`select source
          from notification_email_suppressions where recipient_account_id=$1`,
        [recipientAccountId]),
      ]);
      const accountRow = account.rows[0];
      return Object.freeze({
        accountActive: accountRow?.status === 'active' && accountRow.deleted_at === null,
        emailEnabled: preference.rows[0]?.enabled === true,
        accountEmail: accountRow?.email ?? null,
        suppression: suppression.rows[0]?.source ?? null,
      });
    },

    async loadTemplateContext(notificationId: string): Promise<EmailTemplateContext | null> {
      const result = await pool.query<{ notification_type: EmailTemplateNotificationType;
        actor_name: string | null; collection_title: string | null; occurred_at: Date }>(`
        select notification.notification_type,
          nullif(actor_profile.display_name,'') actor_name,
          collection.title collection_title,
          notification.occurred_at
        from notifications notification
        left join profiles actor_profile on actor_profile.account_id=notification.actor_profile_id
        left join collections collection on collection.id=notification.subject_id
        where notification.notification_id=$1`, [notificationId]);
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({ notificationType: row.notification_type,
        actorName: row.actor_name ?? null, collectionTitle: row.collection_title ?? null,
        occurredAt: row.occurred_at });
    },

    async recordSuppressionFact(recipientAccountId: string, source: EmailSuppressionSource,
      occurredAt: Date): Promise<void> {
      // FIX-L-062: the upsert is MONOTONIC in occurred_at — a fact is only replaced by
      // one that is NOT older, so a late-arriving old fact cannot roll back the current
      // audit fact. Equal-time ties resolve by source precedence (complaint >
      // unsubscribe > bounce), so the survivor is arrival-order independent.
      await pool.query(`insert into notification_email_suppressions(
          recipient_account_id,source,occurred_at)
        values($1,$2,$3)
        on conflict(recipient_account_id) do update
          set source=excluded.source, occurred_at=excluded.occurred_at
          where notification_email_suppressions.occurred_at < excluded.occurred_at
             or (notification_email_suppressions.occurred_at = excluded.occurred_at
                 and (case excluded.source
                        when 'complaint' then 3
                        when 'unsubscribe' then 2
                        when 'bounce' then 1
                      end)
                   >
                   (case notification_email_suppressions.source
                        when 'complaint' then 3
                        when 'unsubscribe' then 2
                        when 'bounce' then 1
                      end))`,
      [recipientAccountId, source, occurredAt]);
    },

    async completeDelivery(fence: EmailDeliveryAttemptFence,
      providerMessageId: string | null): Promise<boolean> {
      const result = await pool.query(`update notification_deliveries
        set state='delivered', state_revision=state_revision+1, leased_until=null,
          delivered_at=current_timestamp, provider_message_id=$3, last_error_category=null,
          updated_at=current_timestamp
        where delivery_id=$1 and channel='email' and state='leased' and attempt_count=$2
          and leased_until > current_timestamp`,
      [fence.deliveryId, fence.attemptCount, providerMessageId]);
      return result.rowCount === 1;
    },

    async failDelivery(fence: EmailDeliveryAttemptFence, input: {
      readonly nextAttemptAt: Date;
      readonly errorCategory: EmailDeliveryAttempt['lastErrorCategory'];
      readonly deadLetter: boolean;
    }): Promise<boolean> {
      const result = await pool.query(`update notification_deliveries
        set state=$3, state_revision=state_revision+1, leased_until=null,
          next_attempt_at=$4, dead_lettered_at=case when $3='dead_letter'
            then current_timestamp else null end,
          last_error_category=$5, updated_at=current_timestamp
        where delivery_id=$1 and channel='email' and state='leased' and attempt_count=$2
          and leased_until > current_timestamp`,
      [fence.deliveryId, fence.attemptCount, input.deadLetter ? 'dead_letter' : 'retryable',
        input.nextAttemptAt, input.errorCategory]);
      return result.rowCount === 1;
    },

    async suppressDelivery(fence: EmailDeliveryAttemptFence): Promise<boolean> {
      const result = await pool.query(`update notification_deliveries
        set state='suppressed', state_revision=state_revision+1, leased_until=null,
          suppressed_at=current_timestamp, last_error_category=null, updated_at=current_timestamp
        where delivery_id=$1 and channel='email' and state='leased' and attempt_count=$2
          and leased_until > current_timestamp`,
      [fence.deliveryId, fence.attemptCount]);
      return result.rowCount === 1;
    },

    async resolveDeliveryForCallback(input: { readonly providerMessageId?: string;
      readonly deliveryId?: string }): Promise<EmailCallbackDeliveryRow | null> {
      if (input.providerMessageId === undefined && input.deliveryId === undefined) return null;
      // EnvId OR stripped tag: an in-flight delivery has provider_message_id
      // still NULL, so it can only be resolved by the stable tag (delivery_id);
      // a callback that only carries the EnvId resolves by provider_message_id.
      const result = await pool.query<EmailCallbackDeliveryRowDb>(`select delivery_id,
          notification_id, recipient_account_id, state, attempt_count, state_revision::text,
          leased_until
        from notification_deliveries
        where channel='email'
          and (($1::text is not null and provider_message_id=$1)
            or ($2::text is not null and delivery_id=$2))
        order by case when $2::text is not null and delivery_id=$2 then 0 else 1 end
        limit 1`, [input.providerMessageId ?? null, input.deliveryId ?? null]);
      const row = result.rows[0];
      return row ? Object.freeze({ deliveryId: row.delivery_id,
        notificationId: row.notification_id, recipientAccountId: row.recipient_account_id,
        state: row.state, attemptCount: row.attempt_count, stateRevision: row.state_revision,
        leasedUntil: row.leased_until }) : null;
    },

    /** Email -> account resolution (P5-29): the FblReport block_email and the
     *  deliver/unsubscribe rcpt both arrive here as the verified fact
     *  recipient. Returns the matching accounts.id or null (never the email). */
    async resolveSuppressionRecipient(recipientEmail: string): Promise<string | null> {
      const result = await pool.query<{ id: string }>(`select id from accounts
        where email=$1 order by id limit 1`, [recipientEmail]);
      return result.rows[0]?.id ?? null;
    },

    async applyCallbackTransition(input: {
      readonly deliveryId: string;
      readonly expectedState: 'leased' | 'pending' | 'retryable' | 'dead_letter';
      readonly expectedStateRevision: string;
      readonly expectedAttemptCount: number;
      readonly nextState: 'delivered' | 'suppressed' | 'retryable';
      readonly providerMessageId?: string | null;
      readonly nextAttemptAt?: Date;
    }): Promise<boolean> {
      if (input.expectedState === 'leased') {
        // Active lease only: an expired lease belongs to a newer attempt.
        const result = await pool.query(`update notification_deliveries
          set state=$3, state_revision=state_revision+1, leased_until=null,
            delivered_at=case when $3='delivered' then current_timestamp else null end,
            suppressed_at=case when $3='suppressed' then current_timestamp else null end,
            dead_lettered_at=null, next_attempt_at=current_timestamp,
            provider_message_id=coalesce($4, provider_message_id),
            -- suppressed (like delivered) is a terminal error-free state: never retain
            -- a stale failure category on a callback-suppressed row (m1).
            last_error_category=case when $3 in ('delivered','suppressed') then null
              else last_error_category end,
            updated_at=current_timestamp
          where delivery_id=$1 and channel='email' and state='leased' and attempt_count=$2
            and leased_until > current_timestamp and state_revision=$5`,
        [input.deliveryId, input.expectedAttemptCount, input.nextState,
          input.providerMessageId ?? null, input.expectedStateRevision]);
        return result.rowCount === 1;
      }
      if (input.expectedState === 'dead_letter') {
        // Re-arm a dead-lettered delivery and persist the verified callback's provider
        // message id as the delivered marker: the next claim finalizes delivered with no
        // provider call, so lookup lag cannot re-send. The guard keeps it legal (same
        // attempt_count and category, which claimDue clears on the next claim).
        const result = await pool.query(`update notification_deliveries
          set state='retryable', state_revision=state_revision+1, dead_lettered_at=null,
            next_attempt_at=$2, leased_until=null,
            provider_message_id=coalesce($4, provider_message_id), updated_at=current_timestamp
          where delivery_id=$1 and channel='email' and state='dead_letter'
            and state_revision=$3`,
        [input.deliveryId, input.nextAttemptAt ?? new Date(), input.expectedStateRevision,
          input.providerMessageId ?? null]);
        return result.rowCount === 1;
      }
      if (input.expectedState === 'retryable' && input.nextState === 'delivered') {
        // FIX-M-028: a VERIFIED delivered callback on a retryable row finalizes
        // it delivered directly (retryable -> delivered) and persists the
        // callback's provider message id as the delivered-confirmed marker. A
        // retryable row only exists after a provider send/processing attempt
        // (e.g. the send succeeded but the final leased->delivered CAS lost the
        // lease), and the verified callback is authoritative evidence the
        // provider accepted the message: the row is never claimed again, so
        // stats lag/30-day retention can never cause a re-send. delivered is a
        // terminal error-free state: the stale failure category is cleared (m1)
        // and the transition guard requires the cleared category + the same
        // attempt_count (202608220100).
        const result = await pool.query(`update notification_deliveries
          set state='delivered', state_revision=state_revision+1, delivered_at=current_timestamp,
            leased_until=null, dead_lettered_at=null, next_attempt_at=current_timestamp,
            provider_message_id=coalesce($4, provider_message_id), last_error_category=null,
            updated_at=current_timestamp
          where delivery_id=$1 and channel='email' and state='retryable' and attempt_count=$2
            and state_revision=$3`,
        [input.deliveryId, input.expectedAttemptCount, input.expectedStateRevision,
          input.providerMessageId ?? null]);
        return result.rowCount === 1;
      }
      // pending | retryable -> suppressed (a suppression callback on a
      // non-leased row; retryable rows are also suppressed here by design).
      const result = await pool.query(`update notification_deliveries
        set state='suppressed', state_revision=state_revision+1, suppressed_at=current_timestamp,
          leased_until=null, last_error_category=null, updated_at=current_timestamp
        where delivery_id=$1 and channel='email' and state=$2 and state_revision=$3`,
      [input.deliveryId, input.expectedState, input.expectedStateRevision]);
      return result.rowCount === 1;
    },
  });
}

// ---------------------------------------------------------------------------
// Worker loop (production registry integration point).
// ---------------------------------------------------------------------------

export interface EmailDeliveryWorkerLoopLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface EmailDeliveryWorkerLoopOptions {
  readonly repository: EmailDeliveryWorkerRepository & EmailCallbackReconcilerRepository;
  readonly provider: EmailProviderAdapter;
  readonly renderers?: EmailTemplateRenderers;
  readonly retryPolicy?: EmailDeliveryRetryPolicy;
  readonly logger: EmailDeliveryWorkerLoopLogger;
  readonly metrics?: Metrics;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  /** Per-purpose skins; default all `purpose` so inner copy stays pixel-equal. */
  readonly emailSkins?: EmailSkinMap;
}

export class EmailDeliveryWorkerLoop {
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly renderers: EmailTemplateRenderers;
  private readonly retryPolicy: EmailDeliveryRetryPolicy;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resolvePoll: (() => void) | undefined;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: EmailDeliveryWorkerLoopOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 8;
    const inner = options.renderers ?? createEmailTemplateRenderers();
    this.renderers = wrapEmailTemplateRenderers(inner, options.emailSkins ?? defaultEmailSkinMap());
    this.retryPolicy = options.retryPolicy ?? createEmailDeliveryRetryPolicy();
    if (!Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1
      || !Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1
      || this.heartbeatIntervalMs >= this.leaseDurationMs
      || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 64) {
      throw new RangeError('invalid email delivery worker timing configuration');
    }
    this.options.metrics?.gauge('notifications.email_delivery.worker_lease_duration_ms',
      this.leaseDurationMs);
    this.options.metrics?.gauge('notifications.email_delivery.worker_poll_interval_ms',
      this.pollIntervalMs);
    this.options.metrics?.gauge('notifications.email_delivery.worker_batch_size', this.batchSize);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Claim one bounded batch and process it; false when no work is due. */
  async runOnce(): Promise<boolean> {
    const claims = await this.options.repository.claimDue({
      limit: this.batchSize, leaseDurationMs: this.leaseDurationMs });
    if (claims.length === 0) return false;
    this.options.metrics?.increment('notifications.email_delivery.claims', claims.length);
    for (const claim of claims) {
      await this.processClaim(claim);
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.resolvePoll?.();
    this.resolvePoll = undefined;
    for (const controller of this.controllers) {
      controller.abort(new Error('email delivery worker stopping'));
    }
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.metrics?.increment('notifications.email_delivery.poll_error');
        this.options.logger.warn({ error: redactSensitiveText(error) },
          'email delivery poll failed');
      }
      await this.waitForPoll();
    }
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvePoll = resolve;
      this.pollTimer = setTimeout(() => {
        this.resolvePoll = undefined;
        resolve();
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    });
  }

  private async processClaim(claim: EmailDeliveryClaim): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const fence: EmailDeliveryAttemptFence = {
      deliveryId: claim.deliveryId, attemptCount: claim.attemptCount,
    };
    let heartbeatPromise: Promise<void> | undefined;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPromise || leaseLost) return;
      heartbeatPromise = this.options.repository.heartbeat(fence, this.leaseDurationMs)
        .then((renewed) => {
          this.options.metrics?.increment(renewed
            ? 'notifications.email_delivery.heartbeat'
            : 'notifications.email_delivery.heartbeat_lost');
          if (!renewed) {
            leaseLost = true;
            controller.abort(new Error('email delivery lease lost'));
          }
        })
        .catch((error) => {
          this.options.metrics?.increment('notifications.email_delivery.heartbeat_error');
          leaseLost = true;
          controller.abort(error);
        })
        .finally(() => { heartbeatPromise = undefined; });
    }, this.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      const result = await processEmailDeliveryClaim({
        claim,
        repository: this.options.repository,
        provider: this.options.provider,
        renderers: this.renderers,
        retryPolicy: this.retryPolicy,
        signal: controller.signal,
      });
      this.options.metrics?.increment(`notifications.email_delivery.${result.disposition}`);
      if (result.disposition === 'lease_lost') {
        this.options.logger.warn({ deliveryId: claim.deliveryId,
          attemptCount: claim.attemptCount, reason: result.reason }, 'email delivery lease lost');
      } else {
        this.options.logger.info({ deliveryId: claim.deliveryId,
          attemptCount: claim.attemptCount, disposition: result.disposition,
          reason: result.reason,
          ...(result.errorCategory !== null ? { errorCategory: result.errorCategory } : {}) },
        'email delivery processed');
      }
    } catch (error) {
      this.options.metrics?.increment('notifications.email_delivery.error');
      if (leaseLost) {
        // FIX-M-026: heartbeat/lease_lost is classified separately - the old
        // lease owner must never update the row (a newer attempt may already
        // own it, or the lease expired), so no failDelivery write is attempted
        // here; the next claimDue decides the row.
        this.options.metrics?.increment('notifications.email_delivery.lease_lost');
        this.options.logger.warn({ deliveryId: claim.deliveryId,
          attemptCount: claim.attemptCount, reason: 'lease_lost' },
        'email delivery processing failed after lease loss (no stale-owner write)');
      } else {
        // FIX-M-026: every live claim must end in the single attempt-fenced
        // failDelivery: the unclassified exception maps to the stable 'other'
        // category, then retryable+backoff below maxAttempts / dead_letter
        // retry_exhausted at or above it. A refused CAS (newer owner) is
        // reported lease_lost and never retried in the same pass, so
        // attempt_count is bounded by maxAttempts for every live claim.
        const failure = decideEmailProcessingFailure({
          error, attemptCount: claim.attemptCount, retryPolicy: this.retryPolicy,
          now: new Date(),
        });
        const transitioned = await this.options.repository.failDelivery(fence, {
          nextAttemptAt: failure.nextAttemptAt ?? new Date(),
          errorCategory: failure.errorCategory,
          deadLetter: failure.disposition === 'dead_letter',
        });
        const disposition = transitioned ? failure.disposition : 'lease_lost';
        this.options.metrics?.increment(`notifications.email_delivery.${disposition}`);
        this.options.logger.error({ deliveryId: claim.deliveryId,
          attemptCount: claim.attemptCount, disposition,
          errorCategory: failure.errorCategory, error: redactSensitiveText(error) },
        'email delivery processing failed');
      }
    } finally {
      clearInterval(heartbeat);
      await heartbeatPromise;
      this.controllers.delete(controller);
    }
  }
}

/** P5-29 worker surface exposed by the production registry for ops/tests. */
export interface EmailDeliveryWorkerRuntime {
  readonly loop: EmailDeliveryWorkerLoop;
  readonly provider: EmailProviderAdapter;
  /** Ingests an ALREADY VERIFIED P5-28 EmailCallbackFact (idempotent). */
  reconcileCallback(fact: EmailCallbackFact): Promise<EmailCallbackReconciliationResult>;
}

export function createEmailDeliveryWorkerRuntime(options: {
  readonly repository: EmailDeliveryWorkerRepository & EmailCallbackReconcilerRepository;
  readonly provider: EmailProviderAdapter;
  readonly logger: EmailDeliveryWorkerLoopLogger;
  readonly metrics?: Metrics;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly retryPolicy?: EmailDeliveryRetryPolicy;
  readonly tagPrefix: string;
  readonly emailSkins?: EmailSkinMap;
}): EmailDeliveryWorkerRuntime {
  const loop = new EmailDeliveryWorkerLoop({
    repository: options.repository, provider: options.provider, logger: options.logger,
    metrics: options.metrics, leaseDurationMs: options.leaseDurationMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs, pollIntervalMs: options.pollIntervalMs,
    batchSize: options.batchSize, retryPolicy: options.retryPolicy,
    ...(options.emailSkins === undefined ? {} : { emailSkins: options.emailSkins }),
  });
  return Object.freeze({
    loop,
    provider: options.provider,
    reconcileCallback(fact: EmailCallbackFact): Promise<EmailCallbackReconciliationResult> {
      return reconcileEmailCallback({ fact, repository: options.repository,
        tagPrefix: options.tagPrefix });
    },
  });
}
