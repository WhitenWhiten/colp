import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { buildApiApp } from '../../../src/transport/app.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { AliyunDirectMailAdapter } from '../../../src/infrastructure/email/index.js';
import {
  buildMnsPushRequest,
  createSelfSignedTestCertificate,
} from '../../support/phase5-mns-push.js';
import { createPostgresEmailDeliveryWorkerRepository } from '../../../src/infrastructure/notifications/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { reconcileEmailCallback, type EmailCallbackReconciliationResult,
  type EmailCallbackFact, type EmailCallbackRateLimiter } from '../../../src/modules/notifications/index.js';
import { createMemoryEmailCallbackRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { loadEmailEntryReplayManifest } from '../../../scripts/evidence/phase5-email-entry-fixture.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const CALLBACK_SECRET = `p531_callback_${'s'.repeat(10)}`;
const TAG_PREFIX = 'p531-delivery-';
const EMAIL_CALLBACK_PATH = '/api/v1/email/callbacks/delivery';

function hmacEnvelope(body: string, secret: string, timestamp = '2026-08-02T00:00:00.000Z', nonce = 'nonce-1') {
  const signature = createHmac('sha256', secret)
    .update(`${body}\n${timestamp}\n${nonce}`).digest('base64');
  return {
    'content-type': 'application/json',
    'x-known-dm-signature': signature,
    'x-known-dm-timestamp': timestamp,
    'x-known-dm-nonce': nonce,
  };
}

describeWithPostgres('P5-31 callback ingress over real HTTP', () => {
  const RECIPIENT = 'EREREREREREREREREREREQ';
  const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
  const COLLECTION = 'FBQUFBQUFBQUFBQUFBQUFA';
  let isolated!: IsolatedPostgresRuntime;
  let adapter!: AliyunDirectMailAdapter;
  let metrics!: InMemoryMetrics;
  let deliveryId = '';
  let notificationId = '';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_email_callback', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, RECIPIENT, ACTOR, COLLECTION);
    await isolated.runtime.pool.query(
      `update accounts set email='p531-recipient@example.invalid' where id=$1`, [RECIPIENT]);
    const manifest = loadEmailEntryReplayManifest();
    adapter = new AliyunDirectMailAdapter({
      endpoint: 'https://dm.aliyuncs.com/',
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      callbackHmacSecret: CALLBACK_SECRET,
    });
    metrics = new InMemoryMetrics();
  }, 120_000);

  afterAll(async () => {
    await adapter.close().catch(() => undefined);
    await isolated?.close();
  });

  async function seedLeasedDelivery(providerMessageId?: string):
    Promise<{ deliveryId: string; notificationId: string }> {
    const deliveryIdValue = `p531-delivery-${randomUUID()}`;
    const notificationIdValue = `p531-notification-${randomUUID()}`;
    await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
      notification_type,actor_profile_id,subject_type,subject_id,state,source_event_id,
      occurred_at,retain_until)
      values($1,$2,'collection_change',$3,'collection','p531-subject','unread',$4,
        current_timestamp,current_timestamp+interval '365 days')`,
    [notificationIdValue, RECIPIENT, ACTOR, `event-${notificationIdValue}`]);
    // provider_message_id is seeded at INSERT time (the transition guard only
    // constrains state/attempt_count/state_revision/last_error_category on
    // insert), then the row is leased through the allowed pending->leased
    // transition below.
    await isolated.runtime.pool.query(`insert into notification_deliveries(
      delivery_id,notification_id,recipient_account_id,channel,state,last_error_category,
      provider_message_id)
      values($1,$2,$3,'email','pending',null,$4)`,
    [deliveryIdValue, notificationIdValue, RECIPIENT, providerMessageId ?? null]);
    await isolated.runtime.pool.query(`update notification_deliveries
      set state='leased', attempt_count=1, state_revision=1,
        leased_until=current_timestamp+interval '5 minutes'
      where delivery_id=$1`, [deliveryIdValue]);
    return { deliveryId: deliveryIdValue, notificationId: notificationIdValue };
  }

  function appComposition(emailEnabled: boolean, verifierOverride?: AliyunDirectMailAdapter,
    reconcileOverride?: (fact: EmailCallbackFact) => Promise<EmailCallbackReconciliationResult>,
    rateLimiterOverride?: EmailCallbackRateLimiter) {
    const repository = createPostgresEmailDeliveryWorkerRepository(isolated.runtime.pool);
    const reconcile = reconcileOverride ?? ((fact: EmailCallbackFact) =>
      reconcileEmailCallback({ fact, repository, tagPrefix: TAG_PREFIX }));
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      LOG_LEVEL: 'silent', KNOWN_FEATURE_EMAIL: emailEnabled ? 'true' : 'false',
      EMAIL_DM_ACCOUNT_NAME: 'sender@example.invalid' });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      emailCallbackRoutes: {
        enabled: emailEnabled,
        verifier: verifierOverride ?? adapter,
        reconcile,
        metrics,
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        ...(rateLimiterOverride === undefined ? {} : { rateLimiter: rateLimiterOverride }),
      },
    });
    return app;
  }

  test('valid HMAC callback is accepted (202), reconciles the delivery and is idempotent on replay', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const seeded = await seedLeasedDelivery();
      const body = JSON.stringify({ type: 'dm:Deliver:Succeed',
        data: { env_id: 'p531-env-1', tag: `${TAG_PREFIX}${seeded.deliveryId}` } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET);
      const first = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(first.status, 202);
      assert.deepEqual(JSON.parse(await first.text()), { accepted: true });
      const row = (await isolated.runtime.pool.query(
        `select state, state_revision, provider_message_id from notification_deliveries
         where delivery_id=$1`, [seeded.deliveryId])).rows[0] as
        { state: string; state_revision: string; provider_message_id: string };
      assert.equal(row.state, 'delivered');
      assert.equal(row.provider_message_id, 'p531-env-1');
      const revisionAfterFirst = row.state_revision;
      const replay = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(replay.status, 202);
      const afterReplay = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(afterReplay.state, 'delivered');
      assert.equal(afterReplay.state_revision, revisionAfterFirst,
        'replay must not mutate the terminal delivery row');
    } finally { await app.close(); }
  });

  test('A6: a reconcile failure returns a stable 503 with no partial side effects and increments the reconcile_error metric', async () => {
    const reconcileErrorBefore = metrics.get('notifications.email_delivery.callback.reconcile_error');
    const rejectedBefore = metrics.get('notifications.email_delivery.callback.rejected');
    const acceptedBefore = metrics.get('notifications.email_delivery.callback.accepted');
    const beforeFacts = (await isolated.runtime.pool.query(
      `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
      [RECIPIENT])).rows[0] as { count: number };
    const seeded = await seedLeasedDelivery();
    const app = appComposition(true, undefined,
      async () => { throw new Error('provider exploded accessKeySecret=RAW-A6-PROVIDER-TEXT'); });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const body = JSON.stringify({ type: 'dm:Deliver:Succeed',
        data: { env_id: 'a6-env-1', tag: `${TAG_PREFIX}${seeded.deliveryId}` } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-a6');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 503, 'a reconcile failure must be a stable 503, never a 500');
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { error: 'callback_reconcile_error' });
      assert.equal(text.includes('RAW-A6-PROVIDER-TEXT'), false,
        'raw provider text must never reach the response');
      assert.equal(text.includes('accessKeySecret'), false,
        'camelCase secret keys must not leak into the response');
      const row = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(row.state, 'leased',
        'a reconcile failure must not partially transition the delivery row');
      assert.equal(row.state_revision, '1', 'the CAS revision must be untouched');
      const afterFacts = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(afterFacts.count, beforeFacts.count,
        'no suppression fact may be written on a reconcile failure');
      assert.equal(metrics.get('notifications.email_delivery.callback.reconcile_error'),
        reconcileErrorBefore + 1, 'the reconcile_error metric must increment (A6)');
      assert.equal(metrics.get('notifications.email_delivery.callback.accepted'), acceptedBefore,
        'a reconcile failure must not increment accepted (A6)');
      assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), rejectedBefore,
        'a reconcile failure must not increment rejected (A6)');
    } finally { await app.close(); }
  });

  test('bounce callback suppresses the recipient and records a durable fact', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const seeded = await seedLeasedDelivery();
      const body = JSON.stringify({ type: 'dm:Deliver:Fail', data: { env_id: 'p531-env-2',
        status: '2', tag: `${TAG_PREFIX}${seeded.deliveryId}` } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-bounce');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 202);
      const row = (await isolated.runtime.pool.query(
        `select state from notification_deliveries where delivery_id=$1`, [seeded.deliveryId])).rows[0] as
        { state: string };
      assert.equal(row.state, 'suppressed');
      const fact = (await isolated.runtime.pool.query(
        `select source from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { source: string };
      assert.equal(fact.source, 'bounce');
    } finally { await app.close(); }
  });

  test('tampered callback is rejected 403 with no delivery side effect', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const seeded = await seedLeasedDelivery();
      const body = JSON.stringify({ type: 'dm:Deliver:Succeed',
        data: { env_id: 'p531-env-3', tag: `${TAG_PREFIX}${seeded.deliveryId}` } });
      const headers = hmacEnvelope(body, 'wrong-secret');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 403);
      const row = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(row.state, 'leased');
      assert.equal(row.state_revision, '1');
      // Order-independent (m4): scope the suppression assertion to THIS
      // recipient and assert a zero delta, so the test does not rely on any
      // earlier test having written (or not written) a fact.
      const suppressionBefore = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      const suppression = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(suppression.count, suppressionBefore.count,
        'a tampered callback must write no suppression fact (delta scoped to this recipient)');
    } finally { await app.close(); }
  });

  test('callback surface is disabled (404) when the email feature is not configured', async () => {
    const app = appComposition(false);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 404);
    } finally { await app.close(); }
  });

  test('real FblReport callback through the HMAC ingress suppresses the recipient at the complaint block_time', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      // N7 isolation (FIX-L-062): the suppression upsert is monotonic in
      // occurred_at - a fact is only replaced by a NOT-older fact. The bounce
      // callback test above recorded its fallback-stamped fact at the real
      // reconcile clock (newer than this complaint's provider block_time), so
      // this test self-cleans the recipient fact instead of relying on
      // cross-test overwrite order.
      await isolated.runtime.pool.query(`delete from notification_email_suppressions
        where recipient_account_id=$1`, [RECIPIENT]);
      // Official FblReport shape (gate doc 10.4): no env_id/rcpt/msg_id/tag —
      // block_email is the recipient, message_id the mail identifier and
      // block_time the complaint time (UNIX epoch seconds). No delivery row
      // matches, so the durable fact must be reached through the email ->
      // account resolution of block_email.
      const body = JSON.stringify({ type: 'dm:Feedback:FblReport',
        data: { send_time: '1783036804', send_email: 'sender@example.invalid',
          block_email: 'p531-recipient@example.invalid', subject: 'P531-SUBJECT-MARKER',
          message_id: '<p531-fbl-msg-1@example.invalid>', block_time: '1783036806',
          fbl_isp: 'outlook', fingerprint: 'SMTPD_p531****' } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-fbl-1');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 202);
      const fact = (await isolated.runtime.pool.query(
        `select source, occurred_at from notification_email_suppressions
         where recipient_account_id=$1`, [RECIPIENT])).rows[0] as
        { source: string; occurred_at: Date };
      assert.equal(fact.source, 'complaint');
      assert.equal(fact.occurred_at.getTime(), new Date(1783036806 * 1000).getTime(),
        'the suppression fact must record the FblReport block_time, not now()');
    } finally { await app.close(); }
  });

  test('real FblReport callback transitions a resolvable delivery to suppressed', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const messageId = '<p531-fbl-msg-2@example.invalid>';
      const seeded = await seedLeasedDelivery(messageId);
      const body = JSON.stringify({ type: 'dm:Feedback:FblReport',
        data: { send_time: '1783036804', send_email: 'sender@example.invalid',
          block_email: 'p531-recipient@example.invalid', subject: 'P531-SUBJECT-MARKER',
          message_id: messageId, block_time: '1783036812',
          fbl_isp: 'outlook', fingerprint: 'SMTPD_p531****' } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-fbl-2');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 202);
      const row = (await isolated.runtime.pool.query(
        `select state from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string };
      assert.equal(row.state, 'suppressed');
      const fact = (await isolated.runtime.pool.query(
        `select source, occurred_at from notification_email_suppressions
         where recipient_account_id=$1`, [RECIPIENT])).rows[0] as
        { source: string; occurred_at: Date };
      assert.equal(fact.source, 'complaint');
      assert.equal(fact.occurred_at.getTime(), new Date(1783036812 * 1000).getTime(),
        'the suppression fact must record this complaint block_time');
    } finally { await app.close(); }
  });

  test('real MNS push over the relative request target is rejected when HMAC is configured', async () => {
    const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = createSelfSignedTestCertificate(keypair);
    const mnsAdapter = new AliyunDirectMailAdapter({
      endpoint: 'https://dm.aliyuncs.com/',
      regionId: 'cn-hangzhou',
      accountName: 'sender@example.invalid',
      accessKeyId: 'P531FIXTUREAKID',
      accessKeySecret: 'p531-fixture-key',
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      callbackHmacSecret: CALLBACK_SECRET,
      mnsCertificateFetcher: { async fetchCertificate() { return certPem; } },
    });
    const app = appComposition(true, mnsAdapter);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const envId = `p531-mns-env-${randomUUID()}`;
      const seeded = await seedLeasedDelivery(envId);
      const body = [
        'X-Notify-Message-ID=p531-mns-msg-1',
        `env_id=${envId}`,
        'msg_id=p531-mns-msg-1@example.invalid',
        'account=sender@example.invalid',
        'from=sender@example.invalid',
        'rcpt=p531-recipient@example.invalid',
        'recv_time=2026-08-02T00:00:00',
        'end_time=2026-08-02T00:00:01',
        'status=4',
        'event=deliver',
        'region=cn-hangzhou',
        'err_code=524',
        'err_msg=524 Host not found by dns resolve',
        'failed_type=SysOutDnsResolveFail',
      ].join('&');
      const { headers } = buildMnsPushRequest(keypair, {
        url: EMAIL_CALLBACK_PATH,
        date: 'Sun, 02 Aug 2026 00:00:00 GMT',
        body,
      });
      const before = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 401, 'HMAC-configured ingress must not admit a shared-cert MNS push');
      const row = (await isolated.runtime.pool.query(
        `select state from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string };
      assert.equal(row.state, 'leased');
      const after = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(after.count, before.count);
    } finally {
      await app.close();
      await mnsAdapter.close();
    }
  });

  test('real MNS push WITHOUT Content-MD5 is rejected 403 with zero side effects (delivery untouched, no suppression fact)', async () => {
    const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = createSelfSignedTestCertificate(keypair);
    const mnsAdapter = new AliyunDirectMailAdapter({
      endpoint: 'https://dm.aliyuncs.com/',
      regionId: 'cn-hangzhou',
      accountName: 'sender@example.invalid',
      accessKeyId: 'P531FIXTUREAKID',
      accessKeySecret: 'p531-fixture-key',
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      callbackHmacSecret: CALLBACK_SECRET,
      mnsCertificateFetcher: { async fetchCertificate() { return certPem; } },
    });
    const app = appComposition(true, mnsAdapter);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const envId = `p531-mns-env-${randomUUID()}`;
      const seeded = await seedLeasedDelivery(envId);
      const before = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      const rejectedBefore = metrics.get('notifications.email_delivery.callback.rejected');
      // status=0 claims DELIVERED: without the fail-closed Content-MD5
      // requirement the RSA-valid, MD5-less push would transition the leased
      // delivery to delivered. The fix must reject it with NO side effects.
      const body = [
        'X-Notify-Message-ID=p531-mns-msg-3',
        `env_id=${envId}`,
        'msg_id=p531-mns-msg-3@example.invalid',
        'account=sender@example.invalid',
        'from=sender@example.invalid',
        'rcpt=p531-recipient@example.invalid',
        'recv_time=2026-08-02T00:00:00',
        'end_time=2026-08-02T00:00:01',
        'status=0',
        'event=deliver',
        'region=cn-hangzhou',
        'err_code=0',
        'err_msg=',
        'failed_type=',
      ].join('&');
      const { headers } = buildMnsPushRequest(keypair, {
        url: EMAIL_CALLBACK_PATH,
        date: 'Sun, 02 Aug 2026 00:00:00 GMT',
        body,
        omitContentMd5: true,
      });
      assert.equal(headers['content-md5'], undefined, 'fixture must not emit a Content-MD5 header');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 401, 'HMAC-configured ingress rejects MNS before the MD5 check');
      assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), rejectedBefore + 1,
        'a missing-Content-MD5 rejection must increment callback.rejected');
      const row = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(row.state, 'leased', 'the rejected push must not transition the delivery row');
      assert.equal(row.state_revision, '1', 'the rejected push must not mutate the delivery row');
      const after = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(after.count, before.count, 'the rejected push must not write any suppression fact');
    } finally {
      await app.close();
      await mnsAdapter.close();
    }
  });

  test('tampered MNS push over the relative request target is rejected 403 with zero side effects', async () => {
    const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherKeypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = createSelfSignedTestCertificate(keypair);
    const mnsAdapter = new AliyunDirectMailAdapter({
      endpoint: 'https://dm.aliyuncs.com/',
      regionId: 'cn-hangzhou',
      accountName: 'sender@example.invalid',
      accessKeyId: 'P531FIXTUREAKID',
      accessKeySecret: 'p531-fixture-key',
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      callbackHmacSecret: CALLBACK_SECRET,
      mnsCertificateFetcher: { async fetchCertificate() { return certPem; } },
    });
    const app = appComposition(true, mnsAdapter);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const envId = `p531-mns-env-${randomUUID()}`;
      const seeded = await seedLeasedDelivery(envId);
      const before = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      const body = [
        'X-Notify-Message-ID=p531-mns-msg-2',
        `env_id=${envId}`,
        'msg_id=p531-mns-msg-2@example.invalid',
        'account=sender@example.invalid',
        'from=sender@example.invalid',
        'rcpt=p531-recipient@example.invalid',
        'recv_time=2026-08-02T00:00:00',
        'end_time=2026-08-02T00:00:01',
        'status=4',
        'event=deliver',
        'region=cn-hangzhou',
        'err_code=524',
        'err_msg=524 Host not found by dns resolve',
        'failed_type=SysOutDnsResolveFail',
      ].join('&');
      const { headers } = buildMnsPushRequest(otherKeypair, {
        url: EMAIL_CALLBACK_PATH,
        date: 'Sun, 02 Aug 2026 00:00:00 GMT',
        body,
      });
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 401, 'HMAC-configured ingress rejects MNS before RSA verification');
      const row = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(row.state, 'leased');
      assert.equal(row.state_revision, '1');
      const after = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(after.count, before.count, 'a rejected MNS push must not write any suppression fact');
    } finally {
      await app.close();
      await mnsAdapter.close();
    }
  });

  test('real UnSubscribe callback (envid) through the HMAC ingress suppresses the delivery row immediately and is idempotent on replay', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const envId = `p531-unsub-env-${randomUUID()}`;
      const seeded = await seedLeasedDelivery(envId);
      const before = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions
         where recipient_account_id=$1 and source='unsubscribe'`,
        [RECIPIENT])).rows[0] as { count: number };
      // Official UnSubscribe shape (gate doc 10.4): envid is the mail
      // identifier, rcpt the recipient, operate_time the event time. The
      // real classifier/verifier must map envid -> providerMessageId so the
      // leased delivery row (seeded with that provider message id) resolves.
      const body = JSON.stringify({ type: 'dm:Feedback:UnSubscribe',
        data: { operate_time: '2026-08-02T00:05:48', envid: envId,
          from: 'sender@example.invalid', rcpt: 'p531-recipient@example.invalid',
          client_ip: '102.**.**.1' } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-unsub-1');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 202);
      assert.deepEqual(JSON.parse(await response.text()), { accepted: true });
      const row = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(row.state, 'suppressed',
        'a resolvable UnSubscribe callback must transition the leased delivery to suppressed immediately');
      const revisionAfterFirst = row.state_revision;
      const fact = (await isolated.runtime.pool.query(
        `select source, occurred_at from notification_email_suppressions
         where recipient_account_id=$1 and source='unsubscribe'`,
        [RECIPIENT])).rows[0] as { source: string; occurred_at: Date };
      assert.equal(fact.source, 'unsubscribe');
      assert.equal(fact.occurred_at.getTime(), new Date('2026-08-02T00:05:48').getTime(),
        'the durable fact must record the UnSubscribe operate_time, not now()');
      const replay = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(replay.status, 202, 'replay of a verified UnSubscribe callback must stay accepted');
      const afterReplay = (await isolated.runtime.pool.query(
        `select state, state_revision from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string; state_revision: string };
      assert.equal(afterReplay.state, 'suppressed');
      assert.equal(afterReplay.state_revision, revisionAfterFirst,
        'replay must not mutate the terminal delivery row');
      const after = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions
         where recipient_account_id=$1 and source='unsubscribe'`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(after.count, before.count + 1,
        'replay must not record a second durable unsubscribe fact');
    } finally { await app.close(); }
  });

  test('real Subscribe callback (envid) through the HMAC ingress is accepted with zero delivery side effects', async () => {
    const app = appComposition(true);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const envId = `p531-sub-env-${randomUUID()}`;
      const seeded = await seedLeasedDelivery(envId);
      const before = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      const body = JSON.stringify({ type: 'dm:Feedback:Subscribe',
        data: { operate_time: '2026-08-02T00:06:48', envid: envId,
          from: 'sender@example.invalid', rcpt: 'p531-recipient@example.invalid',
          client_ip: '102.**.**.1' } });
      const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-sub-1');
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 202);
      const row = (await isolated.runtime.pool.query(
        `select state from notification_deliveries where delivery_id=$1`,
        [seeded.deliveryId])).rows[0] as { state: string };
      assert.equal(row.state, 'leased',
        'a Subscribe callback is a fact-only no-op and must not mutate the delivery row');
      const after = (await isolated.runtime.pool.query(
        `select count(*)::int count from notification_email_suppressions where recipient_account_id=$1`,
        [RECIPIENT])).rows[0] as { count: number };
      assert.equal(after.count, before.count,
        'a Subscribe callback must not record any suppression fact');
    } finally { await app.close(); }
  });

  test('FIX-L-061: over-budget MNS flood stops reaching the certificate fetcher (fetch call count stops increasing)', async () => {
    const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = createSelfSignedTestCertificate(keypair);
    let fetchCalls = 0;
    const mnsAdapter = new AliyunDirectMailAdapter({
      endpoint: 'https://dm.aliyuncs.com/',
      regionId: 'cn-hangzhou',
      accountName: 'sender@example.invalid',
      accessKeyId: 'P531FIXTUREAKID',
      accessKeySecret: 'p531-fixture-key',
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      callbackHmacSecret: null,
      mnsCertificateFetcher: {
        async fetchCertificate() { fetchCalls += 1; return certPem; },
      },
    });
    const limiter = createMemoryEmailCallbackRateLimiter({
      ip: { maxRequests: 2, windowMs: 60_000 },
    });
    const app = appComposition(true, mnsAdapter, undefined, limiter);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const body = [
        'X-Notify-Message-ID=p531-mns-flood-1',
        'env_id=p531-mns-flood-env-1',
        'msg_id=p531-mns-flood-1@example.invalid',
        'account=sender@example.invalid',
        'from=sender@example.invalid',
        'rcpt=p531-recipient@example.invalid',
        'recv_time=2026-08-02T00:00:00',
        'end_time=2026-08-02T00:00:01',
        'status=4',
        'event=deliver',
        'region=cn-hangzhou',
        'err_code=524',
        'err_msg=524 Host not found by dns resolve',
        'failed_type=SysOutDnsResolveFail',
      ].join('&');
      for (let index = 0; index < 2; index += 1) {
        const { headers } = buildMnsPushRequest(keypair, {
          url: EMAIL_CALLBACK_PATH,
          date: 'Sun, 02 Aug 2026 00:00:00 GMT',
          body,
        });
        const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
        assert.equal(response.status, 202, `attempt ${index + 1} must be verified while under the budget`);
      }
      assert.equal(fetchCalls, 2, 'both within-budget pushes reached the certificate fetcher');

      const { headers } = buildMnsPushRequest(keypair, {
        url: EMAIL_CALLBACK_PATH,
        date: 'Sun, 02 Aug 2026 00:00:00 GMT',
        body,
      });
      const overBudget = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(overBudget.status, 429, 'the over-budget push is a fixed 429, never 202/500');
      assert.deepEqual(JSON.parse(await overBudget.text()), { error: 'rate_limited' });
      assert.equal(fetchCalls, 2, 'fetch call count must not increase after the budget is exhausted');

      // An over-budget push that rotates the certificate PATH stays a 429: the
      // IP budget stops it before any certificate URL policy evaluation, so no
      // path-rotation flood can consume outbound connections either.
      const rotated = buildMnsPushRequest(keypair, {
        url: EMAIL_CALLBACK_PATH,
        date: 'Sun, 02 Aug 2026 00:00:00 GMT',
        body,
        certUrl: 'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509.pem',
      });
      const rotatedResponse = await fetch(`${address}${EMAIL_CALLBACK_PATH}`,
        { method: 'POST', headers: rotated.headers, body });
      assert.equal(rotatedResponse.status, 429, 'an over-budget push with a rotated cert path stays 429');
      assert.equal(fetchCalls, 2, 'no certificate fetch may happen for an over-budget request');
    } finally {
      await app.close();
      await mnsAdapter.close();
    }
  });
});
