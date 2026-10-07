import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { AliyunDirectMailAdapter } from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  parseEmailSkinConfig,
} from '../../../src/infrastructure/email/message-skins.js';
import { UNIFIED_EMAIL_SKIN } from '../../../src/infrastructure/email/unified-email-chrome.js';
import {
  loadEmailEntryReplayManifest,
  startEmailEntryFixture,
  type StartedEmailEntryFixture,
} from '../../../scripts/evidence/phase5-email-entry-fixture.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresEmailDeliveryWorkerRepository,
  createPostgresNotificationOperationsRepository,
  createEmailDeliveryWorkerRuntime,
  EmailDeliveryWorkerLoop,
  type EmailDeliveryWorkerRuntime } from '../../../src/infrastructure/notifications/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import { createEmailDeliveryRetryPolicy,
  evaluateNotificationCapabilityReadiness,
  type EmailCallbackFact,
  type EmailCallbackReconcilerRepository,
  type EmailCallbackVerificationInput,
  type EmailDeliveryWorkerRepository,
  type EmailLookupResult,
  type EmailMessage,
  type EmailProviderAdapter,
  type EmailTemplateRenderers } from '../../../src/modules/notifications/index.js';

const CALLBACK_SECRET = `p529_callback_${'s'.repeat(8)}`;
const TAG_PREFIX = 'p527-delivery-';

describeWithPostgres('P5-29 production email delivery worker lifecycle', () => {
  const RECIPIENT = 'EREREREREREREREREREREQ';
  const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
  const COLLECTION = 'FBQUFBQUFBQUFBQUFBQUFA';
  let isolated!: IsolatedPostgresRuntime;
  let fixture!: StartedEmailEntryFixture;
  let manifest!: ReturnType<typeof loadEmailEntryReplayManifest>;
  let metrics!: InMemoryMetrics;
  let emailLoop!: NonNullable<ReturnType<typeof buildWorker>['emailDelivery']>['loop'];
  let reconcileCallback!: NonNullable<ReturnType<typeof buildWorker>['emailDelivery']>['reconcileCallback'];
  let outbox!: NonNullable<ReturnType<typeof buildWorker>['outbox']>;
  let provider!: AliyunDirectMailAdapter;
  let logs: Array<{ level: string; bindings: unknown; message: string }>;
  let config!: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_email_worker',
      { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, RECIPIENT, ACTOR, COLLECTION);
    await isolated.runtime.pool.query(
      `update accounts set email='p527-recipient@example.invalid' where id=$1`, [RECIPIENT]);
    manifest = loadEmailEntryReplayManifest();
    fixture = await startEmailEntryFixture({
      accessKeyId: manifest.fixedInputs.accessKeyId,
      signingKeyMaterial: manifest.fixedInputs.signingKeyMaterial,
      sender: manifest.fixedInputs.sender,
      recipient: manifest.fixedInputs.recipient,
      timeoutDelayMs: 5_000,
    });
    provider = new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
      callbackHmacSecret: CALLBACK_SECRET,
    });
    logs = [];
    metrics = new InMemoryMetrics();
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      KNOWN_FEATURE_EMAIL: 'true',
      EMAIL_DM_ACCOUNT_NAME: manifest.fixedInputs.sender,
      EMAIL_DM_ENDPOINT: fixture.origin,
      EMAIL_DM_TIMEOUT_MS: '700',
      EMAIL_DM_TAG_PREFIX: TAG_PREFIX,
      EMAIL_DM_MAX_TAG_CHARS: '128',
      EMAIL_DM_CALLBACK_HMAC_SECRET: CALLBACK_SECRET,
      EMAIL_DELIVERY_MAX_ATTEMPTS: '3',
      EMAIL_DELIVERY_BASE_BACKOFF_MS: '1000',
      EMAIL_DELIVERY_MAX_BACKOFF_MS: '1000',
      EMAIL_DELIVERY_POLL_INTERVAL_MS: '100',
      EMAIL_DELIVERY_LEASE_DURATION_MS: '2000',
      EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '200',
      EMAIL_DELIVERY_BATCH_SIZE: '4',
      WORKER_CONCURRENCY: '2',
      WORKER_BATCH_SIZE: '2',
      WORKER_POLL_INTERVAL_MS: '5',
      WORKER_LEASE_DURATION_MS: '500',
      WORKER_HEARTBEAT_INTERVAL_MS: '100',
      WORKER_HANDLER_TIMEOUT_MS: '450',
      FEED_REBUILD_TIMEOUT_MS: '400',
      NOTIFICATION_RECOVERY_TIMEOUT_MS: '400',
    });
    const runtime = buildWorker(config, isolated.runtime, metrics, {
      emailDelivery: { provider },
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
    });
    assert.ok(runtime.emailDelivery, 'email worker must be composed when the feature is enabled');
    assert.ok(runtime.outbox);
    emailLoop = runtime.emailDelivery.loop;
    reconcileCallback = runtime.emailDelivery.reconcileCallback;
    outbox = runtime.outbox;
  }, 120_000);

  afterAll(async () => {
    await provider.close().catch(() => undefined);
    await fixture?.close();
    await isolated?.close();
  });

  async function setPreference(channel: 'in_app' | 'email', enabled: boolean): Promise<void> {
    await isolated.runtime.pool.query(`insert into notification_preferences(
      recipient_account_id,channel,enabled) values($1,$2,$3)
      on conflict(recipient_account_id,channel) do update set enabled=excluded.enabled,
      state_revision=notification_preferences.state_revision+1,updated_at=current_timestamp`,
    [RECIPIENT, channel, enabled]);
  }

  async function seedNotification(deliveryId: string,
    notificationType: 'follow_activity' | 'collection_change',
    options: { readonly subjectType?: 'profile' | 'collection'; readonly subjectId?: string;
      readonly providerMessageId?: string } = {}): Promise<string> {
    const notificationId = `p529-notification-${deliveryId}`;
    const subjectType = options.subjectType ?? (notificationType === 'follow_activity' ? 'profile' : 'collection');
    const subjectId = options.subjectId ?? (subjectType === 'collection' ? COLLECTION : ACTOR);
    await isolated.runtime.pool.query(`insert into notifications(notification_id,
        recipient_account_id,source_event_id,notification_type,actor_profile_id,
        subject_type,subject_id,occurred_at,retain_until)
      values($1,$2,$3,$4,$5,$6,$7,current_timestamp,
        current_timestamp + interval '365 days')
      on conflict(recipient_account_id,source_event_id,notification_type) do nothing`, [
      notificationId, RECIPIENT, `p529-event-${deliveryId}`, notificationType, ACTOR,
      subjectType, subjectId,
    ]);
    // provider_message_id may be seeded at INSERT time (the transition guard
    // only constrains state/attempt_count/state_revision/last_error_category
    // on insert), so an FblReport message_id can pre-exist on a pending row
    // exactly like a provider-stored id would.
    await isolated.runtime.pool.query(`insert into notification_deliveries(delivery_id,
        notification_id,recipient_account_id,channel,provider_message_id)
      values($1,$2,$3,'email',$4)
      on conflict(notification_id,channel) do nothing`,
    [deliveryId, notificationId, RECIPIENT, options.providerMessageId ?? null]);
    return notificationId;
  }

  async function deliveryRow(deliveryId: string) {
    return (await isolated.runtime.pool.query<{ state: string; attempt_count: number;
      provider_message_id: string | null; last_error_category: string | null;
      next_attempt_at: Date; delivered_at: Date | null; suppressed_at: Date | null;
      dead_lettered_at: Date | null }>(
      `select state,attempt_count,provider_message_id,last_error_category,next_attempt_at,
        delivered_at,suppressed_at,dead_lettered_at from notification_deliveries where delivery_id=$1`,
      [deliveryId])).rows[0];
  }

  async function notificationCount(notificationId: string): Promise<number> {
    return Number((await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text count
      from notifications where notification_id=$1`, [notificationId])).rows[0]?.count ?? 0);
  }

  async function suppressionFact(recipient: string) {
    return (await isolated.runtime.pool.query<{ source: string; occurred_at: Date }>(`select source,
      occurred_at from notification_email_suppressions where recipient_account_id=$1`,
    [recipient])).rows[0] ?? null;
  }

  async function appendFollow(outboxId: string, eventId: string,
    occurredAt: Date): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values($1,'social-domain-event'),($2,'social-outbox') on conflict do nothing`,
    [eventId, outboxId]);
    await isolated.runtime.pool.query(`insert into outbox_events(outbox_id,domain_event_id,
      event_type,event_version,handler_name,handler_mode,aggregate_type,aggregate_id,
      aggregate_scope,aggregate_revision,commit_ordinal,occurred_at,payload_json,state,
      attempt_count,available_at,lease_generation)
      values($1,$2,'social.follow-created',1,'social_follow_activity','delivery_each_event',
        'profile-follow',$3,$4,null,null,$5,$6,'pending',0,current_timestamp,0)`,
    [outboxId, eventId, ACTOR, RECIPIENT, occurredAt,
      { actorProfileId: ACTOR, targetProfileId: RECIPIENT }]);
  }

  async function ensureFollowAuthorityOccurredAt(): Promise<Date> {
    await isolated.runtime.pool.query(
      `delete from follows where actor_profile_id=$1 and target_profile_id=$2`,
      [ACTOR, RECIPIENT]);
    const followedAt = (await isolated.runtime.pool.query<{ followed_at: Date }>(`
      insert into follows(actor_profile_id,target_profile_id,followed_at)
        values($1,$2, date_trunc('milliseconds', current_timestamp) - interval '60 seconds')
      returning followed_at`, [ACTOR, RECIPIENT])).rows[0]!.followed_at;
    await setPreference('in_app', true);
    await setPreference('email', true);
    return new Date(followedAt.getTime() + 1_000);
  }

  async function forceOutboxReady(): Promise<void> {
    await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp
      where state='retryable'`);
  }

  async function drainOutbox(limit = 100): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      await forceOutboxReady();
      if (!await outbox.runOnce()) return;
    }
    throw new Error('P5-29 outbox drain exceeded its bounded test budget');
  }

  async function drainEmail(limit = 80): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      if (!await emailLoop.runOnce()) return;
    }
    throw new Error('P5-29 email worker drain exceeded its bounded test budget');
  }

  async function verifiedFact(eventId: string): Promise<EmailCallbackFact> {
    const raw = await fixture.readText(`/__fixture/events/${eventId}`);
    assert.equal(raw.status, 200);
    const body = raw.bodyText;
    const timestamp = new Date().toISOString();
    const nonce = `p529-nonce-${eventId}-${Math.random().toString(36).slice(2)}`;
    const signature = createHmac('sha256', CALLBACK_SECRET)
      .update(`${body}\n${timestamp}\n${nonce}`).digest('base64');
    return provider.verifyCallback({
      method: 'POST', url: 'https://dm.example/events',
      headers: {
        'x-known-dm-signature': signature,
        'x-known-dm-timestamp': timestamp,
        'x-known-dm-nonce': nonce,
        'content-type': 'application/json',
      },
      body,
    });
  }

  // ---------------------------------------------------------------------------
  // m3 controllable provider seam: delegates to the REAL P5-28 adapter but can
  // pause (a) the retry LOOKUP before it returns - the window between the
  // claim-time suppression recheck and the pre-send recheck - and (b) the SEND
  // after the provider accepted it (before the terminal write).
  // ---------------------------------------------------------------------------
  const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  };

  class ControlledProvider implements EmailProviderAdapter {
    readonly lookedUp: string[] = [];
    readonly sent: string[] = [];
    readonly lookupRequested = deferred();
    readonly sendAccepted = deferred();
    readonly releaseLookup = deferred();
    readonly releaseSend = deferred();

    constructor(private readonly delegate: AliyunDirectMailAdapter,
      private readonly pause: { readonly lookup?: boolean; readonly sendAfterAccept?: boolean }) {}

    async lookup(input: { idempotencyKey: string }) {
      this.lookedUp.push(input.idempotencyKey);
      this.lookupRequested.release();
      if (this.pause.lookup) await this.releaseLookup.promise;
      return this.delegate.lookup(input);
    }

    async send(input: { idempotencyKey: string; message: EmailMessage; signal?: AbortSignal }) {
      this.sent.push(input.idempotencyKey);
      const result = await this.delegate.send(input);
      this.sendAccepted.release();
      if (this.pause.sendAfterAccept) await this.releaseSend.promise;
      return result;
    }

    verifyCallback(input: EmailCallbackVerificationInput) {
      return this.delegate.verifyCallback(input);
    }

    close() {
      return this.delegate.close();
    }
  }

  /** Email runtime built on the production Postgres repository + a controlled provider. */
  function controlledRuntime(provider: EmailProviderAdapter) {
    return createEmailDeliveryWorkerRuntime({
      repository: createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool),
      provider,
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: createEmailDeliveryRetryPolicy({
        baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 3 }),
      tagPrefix: TAG_PREFIX,
    });
  }

  /**
   * FIX-M-026: bounded loop whose repository/provider/renderers poison one
   * process phase (production Postgres repository + real adapter/renderers by
   * default). Near-zero TEST backoff (1s) keeps the retry hops deterministic
   * without real-timer sleeps beyond the bounded awaitDue poll.
   */
  function poisonLoop(options: {
    readonly repository: EmailDeliveryWorkerRepository & EmailCallbackReconcilerRepository;
    readonly provider?: EmailProviderAdapter;
    readonly renderers?: EmailTemplateRenderers;
  }): EmailDeliveryWorkerLoop {
    return new EmailDeliveryWorkerLoop({
      repository: options.repository,
      provider: options.provider ?? provider,
      renderers: options.renderers,
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: { maxAttempts: 3, backoffMs: () => 1_000 },
    });
  }

  /** FIX-M-026: adapter seam that poisons exactly one of send/lookup and delegates the rest. */
  function providerThrowing(method: 'send' | 'lookup'): EmailProviderAdapter {
    const wrapper: EmailProviderAdapter = {
      ...provider,
      send: async () => { throw new Error(`FIX-M-026 ${method} failure`); },
      lookup: async () => { throw new Error(`FIX-M-026 ${method} failure`); },
      verifyCallback: (input) => provider.verifyCallback(input),
      close: () => provider.close(),
    };
    if (method === 'send') {
      // Restore the REAL lookup: the send-throw phase must still run the retry
      // lookup (unknown -> proceed) so only the provider send itself is poisoned.
      wrapper.lookup = (input) => provider.lookup(input);
    }
    return wrapper;
  }

  /** FIX-L-058: adapter seam that overrides the retry lookup with a fixed error result and delegates the rest. */
  function providerLookupError(lookupResult: EmailLookupResult): EmailProviderAdapter {
    return {
      ...provider,
      lookup: async () => lookupResult,
    };
  }

  /** FIX-L-058: shared near-zero-backoff runtime over the production Postgres repository. */
  function lookupErrorRuntime(repository: EmailDeliveryWorkerRepository,
    lookupResult: EmailLookupResult): EmailDeliveryWorkerRuntime {
    return createEmailDeliveryWorkerRuntime({
      repository,
      provider: providerLookupError(lookupResult),
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: { maxAttempts: 3, backoffMs: () => 1 },
      tagPrefix: TAG_PREFIX,
    });
  }

  /**
   * Wait (bounded) until a delivery's scheduled next_attempt_at falls due (N6).
   * The transition guard forbids raw UPDATEs that would force a retryable row
   * due, so the retry tests either use a near-zero TEST backoff (dedicated
   * runtime) or poll here. The poll is deterministic: it returns as soon as the
   * row is claimable and fails loudly if the deadline is exceeded.
   */
  async function awaitDue(deliveryId: string, timeoutMs = 5_000): Promise<void> {
    await waitForCondition(async () => {
      const row = await deliveryRow(deliveryId);
      return Boolean(row && row.next_attempt_at.getTime() <= Date.now());
    }, {
      timeoutMs,
      pollIntervalMs: 5,
      description: `email delivery ${deliveryId} to become claimable`,
    });
  }

  test('MAIL-01 postgres worker unified skins wrap follow_activity and collection_change html', async () => {
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await setPreference('email', true);
    const captured: EmailMessage[] = [];
    const capturing: EmailProviderAdapter = {
      ...provider,
      send: async (input) => {
        captured.push(input.message);
        return provider.send(input);
      },
      lookup: (input) => provider.lookup(input),
      verifyCallback: (input) => provider.verifyCallback(input),
      close: () => provider.close(),
    };
    const loop = new EmailDeliveryWorkerLoop({
      repository: createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool),
      provider: capturing,
      emailSkins: parseEmailSkinConfig({
        EMAIL_SKIN_FOLLOW_ACTIVITY: 'unified',
        EMAIL_SKIN_COLLECTION_CHANGE: 'unified',
      }),
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: { maxAttempts: 3, backoffMs: () => 1_000 },
    });
    await seedNotification('mail01-unified-follow', 'follow_activity');
    await seedNotification('mail01-unified-collection', 'collection_change');
    assert.equal(await loop.runOnce(), true);
    if (captured.length < 2) {
      assert.equal(await loop.runOnce(), true);
    }
    assert.equal(captured.length, 2);
    for (const message of captured) {
      assert.match(message.htmlBody ?? '', new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
      assert.doesNotMatch(message.htmlBody ?? '', /unsubscribe/iu);
    }
    assert.equal((await deliveryRow('mail01-unified-follow')).state, 'delivered');
    assert.equal((await deliveryRow('mail01-unified-collection')).state, 'delivered');
  }, 30_000);

  test('MAIL-01 postgres worker explicit purpose opt-out keeps today inner html (no unified marker)', async () => {
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await setPreference('email', true);
    const captured: EmailMessage[] = [];
    const capturing: EmailProviderAdapter = {
      ...provider,
      send: async (input) => {
        captured.push(input.message);
        return provider.send(input);
      },
      lookup: (input) => provider.lookup(input),
      verifyCallback: (input) => provider.verifyCallback(input),
      close: () => provider.close(),
    };
    const loop = new EmailDeliveryWorkerLoop({
      repository: createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool),
      provider: capturing,
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: { maxAttempts: 3, backoffMs: () => 1_000 },
      // R7-31: the default skin is unified now; this case pins the opt-out.
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_DEFAULT: 'purpose' }),
    });
    await seedNotification('mail01-purpose-follow', 'follow_activity');
    assert.equal(await loop.runOnce(), true);
    assert.equal(captured.length, 1);
    assert.doesNotMatch(captured[0]?.htmlBody ?? '', /data-known-email-skin/u);
    assert.match(captured[0]?.htmlBody ?? '', /followed your work\./u);
    assert.equal((await deliveryRow('mail01-purpose-follow')).state, 'delivered');
  }, 30_000);
});
