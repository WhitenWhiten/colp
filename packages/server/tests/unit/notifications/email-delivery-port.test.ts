import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  DIRECTMAIL_DELIVERY_ERROR_CATEGORIES,
  DIRECTMAIL_ERROR_TABLE,
  DIRECTMAIL_MAX_BODY_BYTES,
  DIRECTMAIL_MAX_SUBJECT_CHARS,
  DIRECTMAIL_MAX_TAG_CHARS,
  classifyDirectMailApiError,
} from '../../../src/infrastructure/email/aliyun-directmail-contract.js';
import {
  AliyunDirectMailAdapter,
  RPC_RESPONSE_MAX_BYTES,
  buildSingleSendMailParams,
  mapApiErrorFactToSendResult,
  validateEmailSendInput,
  type AliyunDirectMailAdapterOptions,
  type EmailAdapterTransport,
} from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  startScriptedTlsServer,
  streamBodyWithBackpressure,
  waitForServerResponseSettle,
  type ScriptedTlsServer,
} from '../../support/scripted-tls-server.js';
import {
  EMAIL_BODY_MAX_BYTES,
  EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  EMAIL_SUBJECT_MAX_CHARS,
  type EmailDeliveryClassification,
  type EmailDeliveryErrorCategory,
} from '../../../src/modules/notifications/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const portPath = resolve(backendRoot, 'src/modules/notifications/application/email-delivery-port.ts');
const portSource = readFileSync(portPath, 'utf8');

const SAMPLE_INPUT = {
  idempotencyKey: 'delivery-123',
  message: { to: 'recipient@example.invalid', subject: 'Hello', textBody: 'Body' },
};

function adapterOptions(overrides: Partial<AliyunDirectMailAdapterOptions> = {}): AliyunDirectMailAdapterOptions {
  return {
    endpoint: 'https://dm.aliyuncs.com/',
    regionId: 'cn-hangzhou',
    accountName: 'sender@example.invalid',
    accessKeyId: 'P528FIXTUREAKID',
    accessKeySecret: 'p528-fixture-key',
    timeoutMs: 1_000,
    tagPrefix: 'known-delivery-',
    maxTagChars: 128,
    ...overrides,
  };
}

interface FakeTransport {
  readonly transport: EmailAdapterTransport;
  readonly calls: number;
}

/** Fake transport returning scripted responses; honors abort signals. */
function fakeTransport(
  responses: readonly (() => { readonly httpStatus: number; readonly bodyText: string } | Promise<never>)[],
): FakeTransport {
  let index = 0;
  let calls = 0;
  return {
    transport: {
      async request(input) {
        calls += 1;
        if (input.signal.aborted) {
          throw input.signal.reason instanceof Error ? input.signal.reason : new Error('aborted');
        }
        const response = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        const value = response();
        if (value instanceof Promise) {
          return new Promise((resolvePromise, rejectPromise) => {
            input.signal.addEventListener('abort', () => {
              rejectPromise(input.signal.reason instanceof Error
                ? input.signal.reason : new Error('aborted'));
            }, { once: true });
            value.then(resolvePromise, rejectPromise);
          });
        }
        return value;
      },
    },
    get calls() { return calls; },
  };
}

const json = (httpStatus: number, body: unknown): { readonly httpStatus: number; readonly bodyText: string } => ({
  httpStatus,
  bodyText: JSON.stringify(body),
});

describe('P5-28 port constants stay aligned with the frozen contract', () => {
  test('port budgets match the frozen SingleSendMail budgets', () => {
    assert.equal(EMAIL_SUBJECT_MAX_CHARS, DIRECTMAIL_MAX_SUBJECT_CHARS);
    assert.equal(EMAIL_BODY_MAX_BYTES, DIRECTMAIL_MAX_BODY_BYTES);
    assert.equal(EMAIL_IDEMPOTENCY_KEY_MAX_CHARS, DIRECTMAIL_MAX_TAG_CHARS);
  });

  test('port taxonomy is exactly the frozen classification and last_error_category sets', () => {
    const classifications: readonly EmailDeliveryClassification[] = ['success', 'retryable', 'permanent', 'unknown'];
    const categories: readonly EmailDeliveryErrorCategory[] = [
      'unknown_future_version', 'invalid_contract', 'retry_exhausted', 'dependency',
      'provider_unavailable', 'other',
    ];
    assert.deepEqual([...classifications].sort(), ['permanent', 'retryable', 'success', 'unknown']);
    assert.deepEqual([...categories].sort(), [...DIRECTMAIL_DELIVERY_ERROR_CATEGORIES].sort());
  });
});

describe('P5-28 port contract is documented (dedupe, malformed responses, callback purity)', () => {
  test('port documents the app-side exactly-once precondition on the delivery row', () => {
    assert.match(portSource, /exactly-once|exactly once/iu);
    assert.match(portSource, /\(notification_id,\s*channel\)/u);
    assert.match(portSource, /unique/iu);
    assert.match(portSource, /delivery row|delivery rows?/iu);
  });

  test('port documents that retried attempts reuse the stable idempotency key', () => {
    assert.match(portSource, /reuse/iu);
    assert.match(portSource, /retry/iu);
    assert.match(portSource, /TagName/iu);
  });

  test('port documents malformed-response classification decisions', () => {
    assert.match(portSource, /permanent/iu);
    assert.match(portSource, /invalid_contract/iu);
    assert.match(portSource, /EnvId/iu);
  });

  test('port documents the lookup no-row unknown outcome and at-most-one rule', () => {
    assert.match(portSource, /SenderStatisticsDetailByParam/iu);
    assert.match(portSource, /at most one|at-most-one/iu);
    assert.match(portSource, /TagName/iu);
    assert.match(portSource, /unknown/iu);
  });

  test('port documents that callback verification returns only stable facts and never creates anything', () => {
    assert.match(portSource, /never/iu);
    assert.match(portSource, /Notification/i);
    assert.match(portSource, /fact/i);
    assert.match(portSource, /HMAC|X-Known-DM/iu);
    assert.match(portSource, /MNS/iu);
  });
});

describe('email send input validation (frozen budgets)', () => {
  test('valid input passes', () => {
    assert.deepEqual(validateEmailSendInput(SAMPLE_INPUT, { tagPrefix: 'known-delivery-', maxTagChars: 128 }), { ok: true });
    assert.deepEqual(validateEmailSendInput({
      idempotencyKey: 'x'.repeat(128),
      message: { to: 'a@example.invalid', subject: 's', htmlBody: 'h' },
    }, { tagPrefix: '', maxTagChars: 128 }), { ok: true });
  });

  test('subject budget is enforced', () => {
    const result = validateEmailSendInput({
      idempotencyKey: 'k',
      message: { to: 'a@example.invalid', subject: 'x'.repeat(101), textBody: 'b' },
    }, { tagPrefix: '', maxTagChars: 128 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /subject/u);
  });

  test('at least one body is required', () => {
    const result = validateEmailSendInput({
      idempotencyKey: 'k',
      message: { to: 'a@example.invalid', subject: 's' },
    }, { tagPrefix: '', maxTagChars: 128 });
    assert.equal(result.ok, false);
  });

  test('body byte budgets are enforced per body', () => {
    const big = 'x'.repeat(EMAIL_BODY_MAX_BYTES + 1);
    const text = validateEmailSendInput({
      idempotencyKey: 'k',
      message: { to: 'a@example.invalid', subject: 's', textBody: big },
    }, { tagPrefix: '', maxTagChars: 128 });
    assert.equal(text.ok, false);
    const html = validateEmailSendInput({
      idempotencyKey: 'k',
      message: { to: 'a@example.invalid', subject: 's', htmlBody: big },
    }, { tagPrefix: '', maxTagChars: 128 });
    assert.equal(html.ok, false);
  });

  test('idempotency key length and TagName (prefix + key) budgets are enforced', () => {
    const keyTooLong = validateEmailSendInput({
      idempotencyKey: 'x'.repeat(129),
      message: { to: 'a@example.invalid', subject: 's', textBody: 'b' },
    }, { tagPrefix: '', maxTagChars: 128 });
    assert.equal(keyTooLong.ok, false);

    const tagTooLong = validateEmailSendInput({
      idempotencyKey: 'x'.repeat(100),
      message: { to: 'a@example.invalid', subject: 's', textBody: 'b' },
    }, { tagPrefix: 'known-delivery-', maxTagChars: 100 });
    assert.equal(tagTooLong.ok, false);
  });
});

describe('SingleSendMail parameter builder follows the frozen request shape', () => {
  test('builds the frozen common + send params with TagName = prefix + idempotencyKey', () => {
    const params = buildSingleSendMailParams(SAMPLE_INPUT, {
      accountName: 'sender@example.invalid',
      regionId: 'cn-hangzhou',
      accessKeyId: 'AKID',
      tagName: 'known-delivery-delivery-123',
    });
    assert.equal(params.Action, 'SingleSendMail');
    assert.equal(params.AccountName, 'sender@example.invalid');
    assert.equal(params.AddressType, '1');
    assert.equal(params.ReplyToAddress, 'true');
    assert.equal(params.Subject, 'Hello');
    assert.equal(params.ToAddress, 'recipient@example.invalid');
    assert.equal(params.TagName, 'known-delivery-delivery-123');
    assert.equal(params.TextBody, 'Body');
    assert.equal(params.HtmlBody, undefined);
    assert.equal(params.ClickTrace, '0');
    assert.equal(params.UnSubscribeLinkType, 'disabled');
    assert.equal(params.UnSubscribeFilterLevel, 'disabled');
    assert.equal(params.Format, 'JSON');
    assert.equal(params.Version, '2015-11-23');
    assert.equal(params.RegionId, 'cn-hangzhou');
    assert.ok(params.SignatureNonce && params.SignatureNonce.length > 0);
    assert.ok(params.Timestamp && params.Timestamp.endsWith('Z'));
  });

  test('html-only messages set HtmlBody and omit TextBody', () => {
    const params = buildSingleSendMailParams({
      idempotencyKey: 'k',
      message: { to: 'a@example.invalid', subject: 's', htmlBody: '<p>hi</p>' },
    }, { accountName: 's@example.invalid', regionId: 'cn-hangzhou', accessKeyId: 'AKID', tagName: 'k' });
    assert.equal(params.HtmlBody, '<p>hi</p>');
    assert.equal(params.TextBody, undefined);
  });
});

describe('every frozen error-table fact maps to the port result taxonomy', () => {
  test('DIRECTMAIL_ERROR_TABLE entries map one-to-one to classification + last_error_category', () => {
    const entries = Object.entries(DIRECTMAIL_ERROR_TABLE);
    assert.ok(entries.length >= 25, `error table must be substantive, got ${entries.length}`);
    for (const [code, fact] of entries) {
      const result = mapApiErrorFactToSendResult(fact, code);
      assert.equal(result.classification, fact.classification, code);
      assert.equal(result.errorCategory, fact.lastErrorCategory, code);
      assert.equal(result.providerMessageId, null, code);
      assert.equal(result.requestId, null, code);
      assert.ok(typeof result.redactedError === 'string' && result.redactedError.length > 0, code);
      assert.doesNotMatch(result.redactedError ?? '', /p528-fixture-key/u);
    }
  });

  test('unknown codes fall back fail-closed by HTTP status class', () => {
    const cases: ReadonlyArray<readonly [number, EmailDeliveryClassification, EmailDeliveryErrorCategory | null]> = [
      [429, 'retryable', 'dependency'],
      [500, 'retryable', 'provider_unavailable'],
      [503, 'retryable', 'provider_unavailable'],
      [502, 'retryable', 'provider_unavailable'],
      [400, 'permanent', 'invalid_contract'],
      [403, 'permanent', 'invalid_contract'],
      [404, 'permanent', 'invalid_contract'],
      [418, 'permanent', 'invalid_contract'],
      [302, 'unknown', 'other'],
      [0, 'retryable', 'provider_unavailable'],
    ];
    for (const [httpStatus, classification, category] of cases) {
      const fact = classifyDirectMailApiError({ httpStatus });
      assert.equal(fact.classification, classification, `HTTP ${httpStatus}`);
      assert.equal(fact.lastErrorCategory, category, `HTTP ${httpStatus}`);
    }
  });
});

describe('adapter.send classifies scripted responses', () => {
  test('2xx JSON with EnvId + RequestId is success', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'success');
      assert.equal(result.providerMessageId, 'env-1');
      assert.equal(result.requestId, 'req-1');
      assert.equal(result.errorCategory, null);
      assert.equal(result.redactedError, undefined);
    } finally {
      await adapter.close();
    }
  });

  test('2xx non-JSON or missing EnvId is permanent invalid_contract', async () => {
    for (const bodyText of ['not json', JSON.stringify({ RequestId: 'req-1' }), JSON.stringify({ EnvId: 'env-1' })]) {
      const fake = fakeTransport([() => ({ httpStatus: 200, bodyText })]);
      const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
      try {
        const result = await adapter.send(SAMPLE_INPUT);
        assert.equal(result.classification, 'permanent', bodyText);
        assert.equal(result.errorCategory, 'invalid_contract', bodyText);
        assert.equal(result.providerMessageId, null, bodyText);
        assert.doesNotMatch(result.redactedError ?? '', /recipient@example\.invalid/u);
      } finally {
        await adapter.close();
      }
    }
  });

  test('frozen provider error codes classify send results', async () => {
    const cases: ReadonlyArray<readonly [number, string, EmailDeliveryClassification, EmailDeliveryErrorCategory]> = [
      [400, 'Throttling', 'retryable', 'dependency'],
      [429, 'Throttling', 'retryable', 'dependency'],
      [500, 'InternalError', 'retryable', 'provider_unavailable'],
      [503, 'ServiceUnavailable', 'retryable', 'provider_unavailable'],
      [400, 'InvalidToAddress', 'permanent', 'invalid_contract'],
      [404, 'InvalidMailAddress.NotFound', 'permanent', 'invalid_contract'],
      [403, 'SignatureDoesNotMatch', 'permanent', 'invalid_contract'],
    ];
    for (const [httpStatus, code, classification, category] of cases) {
      const fake = fakeTransport([() => json(httpStatus, { Code: code, Message: 'x', RequestId: 'r' })]);
      const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
      try {
        const result = await adapter.send(SAMPLE_INPUT);
        assert.equal(result.classification, classification, code);
        assert.equal(result.errorCategory, category, code);
        assert.equal(result.providerMessageId, null, code);
        assert.ok(result.redactedError && result.redactedError.length > 0, code);
      } finally {
        await adapter.close();
      }
    }
  });

  test('3xx responses classify as unknown/other', async () => {
    const fake = fakeTransport([() => ({ httpStatus: 302, bodyText: '<html>redirect</html>' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'unknown');
      assert.equal(result.errorCategory, 'other');
    } finally {
      await adapter.close();
    }
  });

  test('transport failure classifies retryable provider_unavailable', async () => {
    const transport: EmailAdapterTransport = {
      async request() {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:1') as Error & { code?: string };
        error.code = 'ECONNREFUSED';
        throw error;
      },
    };
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport }));
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
    } finally {
      await adapter.close();
    }
  });

  test('timeout classifies retryable provider_unavailable', async () => {
    const fake = fakeTransport([() => new Promise<never>(() => { /* never settles */ })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport, timeoutMs: 500 }));
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.match(result.redactedError ?? '', /timeout/iu);
    } finally {
      await adapter.close();
    }
  });

  test('external pre-aborted signal classifies retryable provider_unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeTransport([() => json(200, { EnvId: 'env', RequestId: 'req' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.send({ ...SAMPLE_INPUT, signal: controller.signal });
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
    } finally {
      await adapter.close();
    }
  });

  test('reused idempotency key is a legal retry attempt: both sends reach the provider', async () => {
    const fake = fakeTransport([
      () => json(200, { EnvId: 'env-1', RequestId: 'req-1' }),
      () => json(200, { EnvId: 'env-1', RequestId: 'req-1' }),
    ]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const first = await adapter.send(SAMPLE_INPUT);
      const second = await adapter.send(SAMPLE_INPUT);
      assert.equal(first.classification, 'success');
      assert.equal(second.classification, 'success');
      assert.equal(fake.calls, 2);
    } finally {
      await adapter.close();
    }
  });

  test('send after close() is retryable provider_unavailable without provider contact', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env', RequestId: 'req' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    await adapter.close();
    const result = await adapter.send(SAMPLE_INPUT);
    assert.equal(result.classification, 'retryable');
    assert.equal(result.errorCategory, 'provider_unavailable');
    assert.equal(fake.calls, 0);
  });

  test('invalid input is rejected permanent invalid_contract before any provider contact', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env', RequestId: 'req' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.send({
        idempotencyKey: 'k',
        message: { to: '', subject: 'x'.repeat(200), textBody: 'b' },
      });
      assert.equal(result.classification, 'permanent');
      assert.equal(result.errorCategory, 'invalid_contract');
      assert.equal(fake.calls, 0);
    } finally {
      await adapter.close();
    }
  });
});

describe('adapter.lookup classifies SenderStatisticsDetailByParam responses', () => {
  const detail = (status: number, extra: Record<string, unknown> = {}) => ({
    Status: status,
    ErrorClassification: 'SendOk',
    ToAddress: 'recipient@example.invalid',
    ...extra,
  });
  const lookupBody = (mailDetail: unknown[], requestId = 'req-lookup') => ({ RequestId: requestId, data: { mailDetail } });

  test('Status 0 -> delivered with ErrorClassification preserved', async () => {
    const fake = fakeTransport([() => json(200, lookupBody([detail(0)]))]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.classification, 'success');
      assert.equal(result.outcome, 'delivered');
      assert.equal(result.errorCategory, null);
      assert.equal(result.errorClassification, 'SendOk');
      assert.equal(result.requestId, 'req-lookup');
    } finally {
      await adapter.close();
    }
  });

  test('Status 2/3/4 map to bounced/complaint/failed', async () => {
    const expectations: ReadonlyArray<readonly [number, string]> = [[2, 'bounced'], [3, 'complaint'], [4, 'failed']];
    for (const [status, outcome] of expectations) {
      const fake = fakeTransport([() => json(200, lookupBody([detail(status)]))]);
      const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
      try {
        const result = await adapter.lookup({ idempotencyKey: 'k' });
        assert.equal(result.classification, 'success', `Status ${status}`);
        assert.equal(result.outcome, outcome, `Status ${status}`);
      } finally {
        await adapter.close();
      }
    }
  });

  test('unknown Status values map to unknown outcome', async () => {
    const fake = fakeTransport([() => json(200, lookupBody([detail(99)]))]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.outcome, 'unknown');
      assert.equal(result.classification, 'unknown');
      assert.equal(result.errorCategory, null);
    } finally {
      await adapter.close();
    }
  });

  test('no matching detail row yet -> unknown outcome with null error category', async () => {
    const fake = fakeTransport([() => json(200, lookupBody([]))]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.outcome, 'unknown');
      assert.equal(result.classification, 'unknown');
      assert.equal(result.errorCategory, null);
      assert.equal(result.requestId, 'req-lookup');
    } finally {
      await adapter.close();
    }
  });

  test('malformed 2xx lookup body -> unknown/other', async () => {
    for (const bodyText of ['not json', JSON.stringify({ RequestId: 'r' }), JSON.stringify({ data: {} })]) {
      const fake = fakeTransport([() => ({ httpStatus: 200, bodyText })]);
      const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
      try {
        const result = await adapter.lookup({ idempotencyKey: 'k' });
        assert.equal(result.classification, 'unknown', bodyText);
        assert.equal(result.outcome, 'unknown', bodyText);
        assert.equal(result.errorCategory, 'other', bodyText);
      } finally {
        await adapter.close();
      }
    }
  });

  test('provider errors classify the lookup operation', async () => {
    const fake = fakeTransport([() => json(500, { Code: 'InternalError', Message: 'x', RequestId: 'r' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.equal(result.outcome, 'unknown');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-058: lookup 4xx auth errors classify permanent invalid_contract (never a no-fact unknown)', async () => {
    // A 403 signature failure means the statistics call was NOT answered: the
    // worker must not conflate it with the benign no-facts unknown (empty
    // mailDetail, errorCategory null) that proceeds to send. The frozen error
    // table maps 4xx to permanent invalid_contract for the lookup operation too.
    const fake = fakeTransport([() => json(403, { Code: 'SignatureDoesNotMatch',
      Message: 'x', RequestId: 'r' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.classification, 'permanent');
      assert.equal(result.errorCategory, 'invalid_contract');
      assert.equal(result.outcome, 'unknown');
    } finally {
      await adapter.close();
    }
  });

  test('lookup sends TagName only (official at-most-one rule)', async () => {
    let capturedUrl = '';
    const transport: EmailAdapterTransport = {
      async request(input) {
        capturedUrl = input.url;
        return json(200, lookupBody([]));
      },
    };
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport, tagPrefix: 'known-delivery-' }));
    try {
      await adapter.lookup({ idempotencyKey: 'k' });
      assert.match(capturedUrl, /Action=SenderStatisticsDetailByParam/u);
      assert.match(capturedUrl, /TagName=known-delivery-k/u);
      assert.doesNotMatch(capturedUrl, /(?:^|[?&])AccountName=/u);
      assert.doesNotMatch(capturedUrl, /(?:^|[?&])ToAddress=/u);
    } finally {
      await adapter.close();
    }
  });

  test('lookup after close() is retryable provider_unavailable', async () => {
    const fake = fakeTransport([() => json(200, lookupBody([]))]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    await adapter.close();
    const result = await adapter.lookup({ idempotencyKey: 'k' });
    assert.equal(result.classification, 'retryable');
    assert.equal(result.errorCategory, 'provider_unavailable');
    assert.equal(fake.calls, 0);
  });
});

describe('adapter.lookup aggregates ALL mailDetail rows order-independently (FIX-M-025)', () => {
  const detail = (status: number, extra: Record<string, unknown> = {}) => ({
    Status: status,
    ErrorClassification: 'SendOk',
    ToAddress: 'recipient@example.invalid',
    ...extra,
  });
  const lookupBody = (mailDetail: unknown[], nextStart?: string) => ({
    RequestId: 'req-lookup',
    data: nextStart === undefined ? { mailDetail } : { mailDetail, NextStart: nextStart },
  });
  const lookupOutcome = async (mailDetail: unknown[]) => {
    const fake = fakeTransport([() => json(200, lookupBody(mailDetail))]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      return { classification: result.classification, outcome: result.outcome,
        errorCategory: result.errorCategory, errorClassification: result.errorClassification ?? null,
        requestId: result.requestId };
    } finally {
      await adapter.close();
    }
  };

  test('[failed, delivered] and the reversed array order both resolve to delivered when the delivered fact is provably newer', async () => {
    const rows = [detail(4, { UtcLastUpdateTime: '1783037100' }), detail(0, { UtcLastUpdateTime: '1783037200' })];
    for (const mailDetail of [rows, [...rows].reverse()]) {
      const result = await lookupOutcome(mailDetail);
      assert.deepEqual(result, { classification: 'success', outcome: 'delivered',
        errorCategory: null, errorClassification: 'SendOk', requestId: 'req-lookup' },
      'an old failure must never suppress when a newer delivered fact exists');
    }
  });

  test('delivered and failure rows WITHOUT reliable provider times resolve to conflicting_facts (never suppress)', async () => {
    const result = await lookupOutcome([detail(0), detail(4)]);
    assert.deepEqual(result, { classification: 'success', outcome: 'conflicting_facts',
      errorCategory: null, errorClassification: null, requestId: 'req-lookup' });
  });

  test('a failure provably newer than every delivered row is the latest terminal and suppresses', async () => {
    const result = await lookupOutcome([detail(0, { UtcLastUpdateTime: '1783037100' }),
      detail(2, { UtcLastUpdateTime: '1783037200' })]);
    assert.equal(result.classification, 'success');
    assert.equal(result.outcome, 'bounced');
    assert.equal(result.errorCategory, null);
  });

  test('a delivered row provably newer than every failure row wins over stale failures', async () => {
    const result = await lookupOutcome([detail(4, { UtcLastUpdateTime: '1783037100' }),
      detail(0, { UtcLastUpdateTime: '1783037105' }), detail(2, { UtcLastUpdateTime: '1783037090' })]);
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.classification, 'success');
  });

  test('missing event time on one side of a conflict resolves to conflicting_facts', async () => {
    const result = await lookupOutcome([detail(0, { UtcLastUpdateTime: '1783037100' }), detail(2)]);
    assert.equal(result.outcome, 'conflicting_facts');
    assert.equal(result.classification, 'success');
  });

  test('multiple delivered rows aggregate to delivered', async () => {
    const result = await lookupOutcome([detail(0, { UtcLastUpdateTime: '1783037100' }),
      detail(0, { UtcLastUpdateTime: '1783037200' })]);
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.errorClassification, 'SendOk');
  });

  test('multiple failure rows pick the latest provider event time regardless of array order', async () => {
    const rows = [detail(4, { UtcLastUpdateTime: '1783037100' }),
      detail(2, { UtcLastUpdateTime: '1783037200' }),
      detail(3, { UtcLastUpdateTime: '1783037150' })];
    for (const mailDetail of [rows, [...rows].reverse()]) {
      const result = await lookupOutcome(mailDetail);
      assert.equal(result.outcome, 'bounced', 'the latest terminal failure (Status 2) must win');
      assert.equal(result.errorClassification, 'SendOk');
    }
  });

  test('multiple failure rows without reliable times suppress with deterministic precedence', async () => {
    assert.equal((await lookupOutcome([detail(4), detail(3)])).outcome, 'complaint');
    assert.equal((await lookupOutcome([detail(2), detail(4)])).outcome, 'bounced');
  });

  test('swapping mailDetail array order never changes the aggregated outcome', async () => {
    const pairs: ReadonlyArray<readonly [Record<string, unknown>, Record<string, unknown>]> = [
      [detail(4, { UtcLastUpdateTime: '1783037100' }), detail(0, { UtcLastUpdateTime: '1783037200' })],
      [detail(4), detail(0)],
      [detail(2, { UtcLastUpdateTime: '1783037200' }), detail(4, { UtcLastUpdateTime: '1783037100' })],
      [detail(0, { UtcLastUpdateTime: '1783037100' }), detail(3, { UtcLastUpdateTime: '1783037100' })],
    ];
    for (const [left, right] of pairs) {
      const forward = await lookupOutcome([left, right]);
      const reversed = await lookupOutcome([right, left]);
      assert.deepEqual(reversed, forward, 'aggregation must be independent of provider array order');
    }
  });

  test('LastUpdateTime official and ISO formats both parse as provider event time', async () => {
    const result = await lookupOutcome([detail(4, { LastUpdateTime: '2026-08-02 00:05' }),
      detail(0, { LastUpdateTime: '2026-08-02T00:06Z' })]);
    assert.equal(result.outcome, 'delivered', 'the ISO delivered row is newer than the official-format failure row');
  });

  test('lookup follows pagination until the continuation stops and aggregates every page', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      detail(0, { UtcLastUpdateTime: String(1783036800 + index) }));
    const fake = fakeTransport([
      () => json(200, lookupBody(pageOne, '100')),
      () => json(200, lookupBody([detail(0, { UtcLastUpdateTime: '1783036900' })])),
    ]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.classification, 'success');
      assert.equal(result.outcome, 'delivered');
      assert.equal(result.errorCategory, null);
      assert.equal(fake.calls, 2, 'a full page with a continuation token must fetch the next page');
    } finally {
      await adapter.close();
    }
  });

  test('pagination beyond the bounded page cap returns unknown/other instead of a partial aggregation', async () => {
    let page = 0;
    const fake = fakeTransport([() => json(200, lookupBody(
      Array.from({ length: 100 }, (_, index) => detail(0, { UtcLastUpdateTime: String(1783036800 + index) })),
      `page-${page++}`,
    ))]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport }));
    try {
      const result = await adapter.lookup({ idempotencyKey: 'k' });
      assert.equal(result.classification, 'unknown');
      assert.equal(result.outcome, 'unknown');
      assert.equal(result.errorCategory, 'other');
      assert.equal(fake.calls, 10, 'the adapter must stop at the bounded page cap');
    } finally {
      await adapter.close();
    }
  });

  test('port documents order-independent aggregation, pagination and conflicting_facts', () => {
    assert.match(portSource, /conflicting_facts/iu);
    assert.match(portSource, /aggregate|all rows|order-independen/iu);
    assert.match(portSource, /pag/iu);
  });
});

describe('adapter redaction keeps unique markers out of results', () => {
  test('adapter error paths never echo credential or recipient markers', async () => {
    const markerSecret = `p528_secret_${'z'.repeat(16)}`;
    const fake = fakeTransport([() => json(500, { Code: 'InternalError', Message: markerSecret, RequestId: 'r' })]);
    const adapter = new AliyunDirectMailAdapter(adapterOptions({ transport: fake.transport, accessKeySecret: markerSecret }));
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, new RegExp(markerSecret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.doesNotMatch(serialized, /recipient@example\.invalid/u);
      assert.ok(result.redactedError && result.redactedError.length > 0);
    } finally {
      await adapter.close();
    }
  });
});

describe('adapter HTTPS transport bounds DirectMail RPC response bytes (FIX-L-060)', () => {
  function rpcAdapter(server: ScriptedTlsServer): AliyunDirectMailAdapter {
    return new AliyunDirectMailAdapter(adapterOptions({
      endpoint: `${server.origin}/`,
      fixtureTls: true,
      timeoutMs: 5_000,
    }));
  }

  test('a fake oversized Content-Length is rejected before the body is read', async () => {
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(RPC_RESPONSE_MAX_BYTES + 1),
      });
      response.end('{"EnvId":"env-1","RequestId":"req-1"}');
    });
    const adapter = rpcAdapter(server);
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.equal(result.providerMessageId, null);
      assert.equal(result.redactedError, 'DirectMail send response exceeded the bounded size limit');
    } finally {
      await adapter.close();
      await server.close();
    }
  });

  test('a chunked response without Content-Length is destroyed at the byte limit', async () => {
    // 64 MiB: far larger than loopback socket buffers (~10 MiB worst case), so
    // the server is forced into backpressure and cannot complete the body
    // before the client aborts at the byte limit (deterministic early close).
    const oversized = 'x'.repeat(RPC_RESPONSE_MAX_BYTES * 256);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      await streamBodyWithBackpressure(response, oversized);
    });
    const adapter = rpcAdapter(server);
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.equal(result.providerMessageId, null);
      assert.equal(result.redactedError, 'DirectMail send response exceeded the bounded size limit');
      // The 64 MiB body cannot fit in socket buffers, so the server is still
      // mid-write when the client aborts at the byte limit: it must never
      // complete the body. Waiting lets a regression (no destroy) surface as
      // the server finishing the full oversized body instead.
      await waitForServerResponseSettle(server);
      assert.equal(server.stats.finished, false, 'the server must not complete the oversized body');
    } finally {
      await adapter.close();
      await server.close();
    }
    // The client released the connection at the byte limit; the server-side
    // 'close' event follows asynchronously (loopback round trip), so wait for
    // it before asserting.
    await waitForServerResponseSettle(server);
    assert.equal(server.stats.closedBeforeFinish, true, 'the connection must be released before the body completes');
  });

  test('a response body of exactly the byte limit succeeds', async () => {
    const body = exactSizeJsonBody(RPC_RESPONSE_MAX_BYTES);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      });
      response.end(body);
    });
    const adapter = rpcAdapter(server);
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'success');
      assert.equal(result.providerMessageId, 'env-1');
      assert.equal(result.requestId, 'req-1');
    } finally {
      await adapter.close();
      await server.close();
    }
  });

  test('a chunked body one byte over the limit is rejected', async () => {
    const body = exactSizeJsonBody(RPC_RESPONSE_MAX_BYTES + 1);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      await streamBodyWithBackpressure(response, body);
    });
    const adapter = rpcAdapter(server);
    try {
      const result = await adapter.send(SAMPLE_INPUT);
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.equal(result.providerMessageId, null);
      assert.equal(result.redactedError, 'DirectMail send response exceeded the bounded size limit');
    } finally {
      await adapter.close();
      await server.close();
    }
  });

  test('lookup maps an over-limit RPC response to the fixed retryable error', async () => {
    const oversized = 'x'.repeat(RPC_RESPONSE_MAX_BYTES * 256);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      await streamBodyWithBackpressure(response, oversized);
    });
    const adapter = rpcAdapter(server);
    try {
      const result = await adapter.lookup({ idempotencyKey: 'delivery-123' });
      assert.equal(result.classification, 'retryable');
      assert.equal(result.outcome, 'unknown');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.equal(result.redactedError, 'DirectMail lookup response exceeded the bounded size limit');
      await waitForServerResponseSettle(server);
      assert.equal(server.stats.finished, false, 'the server must not complete the oversized body');
    } finally {
      await adapter.close();
      await server.close();
    }
    await waitForServerResponseSettle(server);
    assert.equal(server.stats.closedBeforeFinish, true, 'the connection must be released before the body completes');
  });
});

/** SingleSendMail success JSON padded to an exact byte length (extra fields are ignored by the parser). */
function exactSizeJsonBody(totalBytes: number): string {
  const template = JSON.stringify({ EnvId: 'env-1', RequestId: 'req-1', padding: '' });
  // The template already carries the `padding` value's quotes, so padding to
  // the exact total needs no extra offset.
  const padding = totalBytes - Buffer.byteLength(template, 'utf8');
  assert.ok(padding >= 0, `cannot build a ${totalBytes}-byte JSON body`);
  const body = JSON.stringify({ EnvId: 'env-1', RequestId: 'req-1', padding: 'x'.repeat(padding) });
  assert.equal(Buffer.byteLength(body, 'utf8'), totalBytes);
  return body;
}

// Compile-time check: the concrete adapter implements the full port surface.
const _adapterSurface: import('../../../src/modules/notifications/index.js').EmailProviderAdapter
  = new AliyunDirectMailAdapter(adapterOptions());
void _adapterSurface;
