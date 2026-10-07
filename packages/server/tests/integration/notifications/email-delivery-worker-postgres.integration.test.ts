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

  test('a social event produces a delivery intent the email worker delivers with EnvId via the P5-28 adapter', async () => {
    const followedAt = await ensureFollowAuthorityOccurredAt();
    await appendFollow('p529-follow-outbox-1', 'p529-follow-event-1', followedAt);
    await drainOutbox();
    const intent = (await isolated.runtime.pool.query<{ delivery_id: string; state: string }>(`
      select delivery.delivery_id,delivery.state from notification_deliveries delivery
      join notifications notification on notification.notification_id=delivery.notification_id
      where notification.source_event_id='p529-follow-event-1' and delivery.channel='email'`)).rows[0];
    assert.ok(intent, 'P5-17 must create the email delivery intent');
    assert.equal(intent.state, 'pending');
    await drainEmail();
    const row = await deliveryRow(intent.delivery_id);
    assert.equal(row.state, 'delivered');
    assert.match(row.provider_message_id ?? '', /^env-/u);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}${intent.delivery_id}`), 1);
    const notification = (await isolated.runtime.pool.query<{ notification_id: string }>(
      `select notification_id from notifications where source_event_id='p529-follow-event-1'`)).rows[0];
    assert.ok(notification, 'the in-app Notification authority row must survive email delivery');
    assert.equal((await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text count from notification_deliveries where notification_id=$1
        and state='delivered'`, [notification.notification_id])).rows[0]?.count, '1');
  }, 30_000);



  test('m3: a preference disabled between the suppression recheck and the provider call suppresses with ZERO sends (real race)', async () => {
    await setPreference('email', true);
    await seedNotification('p529-mid-race', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Attempt 1 ends retryable so attempt 2 runs the retry lookup - the
    // controllable provider seam we pause. The lookup sits between the
    // claim-time suppression recheck and the pre-send recheck, so disabling the
    // preference while it is paused deterministically exercises the TOCTOU
    // window that the old test (disable before drain) never reached.
    const claim1 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-mid-race');
    assert.ok(claim1, 'm3 race needs a first claim');
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-mid-race', attemptCount: claim1.attemptCount },
      { nextAttemptAt: new Date(Date.now() - 5_000), errorCategory: 'provider_unavailable',
        deadLetter: false }), true);

    const controlled = new ControlledProvider(provider, { lookup: true });
    const runtime = controlledRuntime(controlled);
    try {
      const runPromise = runtime.loop.runOnce();
      await controlled.lookupRequested.promise; // the retry lookup is now in flight
      await setPreference('email', false); // disable DURING the race window
      controlled.releaseLookup.release();
      await runPromise;
      const row = await deliveryRow('p529-mid-race');
      assert.equal(row.state, 'suppressed',
        'a disable observed before the provider send must suppress the delivery');
      assert.ok(row.suppressed_at, 'suppressed_at must be set');
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-mid-race`), undefined,
        'the mid-race disable must produce ZERO provider sends');
      assert.equal(controlled.sent.length, 0,
        'the worker must never invoke the provider send after the mid-race disable');
      assert.deepEqual(controlled.lookedUp, ['p529-mid-race']);
      assert.equal(await notificationCount('p529-notification-p529-mid-race'), 1);
    } finally {
      controlled.releaseLookup.release();
      await setPreference('email', true);
    }
  }, 30_000);

  test('m3: a preference disabled AFTER the provider accepted the send cannot un-send; the row completes delivered (documented boundary)', async () => {
    await setPreference('email', true);
    await seedNotification('p529-post-accept', 'follow_activity');
    const controlled = new ControlledProvider(provider, { sendAfterAccept: true });
    const runtime = controlledRuntime(controlled);
    try {
      const runPromise = runtime.loop.runOnce();
      await controlled.sendAccepted.promise; // the provider already accepted the message
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-post-accept`), 1,
        'the provider must have accepted exactly one send before the disable');
      await setPreference('email', false); // too late: the email is already in flight
      controlled.releaseSend.release();
      await runPromise;
      const row = await deliveryRow('p529-post-accept');
      assert.equal(row.state, 'delivered',
        'a disable after provider acceptance must not suppress or retry the row');
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-post-accept`), 1,
        'exactly one send; the disable must never cause a duplicate');
    } finally {
      controlled.releaseSend.release();
      await setPreference('email', true);
    }
  }, 30_000);

  test('email preference disabled before the worker runs still suppresses with zero sends (regression baseline)', async () => {
    await setPreference('email', true);
    await seedNotification('p529-race', 'follow_activity');
    await setPreference('email', false);
    await drainEmail();
    const row = await deliveryRow('p529-race');
    assert.equal(row.state, 'suppressed');
    assert.ok(row.suppressed_at, 'suppressed_at must be set');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-race`), undefined,
      'a suppressed delivery must never contact the provider');
    assert.equal(await notificationCount('p529-notification-p529-race'), 1);
    await setPreference('email', true);
  }, 30_000);
  test('a delivered message is terminal: duplicate claims never re-send and a stale owner cannot overwrite', async () => {
    await seedNotification('p529-dupe', 'follow_activity');
    await drainEmail();
    const row = await deliveryRow('p529-dupe');
    assert.equal(row.state, 'delivered');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-dupe`), 1);
    assert.equal(await emailLoop.runOnce(), false, 'no pending/retryable/expired-leased work remains');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-dupe`), 1,
      'a known-delivered message must never be re-sent');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    assert.equal(await repository.completeDelivery(
      { deliveryId: 'p529-dupe', attemptCount: 1 }, 'env-stale'), false,
    'stale owner final transition must be refused');
    assert.equal(await repository.failDelivery({ deliveryId: 'p529-dupe', attemptCount: 1 },
      { nextAttemptAt: new Date(), errorCategory: 'provider_unavailable', deadLetter: false }), false);
  }, 30_000);

  test('lease takeover: competing loops produce a single winner and the stale owner cannot overwrite', async () => {
    await seedNotification('p529-takeover', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Observe the database clock crossing the lease boundary instead of
    // assuming a scheduler delay is enough on every CI host.
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 10 });
    assert.equal(claims.length, 1);
    await waitForCondition(async () => {
      const result = await isolated.runtime.pool.query<{ expired: boolean }>(`
        select leased_until <= current_timestamp as expired
        from notification_deliveries where delivery_id = $1
      `, ['p529-takeover']);
      return result.rows[0]?.expired === true;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 2,
      description: 'the PostgreSQL email-delivery lease to expire',
    });
    const winners = await Promise.all([emailLoop.runOnce(), emailLoop.runOnce()]);
    assert.equal(winners.filter(Boolean).length, 1, 'exactly one competing loop may win the claim');
    const row = await deliveryRow('p529-takeover');
    assert.equal(row.attempt_count, 2);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-takeover`), 1,
      'the takeover winner performs exactly one provider send');
    assert.equal(await repository.completeDelivery(
      { deliveryId: 'p529-takeover', attemptCount: 1 }, 'env-stale'), false,
    'a stale lease owner must never overwrite the newer attempt');
    assert.equal(await repository.heartbeat(
      { deliveryId: 'p529-takeover', attemptCount: 1 }, 60_000), false,
    'a heartbeat for a stolen attempt fence must still report lease loss');
  }, 30_000);

  test('heartbeat extends leased_until against the real PostgreSQL trigger without changing the attempt fence', async () => {
    await seedNotification('p529-heartbeat', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.attemptCount, 1);
    const before = (await isolated.runtime.pool.query<{ attempt_count: number;
      state_revision: string; leased_until: Date }>(`select attempt_count,
        state_revision::text state_revision, leased_until from notification_deliveries
        where delivery_id=$1`, ['p529-heartbeat'])).rows[0]!;
    assert.equal(before.attempt_count, 1, 'the claim must own attempt 1');
    // A real heartbeat against the real trigger: this raises 23514 unless the
    // heartbeat satisfies the guard's leased->leased active-lease branch
    // (same attempt_count, extended leased_until) AND the unconditional
    // state_revision+1 requirement on every update.
    const renewed = await repository.heartbeat(
      { deliveryId: 'p529-heartbeat', attemptCount: 1 }, 120_000);
    assert.equal(renewed, true, 'heartbeat must succeed against the real PostgreSQL trigger');
    const after = (await isolated.runtime.pool.query<{ attempt_count: number;
      state_revision: string; leased_until: Date }>(`select attempt_count,
        state_revision::text state_revision, leased_until from notification_deliveries
        where delivery_id=$1`, ['p529-heartbeat'])).rows[0]!;
    assert.ok(after.leased_until.getTime() > before.leased_until.getTime(),
      'heartbeat must strictly extend leased_until');
    assert.equal(after.attempt_count, before.attempt_count,
      'heartbeat must never bump the attempt fence (lease extension is not a takeover)');
    assert.equal(Number(after.state_revision), Number(before.state_revision) + 1,
      'heartbeat must bump state_revision so the transition guard stays satisfied');
    // The fence survives the heartbeat: the same attempt can still finalize.
    assert.equal(await repository.completeDelivery(
      { deliveryId: 'p529-heartbeat', attemptCount: 1 }, 'env-heartbeat'), true,
    'a heartbeated attempt must still finalize with its original fence');
    assert.equal((await deliveryRow('p529-heartbeat')).state, 'delivered');
    assert.equal(await repository.heartbeat(
      { deliveryId: 'p529-heartbeat', attemptCount: 1 }, 60_000), true,
    'a heartbeat after this attempt already left leased is not lease loss');
  }, 30_000);

  test('unknown outcome retries then dead-letters after max attempts while the Notification stays intact', async () => {
    // The 700ms adapter timeout is longer than the 200ms heartbeat interval, so
    // real heartbeats renew the lease while the send is in flight. Asserting the
    // heartbeat metrics makes the provider_unavailable classification
    // unambiguous: it must come from the adapter timeout, never from a failed
    // heartbeat aborting the in-flight send (which would mask the P5-29
    // heartbeat/trigger defect as a duplicate-email risk).
    //
    // N6: this runtime uses a near-zero TEST backoff (backoffMs -> 1) so every
    // retry is immediately claimable once the previous in-flight send has timed
    // out (700ms per attempt). No real-timer sleeps are needed to out-wait the
    // production 1000ms backoff (the config minimum), and the loop drives the
    // retries manually - determinism comes from the adapter timeout, not sleeps.
    const timeoutMetrics = new InMemoryMetrics();
    const timeoutRuntime = createEmailDeliveryWorkerRuntime({
      repository: createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool),
      provider,
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: timeoutMetrics,
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: { maxAttempts: 3, backoffMs: () => 1 },
      tagPrefix: TAG_PREFIX,
    });
    const heartbeatBefore = timeoutMetrics.get('notifications.email_delivery.heartbeat');
    const heartbeatLostBefore = timeoutMetrics.get('notifications.email_delivery.heartbeat_lost');
    const heartbeatErrorBefore = timeoutMetrics.get('notifications.email_delivery.heartbeat_error');
    await seedNotification('timeout', 'follow_activity');
    const loop = timeoutRuntime.loop;
    await loop.runOnce();
    let row = await deliveryRow('timeout');
    assert.equal(row.state, 'retryable');
    assert.equal(row.last_error_category, 'provider_unavailable');
    assert.ok(timeoutMetrics.get('notifications.email_delivery.heartbeat') > heartbeatBefore,
      'real heartbeats must renew the lease during the in-flight send');
    assert.equal(timeoutMetrics.get('notifications.email_delivery.heartbeat_error'), heartbeatErrorBefore,
      'no heartbeat may raise 23514 against the real trigger');
    assert.equal(timeoutMetrics.get('notifications.email_delivery.heartbeat_lost'), heartbeatLostBefore,
      'no heartbeat may observe lease loss');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}timeout`), 1);
    await loop.runOnce();
    row = await deliveryRow('timeout');
    assert.equal(row.state, 'retryable');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}timeout`), 2);
    await loop.runOnce();
    row = await deliveryRow('timeout');
    assert.equal(row.state, 'dead_letter');
    assert.equal(row.last_error_category, 'retry_exhausted');
    assert.equal(row.attempt_count, 3);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}timeout`), 3);
    assert.equal(timeoutMetrics.get('notifications.email_delivery.heartbeat_error'), heartbeatErrorBefore,
      'no heartbeat may raise 23514 across any retry attempt');
    assert.equal(timeoutMetrics.get('notifications.email_delivery.heartbeat_lost'), heartbeatLostBefore,
      'no heartbeat may observe lease loss across any retry attempt');
    assert.equal(await notificationCount('p529-notification-timeout'), 1,
      'email failure must never break the in-app Notification');
  }, 60_000);


  test('provider outage dead-letters after max attempts and the in-app Notification remains ready', async () => {
    const outageProvider = new AliyunDirectMailAdapter({
      endpoint: 'https://127.0.0.1:1',
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 500,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
    });
    // N6: near-zero TEST backoff so every retry is immediately claimable once
    // the previous in-flight send has timed out (500ms per attempt); no
    // real-timer sleeps are needed to out-wait the production backoff.
    const outageRuntime = createEmailDeliveryWorkerRuntime({
      repository: createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool),
      provider: outageProvider,
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
    await seedNotification('p529-outage', 'follow_activity');
    const outageLoop = outageRuntime.loop;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await outageLoop.runOnce();
    }
    await outageLoop.runOnce();
    const row = await deliveryRow('p529-outage');
    assert.equal(row.state, 'dead_letter');
    assert.equal(row.last_error_category, 'retry_exhausted');
    assert.equal(await notificationCount('p529-notification-p529-outage'), 1);
    const readiness = evaluateNotificationCapabilityReadiness(
      await createPostgresNotificationOperationsRepository(isolated.runtime.pool).inspectStatus(),
      config.notifications!.operations, { enabled: true });
    assert.equal(readiness.inApp.status, 'ready', 'email outage must not make in-app Notifications not-ready');
    assert.equal(readiness.optionalDelivery.status, 'degraded');
    await outageProvider.close().catch(() => undefined);
  }, 60_000);


  test('bounce callback suppresses the delivery, records a durable fact and blocks future sends', async () => {
    await seedNotification('bounce', 'follow_activity');
    const fact = await verifiedFact('deliver-bounce');
    assert.equal(fact.kind, 'bounced');
    const first = await reconcileCallback(fact);
    assert.equal(first.disposition, 'suppressed');
    assert.equal(first.deliveryTransitioned, true);
    assert.equal(first.suppressionRecorded, true);
    assert.equal((await deliveryRow('bounce')).state, 'suppressed');
    const factRow = await suppressionFact(RECIPIENT);
    assert.equal(factRow?.source, 'bounce');
    assert.ok(factRow?.occurred_at instanceof Date);
    const replay = await reconcileCallback(fact);
    assert.equal(replay.deliveryTransitioned, false, 'callback replay must be idempotent');
    await seedNotification('p529-after-bounce', 'follow_activity');
    await drainEmail();
    assert.equal((await deliveryRow('p529-after-bounce')).state, 'suppressed');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-after-bounce`), undefined);
    // N7: per-test cleanup - this test's durable fact must not leak to other tests.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
  }, 30_000);

  test('complaint and unsubscribe callbacks durably suppress the recipient for future deliveries', async () => {
    // The REAL classifier + adapter verifier map FblReport's block_email /
    // message_id / block_time into the verified fact end-to-end; nothing is
    // injected by the test (anti-self-deception: the production ingress does
    // the enrichment, so the test must not).
    const complaint = await verifiedFact('fbl-report');
    assert.equal(complaint.kind, 'complaint');
    assert.equal(complaint.recipient, manifest.fixedInputs.recipient,
      'FblReport block_email must surface as the verified fact recipient');
    assert.equal(complaint.providerMessageId, '<fixture-msg-3@example.invalid>',
      'FblReport message_id must surface as the verified fact providerMessageId');
    assert.equal(complaint.occurredAt, '1783036806',
      'FblReport block_time must surface as the verified fact occurredAt');
    const complaintResult = await reconcileCallback(complaint);
    assert.equal(complaintResult.suppressionRecorded, true);
    const complaintFact = await suppressionFact(RECIPIENT);
    assert.deepEqual(complaintFact?.source, 'complaint');
    assert.equal(complaintFact?.occurred_at.getTime(), new Date(1783036806 * 1000).getTime(),
      'the suppression fact must record the complaint block_time, not now()');
    // When the delivery row IS resolvable (the FblReport message_id matches
    // the stored provider message id) the same verified fact transitions it.
    await seedNotification('p529-complaint-delivery', 'follow_activity',
      { providerMessageId: complaint.providerMessageId });
    const resolvable = await reconcileCallback(complaint);
    assert.equal(resolvable.deliveryTransitioned, true,
      'a resolvable delivery must transition to suppressed on a verified complaint');
    assert.equal((await deliveryRow('p529-complaint-delivery')).state, 'suppressed');
    await seedNotification('p529-after-complaint', 'follow_activity');
    await drainEmail();
    assert.equal((await deliveryRow('p529-after-complaint')).state, 'suppressed');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-after-complaint`), undefined);

    // The REAL classifier + adapter verifier map the fixture's official
    // UnSubscribe shape (envid + rcpt + operate_time, gate doc 10.4) into the
    // verified fact end-to-end; nothing is injected by the test. The envid
    // must surface as providerMessageId so a resolvable delivery row can be
    // suppressed immediately (not only by the worker suppression recheck).
    const unsubscribe = await verifiedFact('unsubscribe');
    assert.equal(unsubscribe.kind, 'unsubscribed');
    assert.equal(unsubscribe.providerMessageId, '60000unsub',
      'the fixture UnSubscribe envid must surface as the verified fact providerMessageId');
    assert.equal(unsubscribe.recipient, manifest.fixedInputs.recipient,
      'UnSubscribe rcpt must surface as the verified fact recipient');
    assert.equal(unsubscribe.occurredAt, '2026-08-02T00:05:48',
      'UnSubscribe operate_time must surface as the verified fact occurredAt');
    const unsubscribeResult = await reconcileCallback(unsubscribe);
    assert.equal(unsubscribeResult.suppressionRecorded, true);
    const unsubscribeFact = await suppressionFact(RECIPIENT);
    assert.deepEqual(unsubscribeFact?.source, 'unsubscribe');
    assert.equal(unsubscribeFact?.occurred_at.getTime(),
      new Date('2026-08-02T00:05:48').getTime(),
      'the suppression fact must record the UnSubscribe operate_time, not now()');
    // When the delivery row IS resolvable (the envid matches the stored
    // provider message id) the same verified fact transitions it immediately.
    await seedNotification('p529-unsubscribe-delivery', 'follow_activity',
      { providerMessageId: unsubscribe.providerMessageId });
    const resolvableUnsubscribe = await reconcileCallback(unsubscribe);
    assert.equal(resolvableUnsubscribe.deliveryTransitioned, true,
      'a resolvable delivery must transition to suppressed on a verified unsubscribe');
    assert.equal(resolvableUnsubscribe.disposition, 'suppressed');
    assert.equal((await deliveryRow('p529-unsubscribe-delivery')).state, 'suppressed');
    await seedNotification('p529-after-unsubscribe', 'follow_activity');
    await drainEmail();
    assert.equal((await deliveryRow('p529-after-unsubscribe')).state, 'suppressed');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-after-unsubscribe`), undefined);
    // N7: per-test cleanup - this test's durable facts must not leak to other tests.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
  }, 30_000);

  test('delivered callback reconciles an in-flight leased delivery with the provider EnvId', async () => {
    await seedNotification('success', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
    assert.equal(claims.length, 1);
    const fact = await verifiedFact('deliver-success');
    assert.equal(fact.kind, 'delivered');
    const result = await reconcileCallback(fact);
    assert.equal(result.disposition, 'delivered');
    assert.equal(result.deliveryTransitioned, true);
    const row = await deliveryRow('success');
    assert.equal(row.state, 'delivered');
    assert.equal(row.provider_message_id, fact.providerMessageId);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}success`), undefined,
      'reconciliation must not contact the provider');
    const replay = await reconcileCallback(fact);
    assert.equal(replay.deliveryTransitioned, false);
  }, 30_000);

  test('retry recovery looks up before re-sending and delivers a known-successful message without a new send', async () => {
    // Isolate from the callback-test suppression facts: this scenario must reach the send path.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await seedNotification('reconciliation', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
    assert.equal(claims.length, 1);
    // Simulate attempt 1 ending unknown (e.g. timeout after provider accepted) -> retryable.
    assert.equal(await repository.failDelivery({ deliveryId: 'reconciliation', attemptCount: 1 },
      { nextAttemptAt: new Date(Date.now() - 5_000), errorCategory: 'provider_unavailable',
        deadLetter: false }), true);
    await drainEmail();
    const row = await deliveryRow('reconciliation');
    assert.equal(row.state, 'delivered', 'lookup must resolve the retry to delivered');
    assert.equal(row.attempt_count, 2);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}reconciliation`), undefined,
      'a known-successful message must not be re-sent on retry');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // FIX-L-058: a lookup API ERROR must never be treated as "no delivery facts".
  // The statistics service failing proves NOTHING about the previous attempt,
  // so re-sending on an error could double-deliver a possibly-sent message:
  // retryable errors back off with the adapter category (dead_letter
  // retry_exhausted at max attempts), permanent invalid-contract dead-letters
  // for review, malformed 2xx responses (unknown with an error category) back
  // off as 'other', and ONLY the benign no-facts unknown (errorCategory null,
  // statistics lag) proceeds to send. Errors never record durable suppression
  // facts either. The benign-unknown -> send path is exercised by the 'timeout'
  // test above (attempt 2 lookup miss then send).
  // ---------------------------------------------------------------------------

  test('FIX-L-058: a retryable lookup error backs off then dead-letters at max attempts, never re-sending', async () => {
    // Isolate from the callback-test suppression facts.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await seedNotification('p529-lookup-error', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Attempt 1 ends retryable (e.g. the original send timed out) so the retry
    // claim runs the lookup first.
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
    assert.equal(claims.length, 1);
    assert.equal(await repository.failDelivery({ deliveryId: 'p529-lookup-error',
      attemptCount: 1 }, { nextAttemptAt: new Date(Date.now() - 5_000),
      errorCategory: 'provider_unavailable', deadLetter: false }), true);
    // The statistics API is DOWN on the retry (timeout): the lookup proves
    // nothing about the previous attempt, so the worker must back off - never
    // re-send. Near-zero backoff keeps the retry hops deterministic.
    const runtime = lookupErrorRuntime(repository, {
      classification: 'retryable', outcome: 'unknown', requestId: null,
      errorCategory: 'provider_unavailable',
      redactedError: 'DirectMail request failed: timeout',
    });
    await runtime.loop.runOnce();
    let row = await deliveryRow('p529-lookup-error');
    assert.equal(row.state, 'retryable');
    assert.equal(row.last_error_category, 'provider_unavailable');
    assert.equal(row.attempt_count, 2);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-lookup-error`), undefined,
      'a failed lookup must never trigger a provider re-send');
    assert.equal((await suppressionFact(RECIPIENT)), null,
      'a lookup API error must never be recorded as a durable suppression fact');
    // Attempt 3 (max): the lookup still errors -> dead_letter retry_exhausted.
    await runtime.loop.runOnce();
    row = await deliveryRow('p529-lookup-error');
    assert.equal(row.state, 'dead_letter');
    assert.equal(row.last_error_category, 'retry_exhausted');
    assert.equal(row.attempt_count, 3);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-lookup-error`), undefined,
      'no provider send may occur across any lookup-error attempt');
    assert.equal(await notificationCount('p529-notification-p529-lookup-error'), 1,
      'a lookup error must never break the in-app Notification');
  }, 30_000);

  test('FIX-L-058: permanent and malformed lookup errors never re-send (dead-letter / back off as other)', async () => {
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const scenarios: ReadonlyArray<{ readonly deliveryId: string;
      readonly lookup: EmailLookupResult; readonly expectedState: 'retryable' | 'dead_letter';
      readonly expectedCategory: string }> = [
      // 403 signature failure: the stats call was NOT answered - permanent
      // invalid_contract dead-letters for operator review.
      { deliveryId: 'p529-lookup-permanent',
        lookup: { classification: 'permanent', outcome: 'unknown', requestId: null,
          errorCategory: 'invalid_contract',
          redactedError: 'DirectMail request failed: HTTP 403 SignatureDoesNotMatch' },
        expectedState: 'dead_letter', expectedCategory: 'invalid_contract' },
      // Malformed 2xx stats body: no delivery fact can be derived - back off as
      // 'other' (frozen D11 unknown taxonomy), never a re-send.
      { deliveryId: 'p529-lookup-malformed',
        lookup: { classification: 'unknown', outcome: 'unknown', requestId: null,
          errorCategory: 'other',
          redactedError: 'SenderStatisticsDetailByParam response is malformed' },
        expectedState: 'retryable', expectedCategory: 'other' },
    ];
    for (const scenario of scenarios) {
      await seedNotification(scenario.deliveryId, 'follow_activity');
      const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
      assert.equal(claims.length, 1);
      assert.equal(await repository.failDelivery({ deliveryId: scenario.deliveryId,
        attemptCount: 1 }, { nextAttemptAt: new Date(Date.now() - 5_000),
        errorCategory: 'provider_unavailable', deadLetter: false }), true);
      const runtime = lookupErrorRuntime(repository, scenario.lookup);
      await runtime.loop.runOnce();
      const row = await deliveryRow(scenario.deliveryId);
      assert.equal(row.state, scenario.expectedState, scenario.deliveryId);
      assert.equal(row.last_error_category, scenario.expectedCategory, scenario.deliveryId);
      assert.equal(row.attempt_count, 2, scenario.deliveryId);
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}${scenario.deliveryId}`), undefined,
        `${scenario.deliveryId}: a lookup error must never trigger a provider re-send`);
      assert.equal(await suppressionFact(RECIPIENT), null,
        `${scenario.deliveryId}: a lookup error must never be recorded as a durable suppression fact`);
      // The malformed scenario ends retryable with the near-zero test backoff;
      // drive it to max attempts so it dead-letters retry_exhausted - both an
      // extra FIX-L-058 exhaustion assertion and test isolation (N7): no due
      // row may leak into the next test's claimDue({limit:1}).
      if (scenario.expectedState === 'retryable') {
        await runtime.loop.runOnce();
        const terminal = await deliveryRow(scenario.deliveryId);
        assert.equal(terminal.state, 'dead_letter', scenario.deliveryId);
        assert.equal(terminal.last_error_category, 'retry_exhausted', scenario.deliveryId);
        assert.equal(terminal.attempt_count, 3, scenario.deliveryId);
        assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}${scenario.deliveryId}`), undefined,
          `${scenario.deliveryId}: no provider send may occur across the backoff/exhaustion hops`);
        assert.equal(await suppressionFact(RECIPIENT), null,
          `${scenario.deliveryId}: no durable suppression fact across the backoff/exhaustion hops`);
      }
    }
  }, 30_000);

  test('delivered callback on a dead-lettered row never re-sends, even when the stats lookup misses', async () => {
    // Isolate from the callback-test suppression facts: this scenario must
    // reach the claim path end-to-end through the real worker.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await seedNotification('p529-deadletter-delivered', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Attempt 1 dead-letters permanently (provider rejects the contract).
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
    assert.equal(claims.length, 1);
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-deadletter-delivered', attemptCount: 1 },
      { nextAttemptAt: new Date(), errorCategory: 'invalid_contract', deadLetter: true }), true);
    let row = await deliveryRow('p529-deadletter-delivered');
    assert.equal(row.state, 'dead_letter');
    assert.equal(row.attempt_count, 1);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-deadletter-delivered`), undefined);

    // The fixture lookup for this tag returns NO stats row (only the
    // reconciliation tag has one), i.e. SenderStatisticsDetailByParam lag or
    // an aged-out 30-day row: a lookup-dependent retry would re-send.
    const lookupMiss = await provider.lookup({ idempotencyKey: 'p529-deadletter-delivered' });
    assert.equal(lookupMiss.classification, 'unknown');
    assert.equal(lookupMiss.outcome, 'unknown',
      'this test MUST run the lookup-miss path or it does not prove the hole is closed');

    // A verified delivered callback matches the dead-lettered row by its
    // stable tag and carries the provider EnvId.
    const fact: EmailCallbackFact = { kind: 'delivered', providerMessageId: '60000success',
      tag: `${TAG_PREFIX}p529-deadletter-delivered` };
    const reconcile = await reconcileCallback(fact);
    assert.equal(reconcile.disposition, 'delivered');
    assert.equal(reconcile.deliveryTransitioned, true);
    row = await deliveryRow('p529-deadletter-delivered');
    assert.equal(row.state, 'retryable',
      'the delivered callback re-arms dead_letter -> retryable under the guard');
    assert.equal(row.provider_message_id, '60000success',
      'the verified delivered callback must persist the delivered-confirmed marker');
    assert.equal(row.last_error_category, 'invalid_contract',
      'the guard keeps the re-arm legal with the same last_error_category');

    const recordsBefore = fixture.requestRecords.length;
    await awaitDue('p529-deadletter-delivered'); // N6: bounded poll, no fixed sleep
    await drainEmail();
    row = await deliveryRow('p529-deadletter-delivered');
    assert.equal(row.state, 'delivered', 'the claim must finalize the re-armed row as delivered');
    assert.equal(row.attempt_count, 2);
    assert.equal(row.provider_message_id, '60000success',
      'the persisted delivery evidence must survive the terminal write');
    assert.equal(row.last_error_category, null);
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-deadletter-delivered`), undefined,
      'a delivery confirmed delivered by a verified callback must NEVER be re-sent, even on a lookup miss');
    assert.equal(fixture.requestRecords.length, recordsBefore,
      'the delivered-confirmed claim must not contact the provider at all (no lookup, no send)');
    const replay = await reconcileCallback(fact);
    assert.equal(replay.deliveryTransitioned, false, 'callback replay must be idempotent on the terminal row');
  }, 30_000);

  test('FIX-M-028: a verified delivered callback on a retryable row finalizes delivered with the marker; lookup lag can never re-send', async () => {
    // Isolate from the callback-test suppression facts: this scenario must
    // reach the callback path end-to-end through the real worker.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await seedNotification('p529-retryable-delivered', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Fault chain (fix.md FIX-M-028): the provider accepted the send but the
    // final leased->delivered CAS lost the lease, so the row falls back to
    // retryable (attempt 1) - the row the verified delivered callback must
    // close before any later claim can re-send.
    const claims = await repository.claimDue({ limit: 1, leaseDurationMs: 60_000 });
    assert.equal(claims.length, 1);
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-retryable-delivered', attemptCount: 1 },
      { nextAttemptAt: new Date(Date.now() - 5_000), errorCategory: 'provider_unavailable',
        deadLetter: false }), true);
    let row = await deliveryRow('p529-retryable-delivered');
    assert.equal(row.state, 'retryable');
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error_category, 'provider_unavailable');

    // The fixture lookup for this tag returns NO stats row, i.e.
    // SenderStatisticsDetailByParam lag: a lookup-dependent retry would re-send.
    const lookupMiss = await provider.lookup({ idempotencyKey: 'p529-retryable-delivered' });
    assert.equal(lookupMiss.classification, 'unknown');
    assert.equal(lookupMiss.outcome, 'unknown',
      'this test MUST run the lookup-miss path or it does not prove the hole is closed');

    // A verified delivered callback matches the retryable row by its stable tag
    // and finalizes it delivered directly with the callback provider EnvId.
    const fact: EmailCallbackFact = { kind: 'delivered', providerMessageId: '60000success',
      tag: `${TAG_PREFIX}p529-retryable-delivered` };
    const reconcile = await reconcileCallback(fact);
    assert.equal(reconcile.disposition, 'delivered');
    assert.equal(reconcile.deliveryTransitioned, true);
    row = await deliveryRow('p529-retryable-delivered');
    assert.equal(row.state, 'delivered',
      'the verified delivered callback must finalize the retryable row delivered directly');
    assert.equal(row.attempt_count, 1,
      'no claim may run between the retryable fallback and the callback finalization');
    assert.equal(row.provider_message_id, '60000success',
      'the verified delivered callback must persist the delivered-confirmed marker');
    assert.equal(row.last_error_category, null,
      'delivered is terminal error-free: the stale failure category must be cleared (m1)');
    assert.ok(row.delivered_at, 'delivered_at must be set on the terminal write');

    const recordsBefore = fixture.requestRecords.length;
    await drainEmail();
    row = await deliveryRow('p529-retryable-delivered');
    assert.equal(row.state, 'delivered', 'the terminal row is never claimed again');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-retryable-delivered`), undefined,
      'a delivery confirmed delivered by a verified callback must NEVER be re-sent, even on a lookup miss');
    assert.equal(fixture.requestRecords.length, recordsBefore,
      'the finalized delivery must not contact the provider at all (no lookup, no send)');
    const replay = await reconcileCallback(fact);
    assert.equal(replay.deliveryTransitioned, false,
      'callback replay must be idempotent on the terminal row');
  }, 30_000);

  test('N5: a retry whose SenderStatisticsDetailByParam lookup reports Status 2 (bounced) suppresses through the production repository with a durable bounce fact and zero sends', async () => {
    // Per-test isolation (N7): this scenario must reach the retry lookup path.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await seedNotification('lookup-bounce', 'follow_activity');
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Attempt 1 ends retryable so attempt 2 runs the retry lookup against the
    // REAL fixture, whose SenderStatisticsDetailByParam returns Status 2 for
    // the p527-delivery-lookup-bounce tag through the production adapter
    // classification (classifySenderStatisticsMailDetail: 2 -> bounced).
    const claim1 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'lookup-bounce');
    assert.ok(claim1, 'N5 needs a first claim');
    assert.equal(await repository.failDelivery(
      { deliveryId: 'lookup-bounce', attemptCount: claim1.attemptCount },
      { nextAttemptAt: new Date(Date.now() - 5_000), errorCategory: 'provider_unavailable',
        deadLetter: false }), true);
    await drainEmail();
    const row = await deliveryRow('lookup-bounce');
    assert.equal(row.state, 'suppressed', 'a Status-2 lookup must suppress the retried delivery');
    const fact = await suppressionFact(RECIPIENT);
    assert.equal(fact?.source, 'bounce', 'the Status-2 lookup must record a durable bounce fact');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}lookup-bounce`), undefined,
      'a bounced lookup must never re-send');
    assert.equal(await notificationCount('p529-notification-lookup-bounce'), 1);
    // Per-test cleanup (N7): this test's durable fact must not leak to other tests.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
  }, 30_000);

  test('N4: a recipient account without an email dead-letters as invalid_contract with zero sends', async () => {
    const NO_EMAIL_RECIPIENT = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status) values($1,$2,'active')
      on conflict(id) do nothing`, [NO_EMAIL_RECIPIENT, `subject-${NO_EMAIL_RECIPIENT}`]);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name) values($1,$2)
      on conflict(account_id) do nothing`, [NO_EMAIL_RECIPIENT, NO_EMAIL_RECIPIENT]);
    // The preference must be ENABLED so the suppression recheck passes and the
    // missing-email dead-letter branch is the one that fires.
    await isolated.runtime.pool.query(`insert into notification_preferences(
        recipient_account_id,channel,enabled) values($1,'email',true)
      on conflict(recipient_account_id,channel) do update set enabled=true`,
    [NO_EMAIL_RECIPIENT]);
    const deliveryId = 'p529-no-email';
    const notificationId = `p529-notification-${deliveryId}`;
    await isolated.runtime.pool.query(`insert into notifications(notification_id,
        recipient_account_id,source_event_id,notification_type,actor_profile_id,
        subject_type,subject_id,occurred_at,retain_until)
      values($1,$2,$3,'follow_activity',$4,'profile',$4,current_timestamp,
        current_timestamp + interval '365 days')`,
    [notificationId, NO_EMAIL_RECIPIENT, `p529-event-${deliveryId}`, ACTOR]);
    await isolated.runtime.pool.query(`insert into notification_deliveries(delivery_id,
        notification_id,recipient_account_id,channel)
      values($1,$2,$3,'email')`, [deliveryId, notificationId, NO_EMAIL_RECIPIENT]);
    await drainEmail();
    const row = await deliveryRow(deliveryId);
    assert.equal(row.state, 'dead_letter');
    assert.equal(row.last_error_category, 'invalid_contract',
      'a missing recipient email must dead-letter as invalid_contract (D4)');
    assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}${deliveryId}`), undefined,
      'a missing recipient email must never contact the provider');
  }, 30_000);

  test('N3: a vanished notification authority mid-flight leaves no deliverable row (cascade) and the claim reports lease_lost with zero sends', async () => {
    await setPreference('email', true);
    await seedNotification('p529-authority-cascade', 'follow_activity');
    // Wrapped production repository: after the loop claims the row, the first
    // repository touch deletes the authority row (the cascade delete that raced
    // the claim). The ON DELETE CASCADE removes the delivery row with it, so the
    // claim cannot finalize - the worker reports lease_lost and never contacts
    // the provider. This locks in the current schema contract: with the cascade
    // in place the dead_letter branch is defense-in-depth (covered by the unit
    // test and the N3 dead-letter test below).
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const wrapped = {
      ...repository,
      async readSuppressionFacts(recipientAccountId: string) {
        await isolated.runtime.pool.query(`delete from notifications
          where notification_id=$1`, ['p529-notification-p529-authority-cascade']);
        return repository.readSuppressionFacts(recipientAccountId);
      },
    };
    const cascadeMetrics = new InMemoryMetrics();
    const runtime = createEmailDeliveryWorkerRuntime({
      repository: wrapped,
      provider,
      logger: {
        info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
        warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
        error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
      },
      metrics: cascadeMetrics,
      leaseDurationMs: 2_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 100,
      batchSize: 4,
      retryPolicy: createEmailDeliveryRetryPolicy({
        baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 3 }),
      tagPrefix: TAG_PREFIX,
    });
    try {
      await runtime.loop.runOnce();
      assert.equal((await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text count
        from notification_deliveries where delivery_id=$1`, ['p529-authority-cascade'])).rows[0]?.count,
      '0', 'the cascade must remove the orphaned delivery row with its authority');
      assert.equal(cascadeMetrics.get('notifications.email_delivery.lease_lost'), 1,
        'the stale claim must report lease_lost once the delivery row vanished');
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-authority-cascade`), undefined,
        'a vanished authority must never contact the provider');
    } finally {
      await setPreference('email', true);
    }
  }, 30_000);

  test('N3: loadTemplateContext returning null dead-letters through the production repository as other with zero sends', async () => {
    await setPreference('email', true);
    await seedNotification('p529-authority-missing', 'follow_activity');
    // The ON DELETE CASCADE normally removes the delivery row with its
    // notification (covered above), so the worker's dead_letter branch is
    // defense-in-depth. This test drives that branch against the real Postgres
    // repository: the wrapped seam returns null for the vanished authority while
    // the terminal failDelivery CAS runs on the production repository.
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const wrapped = {
      ...repository,
      async loadTemplateContext(notificationId: string) {
        if (notificationId === 'p529-notification-p529-authority-missing') return null;
        return repository.loadTemplateContext(notificationId);
      },
    };
    const runtime = createEmailDeliveryWorkerRuntime({
      repository: wrapped,
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
    try {
      await runtime.loop.runOnce();
      const row = await deliveryRow('p529-authority-missing');
      assert.equal(row.state, 'dead_letter',
        'a missing template context must dead-letter the orphaned delivery');
      assert.equal(row.last_error_category, 'other');
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}p529-authority-missing`), undefined,
        'a dead-lettered authority-missing delivery must never contact the provider');
    } finally {
      await setPreference('email', true);
    }
  }, 30_000);

  test('template injection markers are escaped, and PII/secret markers stay out of logs and fixture records', async () => {
    const markerActor = 'P529_INJECT_ACTOR_<script>alert("x")</script>';
    const markerTitle = 'P529_INJECT_TITLE_<img src=x onerror=alert(1)>';
    const markerRecipient = 'p529-pii-recipient@example.invalid';
    const markerSecret = manifest.fixedInputs.signingKeyMaterial;
    const markerSender = manifest.fixedInputs.sender;
    await isolated.runtime.pool.query(`update profiles set display_name=$2 where account_id=$1`,
      [ACTOR, markerActor]);
    await isolated.runtime.pool.query(`update collections set title=$2 where id=$1`,
      [COLLECTION, markerTitle]);
    await isolated.runtime.pool.query(`update accounts set email=$2 where id=$1`,
      [RECIPIENT, markerRecipient]);
    // This test must observe a real send: drop the durable suppression fact
    // recorded by the callback tests so the recheck allows delivery.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    logs.length = 0;
    await seedNotification('p529-inject', 'collection_change');
    await drainEmail();
    assert.equal((await deliveryRow('p529-inject')).state, 'delivered');
    const serializedLogs = JSON.stringify(logs);
    const serializedRecords = JSON.stringify(fixture.requestRecords);
    for (const marker of [markerActor, markerTitle, markerRecipient, markerSecret, markerSender,
      'P529-INJECT', 'P527-SUBJECT-MARKER', 'P527-TEXT-BODY-MARKER', 'P527-HTML-BODY-MARKER']) {
      assert.doesNotMatch(serializedLogs, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        `log marker leak: ${marker}`);
      assert.doesNotMatch(serializedRecords,
        new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        `fixture record marker leak: ${marker}`);
    }
    assert.ok(serializedLogs.length > 0, 'the capturing logger must observe worker activity');
  }, 30_000);

  test('m1: every suppression path clears last_error_category and ops error tallies exclude suppressed rows', async () => {
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    // Scoped ops baseline (N7): tallies are asserted as deltas so this test is
    // independent of which earlier tests wrote rows in the shared database.
    const ops = createPostgresNotificationOperationsRepository(isolated.runtime.pool);
    const opsBefore = await ops.inspectStatus();
    // Path 1: worker lifecycle (claim -> fail -> re-claim -> suppressDelivery):
    // the re-claim clears the stale category and the final suppressed row stays
    // NULL, so the worker suppression path can never leave a stale category.
    await seedNotification('p529-m1-suppress-a', 'follow_activity');
    const claimA = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-m1-suppress-a');
    assert.ok(claimA, 'm1 suppress path needs a claim');
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-m1-suppress-a', attemptCount: claimA.attemptCount },
      { nextAttemptAt: new Date(), errorCategory: 'provider_unavailable', deadLetter: false }), true);
    let row = await deliveryRow('p529-m1-suppress-a');
    assert.equal(row.state, 'retryable');
    assert.equal(row.last_error_category, 'provider_unavailable', 'failure must be recorded while retryable');
    const claimA2 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-m1-suppress-a');
    assert.ok(claimA2, 'm1 suppress path needs the re-claim');
    row = await deliveryRow('p529-m1-suppress-a');
    assert.equal(row.state, 'leased');
    assert.equal(row.last_error_category, null,
      'the re-claim must clear the stale category before the worker suppress (m1)');
    assert.equal(await repository.suppressDelivery(
      { deliveryId: 'p529-m1-suppress-a', attemptCount: claimA2.attemptCount }), true);
    row = await deliveryRow('p529-m1-suppress-a');
    assert.equal(row.state, 'suppressed');
    assert.equal(row.last_error_category, null,
      'worker suppression must leave last_error_category NULL (m1)');

    // Path 2: callback retryable -> suppressed (applyCallbackTransition).
    await seedNotification('p529-m1-suppress-b', 'follow_activity');
    const claimB = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-m1-suppress-b');
    assert.ok(claimB, 'm1 callback-suppress path needs a claim');
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-m1-suppress-b', attemptCount: claimB.attemptCount },
      { nextAttemptAt: new Date(), errorCategory: 'dependency', deadLetter: false }), true);
    row = await deliveryRow('p529-m1-suppress-b');
    assert.equal(row.state, 'retryable');
    assert.equal(row.last_error_category, 'dependency');
    const bounce = await reconcileCallback({ kind: 'bounced',
      tag: `${TAG_PREFIX}p529-m1-suppress-b`, occurredAt: '2026-08-02T00:00:00.000Z' });
    assert.equal(bounce.disposition, 'suppressed');
    row = await deliveryRow('p529-m1-suppress-b');
    assert.equal(row.state, 'suppressed');
    assert.equal(row.last_error_category, null,
      'callback suppression of a retryable row must clear the stale category (m1)');

    // Path 3: callback pending -> suppressed (no category ever written, stays NULL).
    await seedNotification('p529-m1-suppress-c', 'follow_activity');
    const pendingBounce = await reconcileCallback({ kind: 'bounced',
      tag: `${TAG_PREFIX}p529-m1-suppress-c`, occurredAt: '2026-08-02T00:00:00.000Z' });
    assert.equal(pendingBounce.disposition, 'suppressed');
    row = await deliveryRow('p529-m1-suppress-c');
    assert.equal(row.state, 'suppressed');
    assert.equal(row.last_error_category, null,
      'callback suppression of a pending row must keep the category NULL (m1)');

    // Ops error tallies must exclude the suppressed rows (only retryable/dead_letter
    // count). Asserted as deltas vs the test's own baseline (N7).
    const status = await ops.inspectStatus();
    assert.equal(status.delivery.errors.providerUnavailable, opsBefore.delivery.errors.providerUnavailable,
      'suppressed rows must not inflate provider_unavailable errors (m1)');
    assert.equal(status.delivery.errors.dependency, opsBefore.delivery.errors.dependency,
      'suppressed rows must not inflate dependency errors (m1)');
    assert.ok(status.delivery.suppressedCount >= opsBefore.delivery.suppressedCount + 3,
      'the three suppressed rows must be visible');

    // N7: per-test cleanup - the m1 bounce path wrote its own durable fact; no
    // test may rely on another test's facts (each facts-writer self-cleans).
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
  }, 30_000);

  test('m1: a re-claimed retryable row no longer shows the stale failure category', async () => {
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    await seedNotification('p529-m1-reclaim', 'follow_activity');
    const claim1 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-m1-reclaim');
    assert.ok(claim1, 'm1 reclaim needs a first claim');
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-m1-reclaim', attemptCount: claim1.attemptCount },
      { nextAttemptAt: new Date(), errorCategory: 'provider_unavailable', deadLetter: false }), true);
    let row = await deliveryRow('p529-m1-reclaim');
    assert.equal(row.state, 'retryable');
    assert.equal(row.last_error_category, 'provider_unavailable');

    // Re-claim: the in-flight attempt must NOT carry the previous failure's category.
    const claim2 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-m1-reclaim');
    assert.ok(claim2, 'm1 reclaim needs a second claim');
    row = await deliveryRow('p529-m1-reclaim');
    assert.equal(row.state, 'leased');
    assert.equal(row.attempt_count, 2);
    assert.equal(row.last_error_category, null,
      'a re-claimed retryable row must clear the stale category while in flight (m1)');

    // A new failure re-records the category; the next claim clears it again.
    assert.equal(await repository.failDelivery(
      { deliveryId: 'p529-m1-reclaim', attemptCount: claim2.attemptCount },
      { nextAttemptAt: new Date(), errorCategory: 'invalid_contract', deadLetter: false }), true);
    row = await deliveryRow('p529-m1-reclaim');
    assert.equal(row.state, 'retryable');
    assert.equal(row.last_error_category, 'invalid_contract');
    const claim3 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
      .find((claim) => claim.deliveryId === 'p529-m1-reclaim');
    assert.ok(claim3, 'm1 reclaim needs a third claim');
    row = await deliveryRow('p529-m1-reclaim');
    assert.equal(row.state, 'leased');
    assert.equal(row.last_error_category, null,
      'every re-claim must clear the stale category (m1)');
    assert.equal(await repository.completeDelivery(
      { deliveryId: 'p529-m1-reclaim', attemptCount: claim3.attemptCount }, 'env-m1-reclaim'), true);
    row = await deliveryRow('p529-m1-reclaim');
    assert.equal(row.state, 'delivered');
    assert.equal(row.last_error_category, null);
  }, 30_000);

  test('FIX-M-026: every process-phase exception (suppression read/template/render/lookup/send) retries with backoff then dead-letters at maxAttempts without stale-owner writes', async () => {
    // N7 isolation: each phase must reach its own throw with the recipient
    // sendable and no durable suppression fact leaking in.
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [RECIPIENT]);
    await setPreference('email', true);
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const phases: ReadonlyArray<{ name: string; deliveryId: string;
      loop: EmailDeliveryWorkerLoop; preclaim?: boolean }> = [
      { name: 'suppression-read', deliveryId: 'p529-poison-suppression',
        loop: poisonLoop({ repository: { ...repository,
          readSuppressionFacts: async () => { throw new Error('FIX-M-026 suppression read failure'); } } }) },
      { name: 'template-load', deliveryId: 'p529-poison-template',
        loop: poisonLoop({ repository: { ...repository,
          loadTemplateContext: async () => { throw new Error('FIX-M-026 template load failure'); } } }) },
      { name: 'render', deliveryId: 'p529-poison-render',
        loop: poisonLoop({ repository,
          renderers: { render: () => { throw new Error('FIX-M-026 render failure'); } } }) },
      { name: 'lookup', deliveryId: 'p529-poison-lookup',
        loop: poisonLoop({ repository, provider: providerThrowing('lookup') }), preclaim: true },
      { name: 'send', deliveryId: 'p529-poison-send',
        loop: poisonLoop({ repository, provider: providerThrowing('send') }) },
    ];
    for (const phase of phases) {
      await seedNotification(phase.deliveryId, 'follow_activity');
      if (phase.preclaim) {
        // The retry lookup only runs on attempt > 1: end attempt 1 retryable
        // first so the poisoned lookup is the phase under test.
        const claim1 = (await repository.claimDue({ limit: 4, leaseDurationMs: 60_000 }))
          .find((claim) => claim.deliveryId === phase.deliveryId);
        assert.ok(claim1, `${phase.name}: lookup phase needs a first claim`);
        assert.equal(await repository.failDelivery(
          { deliveryId: phase.deliveryId, attemptCount: claim1.attemptCount },
          { nextAttemptAt: new Date(Date.now() - 5_000), errorCategory: 'provider_unavailable',
            deadLetter: false }), true, phase.name);
      }
      await phase.loop.runOnce();
      let row = await deliveryRow(phase.deliveryId);
      assert.equal(row.state, 'retryable', `${phase.name}: the throw must go retryable`);
      assert.equal(row.last_error_category, 'other',
        `${phase.name}: the unclassified throw must map to the stable other category`);
      assert.equal(row.attempt_count, phase.preclaim ? 2 : 1, phase.name);
      assert.ok(row.next_attempt_at.getTime() > Date.now() + 500,
        `${phase.name}: the retryable write must carry the policy backoff`);
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}${phase.deliveryId}`), undefined,
        `${phase.name}: a poisoned delivery must never reach the provider send`);
      const hopsRemaining = phase.preclaim ? 1 : 2;
      for (let hop = 0; hop < hopsRemaining; hop += 1) {
        await awaitDue(phase.deliveryId);
        await phase.loop.runOnce();
        row = await deliveryRow(phase.deliveryId);
        if (hop < hopsRemaining - 1) {
          assert.equal(row.state, 'retryable', `${phase.name}: hop ${hop} must stay retryable`);
          assert.equal(row.last_error_category, 'other', phase.name);
        }
      }
      assert.equal(row.state, 'dead_letter',
        `${phase.name}: maxAttempts must dead-letter the poisoned delivery`);
      assert.equal(row.last_error_category, 'retry_exhausted', phase.name);
      assert.equal(row.attempt_count, 3,
        `${phase.name}: attempt_count must be bounded by maxAttempts`);
      // dead_letter is terminal: a further loop pass never re-claims the row.
      await phase.loop.runOnce();
      row = await deliveryRow(phase.deliveryId);
      assert.equal(row.state, 'dead_letter', phase.name);
      assert.equal(row.attempt_count, 3, phase.name);
      assert.equal(fixture.sentTagCounts.get(`${TAG_PREFIX}${phase.deliveryId}`), undefined,
        `${phase.name}: no provider send across all attempts`);
      // No stale-owner write: an old attempt fence can never mutate the terminal row.
      assert.equal(await repository.failDelivery(
        { deliveryId: phase.deliveryId, attemptCount: 1 },
        { nextAttemptAt: new Date(), errorCategory: 'other', deadLetter: false }), false,
      `${phase.name}: a stale failDelivery fence must be refused`);
      assert.equal(await repository.completeDelivery(
        { deliveryId: phase.deliveryId, attemptCount: 1 }, 'env-stale'), false,
      `${phase.name}: a stale completeDelivery fence must be refused`);
      assert.equal(await notificationCount(`p529-notification-${phase.deliveryId}`), 1, phase.name);
    }
  }, 60_000);
});
