import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  DIRECTMAIL_API_VERSION,
  DIRECTMAIL_COMMON_PARAMS,
  DIRECTMAIL_DEFAULT_FORMAT,
  DIRECTMAIL_DEFAULT_REGION_ID,
  DIRECTMAIL_DELIVERY_ERROR_CATEGORIES,
  DIRECTMAIL_ERROR_TABLE,
  DIRECTMAIL_MAX_BODY_BYTES,
  DIRECTMAIL_MAX_FROM_ALIAS_CHARS,
  DIRECTMAIL_MAX_SUBJECT_CHARS,
  DIRECTMAIL_MAX_TAG_CHARS,
  DIRECTMAIL_MAX_TO_ADDRESSES,
  DIRECTMAIL_PUBLIC_ENDPOINT,
  DIRECTMAIL_SIGNATURE_METHOD,
  DIRECTMAIL_SIGNATURE_VERSION,
  DirectMailContractError,
  aliyunRpcPercentEncode,
  buildSignedRpcQuery,
  canonicalizeRpcQuery,
  classifyDirectMailApiError,
  classifyDirectMailEventBridgeEvent,
  classifyLegacyMnsNotificationMessage,
  classifySenderStatisticsMailDetail,
  parseLegacyMnsNotificationMessage,
  parseSingleSendMailSuccessBody,
  redactDirectMailEvidence,
  signRpcRequest,
  suppressionDecision,
  verifyRpcSignature,
} from '../../../src/infrastructure/email/aliyun-directmail-contract.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const decisionDocPath = resolve(backendRoot, 'docs/11-phase5-email-delivery-gate.md');
const migrationPath = resolve(backendRoot,
  'migrations/202607291500_notification_operations.ts');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/phase5');

const REQUIRED_DOC_FACTS = [
  'Alibaba Cloud DirectMail',
  'Aliyun DirectMail',
  '2015-11-23',
  'dm.aliyuncs.com',
  'HMAC-SHA1',
  'SingleSendMail',
  'AccountName',
  'accounts.email',
  'UnSubscribeLinkType',
  'UnSubscribeFilterLevel',
  'TagName',
  'SenderStatisticsDetailByParam',
  'EventBridge',
  'dm:Deliver:Succeed',
  'dm:Deliver:Fail',
  'dm:Feedback:FblReport',
  'dm:Feedback:Subscribe',
  'dm:Feedback:UnSubscribe',
  'dm:Trace:Open',
  'dm:Trace:Click',
  'Throttling',
  'SignatureDoesNotMatch',
  'ServiceUnavailable',
  'InternalError',
  'InvalidMailAddress.NotFound',
  'InvalidReceiver.NotFound',
  'InvalidToAddress',
  'InvalidSubject.Malformed',
  'InvalidBody',
  'InvalidFromAlias.Malformed',
  'provider_unavailable',
  'invalid_contract',
  'retry_exhausted',
  'unknown_future_version',
  'dependency',
  'other',
  'help.aliyun.com',
  'alibabacloud.com',
  'follow_activity',
  'collection_change',
  'List-Unsubscribe',
  'RFC 2369',
  'RFC 8058',
];

describe('P5-27 decision document freezes the email delivery entry gate', () => {
  const decisionDoc = readFileSync(decisionDocPath, 'utf8');

  test('decision doc exists and states the frozen provider identity and deployment mode', () => {
    assert.ok(decisionDoc.length > 2_000, 'decision doc must be substantive');
    assert.match(decisionDoc, /provider[^\n]*(?:frozen|FROZEN|唯一|冻结)/iu);
    assert.match(decisionDoc, /deployment[^\n]*(?:mode|模式)/iu);
  });

  test('decision doc covers every frozen decision area', () => {
    for (const area of [
      'sender/domain identity',
      'unsubscribe',
      'suppression',
      'bounce',
      'complaint',
      'template ownership',
      'idempotency',
      'PII retention',
      'failure taxonomy',
    ]) {
      assert.match(decisionDoc, new RegExp(area.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'),
        `decision doc must freeze: ${area}`);
    }
  });

  test('decision doc contains the frozen official API facts and doc URLs', () => {
    for (const fact of REQUIRED_DOC_FACTS) {
      assert.match(decisionDoc, new RegExp(escapeRegExp(fact), 'iu'), `doc must contain ${fact}`);
    }
    for (const url of [
      'https://help.aliyun.com/en/direct-mail/singlesendmail',
      'https://help.aliyun.com/en/direct-mail/request',
      'https://help.aliyun.com/en/direct-mail/error-codes',
      'https://help.aliyun.com/en/document_detail/435312.html',
      'https://www.alibabacloud.com/help/en/direct-mail/sample-signature-request-java',
      'https://help.aliyun.com/zh/direct-mail/api-dm-2015-11-23-senderstatisticsdetailbyparam',
      'https://help.aliyun.com/en/direct-mail/user-guide/set-up-eventbridge',
      'https://help.aliyun.com/en/direct-mail/user-guide/set-up-asynchronous-notifications',
      'https://help.aliyun.com/en/direct-mail/user-guide/unsubscribe-function-help-description',
      'https://help.aliyun.com/en/mns/developer-reference/topic-message-http-subscription-signature',
    ]) {
      assert.ok(decisionDoc.includes(url), `decision doc must cite ${url}`);
    }
  });

  test('decision doc freezes the no-native-idempotency and code-owned template strategy', () => {
    assert.match(decisionDoc, /(?:no native idempotency|native idempotency key|No native|no provider[^\n]*dedupe)/iu);
    assert.match(decisionDoc, /(?:code-owned|renderer|模板.*代码|代码.*模板)/iu);
    assert.match(decisionDoc, /not[^\n]*(?:provider[^\n]*template|template[^\n]*service)/iu);
    assert.match(decisionDoc, /TagName/iu);
    assert.match(decisionDoc, /delivery_id/iu);
  });
});

describe('P5-27 contract constants match the frozen Aliyun RPC contract', () => {
  test('API version, endpoint, signature and format constants are frozen', () => {
    assert.equal(DIRECTMAIL_API_VERSION, '2015-11-23');
    assert.equal(DIRECTMAIL_PUBLIC_ENDPOINT, 'https://dm.aliyuncs.com/');
    assert.equal(DIRECTMAIL_DEFAULT_REGION_ID, 'cn-hangzhou');
    assert.equal(DIRECTMAIL_SIGNATURE_METHOD, 'HMAC-SHA1');
    assert.equal(DIRECTMAIL_SIGNATURE_VERSION, '1.0');
    assert.equal(DIRECTMAIL_DEFAULT_FORMAT, 'JSON');
  });

  test('bounded SingleSendMail field budgets match the official docs', () => {
    assert.equal(DIRECTMAIL_MAX_SUBJECT_CHARS, 100);
    assert.equal(DIRECTMAIL_MAX_BODY_BYTES, 80 * 1024);
    assert.equal(DIRECTMAIL_MAX_TO_ADDRESSES, 100);
    assert.equal(DIRECTMAIL_MAX_TAG_CHARS, 128);
    assert.equal(DIRECTMAIL_MAX_FROM_ALIAS_CHARS, 15);
  });

  test('common request parameters are the closed documented set', () => {
    assert.deepEqual([...DIRECTMAIL_COMMON_PARAMS].sort(), [
      'AccessKeyId', 'Action', 'Format', 'RegionId', 'Signature', 'SignatureMethod',
      'SignatureNonce', 'SignatureVersion', 'Timestamp', 'Version',
    ].sort());
  });
});

describe('P5-27 failure taxonomy aligns with notification_deliveries.last_error_category', () => {
  test('contract error categories equal the migration CHECK values', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    const checkMatch = /last_error_category\s+text\s*\n?\s*check\s*\([^)]*in\s*\(([^)]*)\)/iu.exec(migration);
    assert.ok(checkMatch, 'migration must keep the last_error_category CHECK');
    const checkValues = [...checkMatch[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
    assert.deepEqual([...DIRECTMAIL_DELIVERY_ERROR_CATEGORIES], checkValues);
  });

  test('every classified API error maps to an allowed CHECK value', () => {
    for (const code of Object.keys(DIRECTMAIL_ERROR_TABLE)) {
      const fact = DIRECTMAIL_ERROR_TABLE[code];
      assert.ok(DIRECTMAIL_DELIVERY_ERROR_CATEGORIES.includes(fact.lastErrorCategory),
        `${code} maps outside the CHECK: ${fact.lastErrorCategory}`);
    }
    const fallbacks = [400, 403, 404, 429, 500, 503, 200];
    for (const httpStatus of fallbacks) {
      const fact = classifyDirectMailApiError({ httpStatus, code: 'UnknownCode.P527' });
      if (fact.classification === 'success') {
        assert.equal(fact.lastErrorCategory, null);
      } else {
        assert.ok(DIRECTMAIL_DELIVERY_ERROR_CATEGORIES.includes(fact.lastErrorCategory as never),
          `fallback ${httpStatus} maps outside the CHECK`);
      }
    }
  });

  test('error code table matches official HTTP statuses and semantics', () => {
    const expected = [
      ['Throttling', 400, 'retryable', 'dependency'],
      ['InvalidAccessKeyId.NotFound', 400, 'permanent', 'invalid_contract'],
      ['SignatureDoesNotMatch', 403, 'permanent', 'invalid_contract'],
      ['Forbidden', 403, 'permanent', 'invalid_contract'],
      ['Forbidden.RiskControl', 403, 'permanent', 'invalid_contract'],
      ['ServiceUnavailable', 503, 'retryable', 'provider_unavailable'],
      ['InternalError', 500, 'retryable', 'provider_unavailable'],
      ['InvalidMailAddress.NotFound', 404, 'permanent', 'invalid_contract'],
      ['InvalidReceiver.NotFound', 404, 'permanent', 'invalid_contract'],
      ['InvalidReceiverName.Malformed', 400, 'permanent', 'invalid_contract'],
      ['InvalidToAddress', 400, 'permanent', 'invalid_contract'],
      ['InvalidBody', 400, 'permanent', 'invalid_contract'],
      ['InvalidSubject.Malformed', 400, 'permanent', 'invalid_contract'],
      ['InvalidFromAlias.Malformed', 400, 'permanent', 'invalid_contract'],
      ['MissingParameter', 400, 'permanent', 'invalid_contract'],
    ] as const;
    for (const [code, httpStatus, classification, category] of expected) {
      const fact = DIRECTMAIL_ERROR_TABLE[code];
      assert.ok(fact, `missing error fact for ${code}`);
      assert.equal(fact.httpStatus, httpStatus, `${code} HTTP status`);
      assert.equal(fact.classification, classification, `${code} classification`);
      assert.equal(fact.lastErrorCategory, category, `${code} category`);
    }
  });

  test('classifyDirectMailApiError fallbacks are fail-closed for unknown codes', () => {
    assert.deepEqual(
      { ...classifyDirectMailApiError({ httpStatus: 429, code: 'Throttling' }) },
      { ...DIRECTMAIL_ERROR_TABLE.Throttling });
    assert.equal(classifyDirectMailApiError({ httpStatus: 200 }).classification, 'success');
    const timeout = classifyDirectMailApiError({ httpStatus: 0, code: 'P527_TIMEOUT' });
    assert.equal(timeout.classification, 'retryable');
    assert.equal(timeout.lastErrorCategory, 'provider_unavailable');
    const refused = classifyDirectMailApiError({ httpStatus: 0, code: 'P527_ECONNREFUSED' });
    assert.equal(refused.classification, 'retryable');
    assert.equal(refused.lastErrorCategory, 'provider_unavailable');
  });
});

describe('P5-27 RPC signature and canonicalization', () => {
  const KAT_PARAMS = Object.freeze({
    AccessKeyId: 'AKIDP527FIXED123456',
    Action: 'SingleSendMail',
    Format: 'JSON',
    RegionId: 'cn-hangzhou',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: '11111111-2222-3333-4444-555555555555',
    SignatureVersion: '1.0',
    Timestamp: '2026-08-02T00:00:00Z',
    Version: '2015-11-23',
    AccountName: 'known-no-reply@example.invalid',
    AddressType: '1',
    ReplyToAddress: 'true',
    Subject: 'P527 KAT subject',
    ToAddress: 'p527-recipient@example.invalid',
    TextBody: 'P527 KAT body with * ~ + and space',
  });
  const KAT_SECRET = 'P527-KAT-SIGNING-KEY';
  // Golden value computed from the documented algorithm
  // (Base64(HMAC-SHA1("GET&%2F&<percent-encoded canonical query>", "<secret>&"))).
  const KAT_GOLDEN_SIGNATURE = 'yK6GEDKNGYl1DmekNvGGecNg4Us=';

  test('RFC3986 percent-encoding matches the documented replacements', () => {
    assert.equal(aliyunRpcPercentEncode('a b*c~d+e/f'), 'a%20b%2Ac~d%2Be%2Ff');
    assert.equal(aliyunRpcPercentEncode("!'()"), '%21%27%28%29');
    assert.equal(aliyunRpcPercentEncode('known-no-reply@example.invalid'),
      'known-no-reply%40example.invalid');
    assert.equal(aliyunRpcPercentEncode('P527 中文'), 'P527%20%E4%B8%AD%E6%96%87');
  });

  test('canonical query sorts parameter names and percent-encodes values', () => {
    const canonical = canonicalizeRpcQuery(KAT_PARAMS);
    const names = canonical.split('&').map((pair) => pair.split('=', 1)[0]);
    assert.deepEqual(names, [...names].sort());
    assert.ok(canonical.includes('ToAddress=p527-recipient%40example.invalid'));
    assert.ok(canonical.includes('TextBody=P527%20KAT%20body%20with%20%2A%20~%20%2B%20and%20space'));
  });

  test('signRpcRequest matches an independent HMAC-SHA1 implementation', () => {
    const actual = signRpcRequest({ params: KAT_PARAMS, accessKeySecret: KAT_SECRET });
    const expected = independentSignature(KAT_PARAMS, KAT_SECRET, 'GET');
    assert.equal(actual, expected);
    // N1: the golden oracle is MANDATORY - an emptied constant must fail the
    // test loudly instead of silently skipping the golden comparison.
    assert.ok(KAT_GOLDEN_SIGNATURE.length > 0,
      'KAT_GOLDEN_SIGNATURE must never be emptied (the golden oracle cannot be disabled)');
    assert.equal(actual, KAT_GOLDEN_SIGNATURE);
  });

  test('buildSignedRpcQuery appends an RFC3986-encoded Signature and verifies round-trip', () => {
    const query = buildSignedRpcQuery({ params: KAT_PARAMS, accessKeySecret: KAT_SECRET });
    const params = new URLSearchParams(query);
    assert.ok(params.get('Signature'), 'Signature must be present');
    const received: Record<string, string> = {};
    for (const [key, value] of params) received[key] = value;
    assert.equal(verifyRpcSignature(received, KAT_SECRET), true);
    assert.equal(verifyRpcSignature({ ...received, Signature: 'tampered' }, KAT_SECRET), false);
    assert.equal(verifyRpcSignature(received, 'wrong-secret'), false);
  });

  test('SingleSendMail success parse is strict about EnvId/RequestId', () => {
    assert.deepEqual(parseSingleSendMailSuccessBody({ EnvId: 'env-1', RequestId: 'req-1' }),
      { envId: 'env-1', requestId: 'req-1' });
    assert.throws(() => parseSingleSendMailSuccessBody({ RequestId: 'req-1' }),
      (error: unknown) => error instanceof DirectMailContractError
        && error.classification === 'permanent'
        && error.lastErrorCategory === 'invalid_contract');
    assert.throws(() => parseSingleSendMailSuccessBody({ EnvId: 'env-1' }),
      (error: unknown) => error instanceof DirectMailContractError);
    assert.throws(() => parseSingleSendMailSuccessBody(null),
      (error: unknown) => error instanceof DirectMailContractError);
  });
});

describe('P5-27 callback event shapes and suppression semantics', () => {
  test('EventBridge delivery events classify to stable delivery facts', () => {
    const delivered = classifyDirectMailEventBridgeEvent({
      type: 'dm:Deliver:Succeed',
      data: { env_id: '60000abc', rcpt: 'p527-recipient@example.invalid',
        from: 'known-no-reply@example.invalid', status: '0', event: 'dm:Deliver:Succeed',
        failed_type: 'SendOk', tag: 'p527-delivery-success' },
    });
    assert.equal(delivered.outcome, 'delivered');
    assert.equal(delivered.envId, '60000abc');
    assert.equal(delivered.tag, 'p527-delivery-success');

    const bounced = classifyDirectMailEventBridgeEvent({
      type: 'dm:Deliver:Fail',
      data: { env_id: '60000bounce', status: '2', failed_type: 'SmtpNxBox',
        err_code: '554', event: 'dm:Deliver:Fail' },
    });
    assert.equal(bounced.outcome, 'bounced');
    assert.equal(bounced.failedType, 'SmtpNxBox');
    assert.equal(bounced.errorCode, '554');

    const spam = classifyDirectMailEventBridgeEvent({
      type: 'dm:Deliver:Fail',
      data: { status: '3', failed_type: 'SysOutRecipientReportedSpam', event: 'dm:Deliver:Fail' },
    });
    assert.equal(spam.outcome, 'complaint');

    // N11 edge cases (frozen D11 status mapping on dm:Deliver:Fail):
    // status '0' means the provider actually delivered -> 'delivered';
    // a missing status and status '4' both classify as 'bounced'.
    const zeroOnFail = classifyDirectMailEventBridgeEvent({
      type: 'dm:Deliver:Fail',
      data: { status: '0', failed_type: 'SendOk', event: 'dm:Deliver:Fail' },
    });
    assert.equal(zeroOnFail.outcome, 'delivered',
      "dm:Deliver:Fail with status '0' must classify as delivered (provider accepted)");
    const absentStatus = classifyDirectMailEventBridgeEvent({
      type: 'dm:Deliver:Fail',
      data: { failed_type: 'SmtpNxBox', event: 'dm:Deliver:Fail' },
    });
    assert.equal(absentStatus.outcome, 'bounced',
      'dm:Deliver:Fail without a status must fail closed as bounced');
    const statusFour = classifyDirectMailEventBridgeEvent({
      type: 'dm:Deliver:Fail',
      data: { status: '4', failed_type: 'SmtpNxBox', event: 'dm:Deliver:Fail' },
    });
    assert.equal(statusFour.outcome, 'bounced', "dm:Deliver:Fail with status '4' must classify as bounced");
  });

  test('EventBridge feedback events classify to subscribe/unsubscribe/complaint facts', () => {
    // The REAL FblReport shape (frozen in gate doc 10.4 / official EventBridge
    // docs): block_email is the blocked recipient, message_id the mail
    // identifier, block_time (fallback send_time) the complaint time in UNIX
    // epoch seconds. All three must survive classification because they feed
    // the durable suppression fact (P5-29).
    const complaint = classifyDirectMailEventBridgeEvent({
      type: 'dm:Feedback:FblReport',
      data: { send_time: '1726821644', send_email: 'sender@example.invalid',
        block_email: 'p527-recipient@example.invalid', subject: 'P527-SUBJECT-MARKER',
        message_id: '<fixture-msg-3@example.invalid>', block_time: '1726821667',
        fbl_isp: 'outlook', fingerprint: 'SMTPD_fixture****' },
    });
    assert.equal(complaint.outcome, 'complaint');
    assert.equal(complaint.rcpt, 'p527-recipient@example.invalid',
      'FblReport block_email must map into the recipient slot');
    assert.equal(complaint.messageId, '<fixture-msg-3@example.invalid>',
      'FblReport message_id must map into the provider message id slot');
    assert.equal(complaint.occurredAt, '1726821667',
      'FblReport block_time must win over send_time for occurredAt');
    // Documented precedence fallback: an FblReport without block_time uses
    // send_time (same first-field-wins convention as operate_time/deliver_time).
    const sendTimeFallback = classifyDirectMailEventBridgeEvent({
      type: 'dm:Feedback:FblReport',
      data: { send_time: '1726821644', block_email: 'p527-recipient@example.invalid' },
    });
    assert.equal(sendTimeFallback.occurredAt, '1726821644');
    assert.equal(sendTimeFallback.rcpt, 'p527-recipient@example.invalid');
    // The REAL EventBridge feedback shape (frozen in gate doc 10.4): the
    // mail identifier arrives as `envid` (official spelling; `env_id` also
    // accepted), plus rcpt/from/operate_time. All must survive classification
    // because envid feeds the providerMessageId that resolves the delivery
    // row and operate_time feeds the durable suppression fact (P5-29).
    const unsubscribed = classifyDirectMailEventBridgeEvent({
      type: 'dm:Feedback:UnSubscribe',
      data: { operate_time: '2024-04-29T11:25:48', envid: '60000unsub',
        from: 'known-no-reply@example.invalid', rcpt: 'p527-recipient@example.invalid',
        client_ip: '102.**.**.1' },
    });
    assert.equal(unsubscribed.outcome, 'unsubscribed');
    assert.equal(unsubscribed.envId, '60000unsub',
      'UnSubscribe envid must survive into the shared provider-message slot');
    assert.equal(unsubscribed.rcpt, 'p527-recipient@example.invalid');
    assert.equal(unsubscribed.from, 'known-no-reply@example.invalid');
    assert.equal(unsubscribed.occurredAt, '2024-04-29T11:25:48',
      'UnSubscribe operate_time must survive as occurredAt');
    const subscribed = classifyDirectMailEventBridgeEvent({
      type: 'dm:Feedback:Subscribe',
      data: { operate_time: '2024-04-29T11:26:48', envid: '60000sub',
        from: 'known-no-reply@example.invalid', rcpt: 'p527-recipient@example.invalid',
        client_ip: '102.**.**.1' },
    });
    assert.equal(subscribed.outcome, 'subscribed');
    assert.equal(subscribed.envId, '60000sub',
      'Subscribe envid must survive into the shared provider-message slot');
    assert.equal(subscribed.occurredAt, '2024-04-29T11:26:48');
    // The documented `env_id` spelling is still accepted (fallback), and
    // `envid` wins when both are present (first-field-wins precedence).
    const envIdSpelling = classifyDirectMailEventBridgeEvent({
      type: 'dm:Feedback:UnSubscribe',
      data: { operate_time: '2024-04-29T11:25:48', env_id: '60000unsub-env-id',
        rcpt: 'p527-recipient@example.invalid' },
    });
    assert.equal(envIdSpelling.envId, '60000unsub-env-id',
      'the env_id spelling must still be accepted for feedback events');
    const bothSpellings = classifyDirectMailEventBridgeEvent({
      type: 'dm:Feedback:UnSubscribe',
      data: { envid: '60000envid-wins', env_id: '60000envid-loses',
        rcpt: 'p527-recipient@example.invalid' },
    });
    assert.equal(bothSpellings.envId, '60000envid-wins',
      'envid must take precedence over env_id when both are present');
    const opened = classifyDirectMailEventBridgeEvent({ type: 'dm:Trace:Open', data: {} });
    assert.equal(opened.outcome, 'open');
    const clicked = classifyDirectMailEventBridgeEvent({ type: 'dm:Trace:Click', data: {} });
    assert.equal(clicked.outcome, 'click');
    const unknown = classifyDirectMailEventBridgeEvent({ type: 'dm:Future:Event', data: {} });
    assert.equal(unknown.outcome, 'unknown');
    assert.equal(unknown.source, 'unknown');
  });

  test('legacy MNS &-separated messages parse and classify', () => {
    const text = 'X-Notify-Message-ID=3121639760461824&env_id=12625010655'
      + '&msg_id=ac349efc-0d79-489b-affa-f178dce3e49e@example.com'
      + '&account=example@example.com&from=a***@example.net&rcpt=a1***@example.net'
      + '&recv_time=2017-03-28 19:09:49&end_time=2017-03-28 19:09:51&status=4&event=deliver'
      + '&region=cn-hangzhou&err_code=524&err_msg=524 Host not found&failed_type=SysOutDnsResolveFail';
    const record = parseLegacyMnsNotificationMessage(text);
    assert.equal(record.event, 'deliver');
    assert.equal(record.status, '4');
    assert.equal(record.failed_type, 'SysOutDnsResolveFail');
    const fact = classifyLegacyMnsNotificationMessage(text);
    assert.equal(fact.outcome, 'bounced');
    assert.equal(fact.source, 'mns-legacy');
    assert.equal(fact.errorCode, '524');
    const ok = classifyLegacyMnsNotificationMessage(
      'status=0&event=deliver&err_code=250&failed_type=SendOk');
    assert.equal(ok.outcome, 'delivered');
  });

  test('FIX-L-059: legacy MNS classification is event-first and fails closed on unproven combinations', () => {
    // The `deliver` event is the ONLY legacy event whose outcome is carried by
    // `status` (0 success, 2 invalid address, 3 spam, 4 failure, gate doc 10.4).
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=0').outcome, 'delivered');
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=2').outcome, 'bounced');
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=3').outcome, 'complaint');
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=4').outcome, 'bounced');
    // deliver without a status (or with an undocumented status value) is an
    // unprovable combination: fail closed, NEVER default to delivered/bounced.
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver').outcome, 'unknown');
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=').outcome, 'unknown');
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=9').outcome, 'unknown');
    // Non-deliver legacy events classify directly from the event (no status).
    assert.equal(classifyLegacyMnsNotificationMessage('event=unsubscribe').outcome, 'unsubscribed');
    assert.equal(classifyLegacyMnsNotificationMessage('event=subscribe').outcome, 'subscribed');
    assert.equal(classifyLegacyMnsNotificationMessage('event=open').outcome, 'open');
    assert.equal(classifyLegacyMnsNotificationMessage('event=click').outcome, 'click');
    assert.equal(classifyLegacyMnsNotificationMessage('event=complaint').outcome, 'complaint');
    // A non-empty status on a non-deliver event is an undocumented combination
    // (status only exists for deliver): conflict -> fail closed.
    assert.equal(classifyLegacyMnsNotificationMessage('event=unsubscribe&status=0').outcome, 'unknown');
    assert.equal(classifyLegacyMnsNotificationMessage('event=unsubscribe&status=4').outcome, 'unknown');
    assert.equal(classifyLegacyMnsNotificationMessage('event=subscribe&status=0').outcome, 'unknown');
    // An empty status carries no claim and stays tolerated on non-deliver events.
    assert.equal(classifyLegacyMnsNotificationMessage('event=unsubscribe&status=').outcome, 'unsubscribed');
    // Unknown or MISSING event fails closed regardless of the status value.
    assert.equal(classifyLegacyMnsNotificationMessage('status=0').outcome, 'unknown');
    assert.equal(classifyLegacyMnsNotificationMessage('status=4').outcome, 'unknown');
    assert.equal(classifyLegacyMnsNotificationMessage('event=dm:Future:Event&status=0').outcome, 'unknown');
    // eventType reports the actual event; a status-only body never fabricates `deliver`.
    assert.equal(classifyLegacyMnsNotificationMessage('status=0').eventType, '');
    assert.equal(classifyLegacyMnsNotificationMessage('event=deliver&status=4').eventType, 'deliver');
    // Suppression source accuracy follows the frozen policy: only
    // bounced/complaint/unsubscribed suppress.
    assert.equal(suppressionDecision(classifyLegacyMnsNotificationMessage('event=unsubscribe').outcome),
      'suppress_recipient');
    assert.equal(suppressionDecision(classifyLegacyMnsNotificationMessage('event=deliver&status=3').outcome),
      'suppress_recipient');
    assert.equal(suppressionDecision(classifyLegacyMnsNotificationMessage('event=deliver&status=0').outcome),
      'none');
    assert.equal(suppressionDecision(classifyLegacyMnsNotificationMessage('status=0').outcome), 'none');
  });

  test('suppression policy maps bounce/complaint/unsubscribe to suppression', () => {
    assert.equal(suppressionDecision('bounced'), 'suppress_recipient');
    assert.equal(suppressionDecision('complaint'), 'suppress_recipient');
    assert.equal(suppressionDecision('unsubscribed'), 'suppress_recipient');
    assert.equal(suppressionDecision('delivered'), 'none');
    assert.equal(suppressionDecision('open'), 'none');
    assert.equal(suppressionDecision('click'), 'none');
    assert.equal(suppressionDecision('subscribed'), 'none');
    assert.equal(suppressionDecision('unknown'), 'none');
  });

  test('SenderStatisticsDetailByParam Status maps to delivery outcomes', () => {
    assert.equal(classifySenderStatisticsMailDetail({ Status: 0 }), 'delivered');
    assert.equal(classifySenderStatisticsMailDetail({ Status: 2 }), 'bounced');
    assert.equal(classifySenderStatisticsMailDetail({ Status: 3 }), 'complaint');
    assert.equal(classifySenderStatisticsMailDetail({ Status: 4 }), 'bounced');
    assert.equal(classifySenderStatisticsMailDetail({ Status: 99 }), 'unknown');
  });

  test('C3: evidence redaction handles escaped quotes and embedded colons in JSON values', () => {
    const marker = 'P527_TRICKY_SECRET_';
    const redacted = redactDirectMailEvidence({
      callbackHmacSecret: `${marker}A\"quote\"inside`,
      accessKeySecret: `${marker}B:colon:value`,
      nested: { token: `${marker}C\\\"escaped` },
    });
    assert.doesNotMatch(redacted, /P527_TRICKY_SECRET_/u,
      'escaped-quote/colon values must never partially leak (C3)');
    assert.equal((redacted.match(/\[CREDENTIAL REDACTED\]/gu) ?? []).length, 3,
      'every credential key value must be replaced wholesale');
  });

  test('C3: bare camelCase key=value evidence lines are redacted without the redactSensitiveText chain', () => {
    const marker = 'P527_BARE_';
    const redacted = redactDirectMailEvidence(
      `callbackHmacSecret=${marker}SECRET accessKeySecret=${marker}KEY`
      + ` account=${marker}ACCOUNT@example.invalid subject=${marker}SUBJECT`);
    assert.doesNotMatch(redacted, /P527_BARE_/u, 'bare camelCase values must be redacted (C3)');
    assert.match(redacted, /callbackHmacSecret=\[CREDENTIAL REDACTED\]/u);
    assert.match(redacted, /accessKeySecret=\[CREDENTIAL REDACTED\]/u);
    assert.match(redacted, /account=\[EMAIL REDACTED\]/u);
    assert.match(redacted, /subject=\[CONTENT REDACTED\]/u);
    // Normal words survive the bare matcher.
    const plain = redactDirectMailEvidence('monkey=banana secretion=hormone tokenizer=abc');
    assert.match(plain, /monkey=banana/u);
    assert.match(plain, /secretion=hormone/u);
    assert.match(plain, /tokenizer=abc/u);
  });

  test('n4: notification_deliveries.channel is CHECK-pinned to email (constant) so the due-claim index omission is intentional', () => {
    const authorityMigration = readFileSync(resolve(backendRoot,
      'migrations/202607290200_notification_authority.ts'), 'utf8');
    assert.match(authorityMigration,
      /channel text NOT NULL CHECK \(channel IN \('email'\)\)/u,
      'the CHECK constraint must pin channel to a single constant value (n4)');
    assert.match(authorityMigration,
      /CREATE INDEX notification_deliveries_state_due_idx[\s\S]*?ON notification_deliveries\(state,next_attempt_at,delivery_id\)[\s\S]*?WHERE state IN \('pending','retryable'\)/u,
      'the due-claim index intentionally omits the constant channel column (n4)');
    const worker = readFileSync(resolve(backendRoot,
      'src/infrastructure/notifications/email-delivery-worker-postgres.ts'), 'utf8');
    assert.match(worker, /where channel='email'/u,
      'the claim query filters on the constant channel (n4)');
  });

  test('redactDirectMailEvidence removes addresses, access key IDs and markers', () => {
    const redacted = redactDirectMailEvidence({
      accessKeyId: 'AKIDP527FIXED123456',
      to: 'p527-recipient@example.invalid',
      subject: 'P527-SUBJECT-MARKER',
      body: 'P527-TEXT-BODY-MARKER',
    });
    assert.doesNotMatch(redacted, /p527-recipient@example\.invalid/u);
    assert.doesNotMatch(redacted, /AKIDP527FIXED123456/u);
    assert.doesNotMatch(redacted, /P527-SUBJECT-MARKER/u);
    assert.doesNotMatch(redacted, /P527-TEXT-BODY-MARKER/u);
    assert.match(redacted, /\[EMAIL REDACTED\]/u);
  });
});

describe('P5-27 fixtures and harness never carry credentials', () => {
  test('committed fixture JSON/manifest files contain no credential patterns', () => {
    for (const file of walkFiles(fixtureRoot)) {
      const lower = file.toLowerCase();
      if (lower.endsWith('.pem')) continue; // TLS test cert pair is documented test-only
      if (!/\.(?:json|md|txt)$/u.test(lower)) continue;
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(content, /-----BEGIN/u, `${file} must not embed PEM material`);
      assert.doesNotMatch(content, /\bAKIA[0-9A-Z]{16}\b/u, `${file} AWS key pattern`);
      assert.doesNotMatch(content, /\bLTAI[A-Za-z0-9]{12,}\b/u, `${file} Aliyun AccessKeyId pattern`);
      assert.doesNotMatch(content, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u, `${file} GitHub token`);
    }
  });

  test('every email address in fixture JSON is a .invalid/.example test address', () => {
    const manifest = readFileSync(join(fixtureRoot, 'email-delivery-gate.replay.v1.json'), 'utf8');
    const emails = manifest.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) ?? [];
    assert.ok(emails.length > 0, 'manifest should carry fixed test addresses');
    for (const email of emails) {
      assert.match(email, /\.(?:invalid|example)$/u, `test address must be non-deliverable: ${email}`);
    }
  });

  test('TLS test certificate/key live only under the documented fixture directory', () => {
    const certDir = join(fixtureRoot, 'email-entry-fixture');
    assert.ok(statSync(join(certDir, 'cert.pem')).isFile());
    assert.ok(statSync(join(certDir, 'key.pem')).isFile());
    const readme = readFileSync(join(certDir, 'README.md'), 'utf8');
    assert.match(readme, /test-only|self-signed|TEST ONLY/iu);
    for (const file of walkFiles(resolve(backendRoot, 'src'))) {
      if (!/\.(?:ts|tsx|mjs)$/u.test(file)) continue;
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(content, /-----BEGIN/u, `src file must not embed PEM: ${file}`);
    }
  });

  test('the shared contract module is not a mail client', () => {
    const contract = readFileSync(
      resolve(backendRoot, 'src/infrastructure/email/aliyun-directmail-contract.ts'), 'utf8');
    assert.doesNotMatch(contract, /node:(?:http|https|net)\b/u);
    assert.doesNotMatch(contract, /\bfetch\s*\(/u);
    assert.doesNotMatch(contract, /https?:\/\/dm\.aliyuncs\.com\/?\?/u);
    assert.doesNotMatch(contract, /\bnew\s+(?:https?\.)?(?:Agent|Client|Server)\b/iu);
    assert.doesNotMatch(contract, /ALIBABA_CLOUD_ACCESS_KEY/u);
  });
});

function independentSignature(
  params: Readonly<Record<string, string | number | boolean>>,
  accessKeySecret: string,
  httpMethod: string,
): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(String(params[key]))}`)
    .join('&');
  const stringToSign = `${httpMethod}&${rfc3986('/')}&${rfc3986(canonical)}`;
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/gi, '~');
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(path);
    return [path];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

