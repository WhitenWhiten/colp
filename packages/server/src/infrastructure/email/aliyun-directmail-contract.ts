import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Narrow, documented Alibaba Cloud DirectMail RPC contract module (P5-27 entry gate).
 *
 * Scope: pure protocol helpers only — signature algorithm, parameter
 * canonicalization, API error classification into the frozen failure taxonomy,
 * SingleSendMail success parsing, SenderStatisticsDetailByParam status mapping,
 * and delivery-result callback shape classification (EventBridge + legacy MNS).
 *
 * This module deliberately performs NO network I/O, holds NO credentials, and
 * exposes NO send/lookup operations. The future P5-28 provider adapter may import
 * these helpers; the P5-27 entry harness must never become a second production
 * mail client. All facts are grounded in the official Aliyun docs cited in
 * docs/11-phase5-email-delivery-gate.md (verified 2026-08-02).
 */

export const DIRECTMAIL_API_VERSION = '2015-11-23';
export const DIRECTMAIL_PUBLIC_ENDPOINT = 'https://dm.aliyuncs.com/';
export const DIRECTMAIL_DEFAULT_REGION_ID = 'cn-hangzhou';
export const DIRECTMAIL_SIGNATURE_METHOD = 'HMAC-SHA1';
export const DIRECTMAIL_SIGNATURE_VERSION = '1.0';
export const DIRECTMAIL_DEFAULT_FORMAT = 'JSON';

/** SingleSendMail documented field budgets. */
export const DIRECTMAIL_MAX_SUBJECT_CHARS = 100;
export const DIRECTMAIL_MAX_BODY_BYTES = 80 * 1024;
export const DIRECTMAIL_MAX_TO_ADDRESSES = 100;
export const DIRECTMAIL_MAX_TAG_CHARS = 128;
export const DIRECTMAIL_MAX_FROM_ALIAS_CHARS = 15;

/** Closed set of RPC common request parameters (Signature included for transport). */
export const DIRECTMAIL_COMMON_PARAMS: readonly string[] = Object.freeze([
  'AccessKeyId', 'Action', 'Format', 'RegionId', 'Signature', 'SignatureMethod',
  'SignatureNonce', 'SignatureVersion', 'Timestamp', 'Version',
]);

export type DirectMailClassification = 'success' | 'retryable' | 'permanent' | 'unknown';
export type DirectMailErrorCategory =
  | 'unknown_future_version'
  | 'invalid_contract'
  | 'retry_exhausted'
  | 'dependency'
  | 'provider_unavailable'
  | 'other';

/**
 * Frozen failure taxonomy. These exact values are the
 * notification_deliveries.last_error_category CHECK values
 * (migrations/202607291500_notification_operations.ts) plus the plan's
 * success/retryable/permanent/unknown classification.
 */
export const DIRECTMAIL_DELIVERY_ERROR_CATEGORIES: readonly DirectMailErrorCategory[] = Object.freeze([
  'unknown_future_version', 'invalid_contract', 'retry_exhausted',
  'dependency', 'provider_unavailable', 'other',
]);

export interface DirectMailApiErrorFact {
  readonly code: string;
  readonly httpStatus: number;
  readonly classification: DirectMailClassification;
  readonly lastErrorCategory: DirectMailErrorCategory | null;
  readonly retryable: boolean;
  readonly permanent: boolean;
  readonly authFailure: boolean;
}

function fact(
  code: string,
  httpStatus: number,
  classification: DirectMailClassification,
  lastErrorCategory: DirectMailErrorCategory | null,
  options: { readonly authFailure?: boolean } = {},
): DirectMailApiErrorFact {
  return Object.freeze({
    code,
    httpStatus,
    classification,
    lastErrorCategory,
    retryable: classification === 'retryable',
    permanent: classification === 'permanent',
    authFailure: options.authFailure ?? false,
  });
}

/**
 * Grounded error table. HTTP statuses and codes come from the official docs:
 * https://help.aliyun.com/en/direct-mail/error-codes ,
 * https://help.aliyun.com/en/document_detail/435312.html (global error codes),
 * and https://help.aliyun.com/en/direct-mail/singlesendmail .
 */
export const DIRECTMAIL_ERROR_TABLE: Readonly<Record<string, DirectMailApiErrorFact>> = Object.freeze({
  // Global RPC client errors (document_detail/435312.html).
  MissingParameter: fact('MissingParameter', 400, 'permanent', 'invalid_contract'),
  InvalidParameter: fact('InvalidParameter', 400, 'permanent', 'invalid_contract'),
  UnsupportedOperation: fact('UnsupportedOperation', 400, 'permanent', 'invalid_contract'),
  NoSuchVersion: fact('NoSuchVersion', 400, 'permanent', 'invalid_contract'),
  Throttling: fact('Throttling', 400, 'retryable', 'dependency'),
  'InvalidAccessKeyId.NotFound': fact('InvalidAccessKeyId.NotFound', 400, 'permanent', 'invalid_contract', { authFailure: true }),
  Forbidden: fact('Forbidden', 403, 'permanent', 'invalid_contract', { authFailure: true }),
  'Forbidden.RiskControl': fact('Forbidden.RiskControl', 403, 'permanent', 'invalid_contract', { authFailure: true }),
  'Forbidden.UserVerification': fact('Forbidden.UserVerification', 403, 'permanent', 'invalid_contract', { authFailure: true }),
  SignatureDoesNotMatch: fact('SignatureDoesNotMatch', 403, 'permanent', 'invalid_contract', { authFailure: true }),
  // DirectMail-specific error table alias (help.aliyun.com/en/direct-mail/error-codes).
  Signature: fact('Signature', 400, 'permanent', 'invalid_contract', { authFailure: true }),
  // Global RPC server errors.
  InternalError: fact('InternalError', 500, 'retryable', 'provider_unavailable'),
  ServiceUnavailable: fact('ServiceUnavailable', 503, 'retryable', 'provider_unavailable'),
  // SingleSendMail message-level errors (permanent; do not retry the same content).
  'InvalidMailAddress.NotFound': fact('InvalidMailAddress.NotFound', 404, 'permanent', 'invalid_contract'),
  'InvalidReceiver.NotFound': fact('InvalidReceiver.NotFound', 404, 'permanent', 'invalid_contract'),
  'InvalidReceiverName.Malformed': fact('InvalidReceiverName.Malformed', 400, 'permanent', 'invalid_contract'),
  InvalidToAddress: fact('InvalidToAddress', 400, 'permanent', 'invalid_contract'),
  'InvalidToAddress.Spam': fact('InvalidToAddress.Spam', 400, 'permanent', 'invalid_contract'),
  InvalidBody: fact('InvalidBody', 400, 'permanent', 'invalid_contract'),
  'InvalidSubject.Malformed': fact('InvalidSubject.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidFromAlias.Malformed': fact('InvalidFromAlias.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidFromALias.Malformed': fact('InvalidFromALias.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidReplyAddress.Malformed': fact('InvalidReplyAddress.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidReplyAddressAlias.Malformed': fact('InvalidReplyAddressAlias.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidMailAddressSendType.Malformed': fact('InvalidMailAddressSendType.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidMailAddressStatus.Malformed': fact('InvalidMailAddressStatus.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidMailAddressDomain.Malformed': fact('InvalidMailAddressDomain.Malformed', 400, 'permanent', 'invalid_contract'),
  'InvalidIP.NotFound': fact('InvalidIP.NotFound', 404, 'permanent', 'invalid_contract'),
  // Frequency/quota throttle surfaced as a send rejection; retryable with backoff.
  'InvalidSendMail.Spam': fact('InvalidSendMail.Spam', 400, 'retryable', 'dependency'),
});

const SUCCESS_FACT = fact('', 200, 'success', null);
const TRANSPORT_FAILURE_FACT = fact('', 0, 'retryable', 'provider_unavailable');
const UNKNOWN_FACT = fact('', 0, 'unknown', 'other');

/**
 * Classify any DirectMail API response (including transport-level failures
 * where httpStatus is 0) into the frozen taxonomy. Known codes win; unknown
 * codes fall back by HTTP status class and stay fail-closed.
 */
export function classifyDirectMailApiError(input: {
  readonly httpStatus: number;
  readonly code?: string;
  readonly message?: string;
}): DirectMailApiErrorFact {
  void input.message;
  if (input.code) {
    const known = DIRECTMAIL_ERROR_TABLE[input.code];
    if (known) return known;
  }
  if (input.httpStatus >= 200 && input.httpStatus < 300) return SUCCESS_FACT;
  if (input.httpStatus === 0) return TRANSPORT_FAILURE_FACT;
  if (input.httpStatus === 429) return fact('Throttling', 429, 'retryable', 'dependency');
  if (input.httpStatus >= 500) {
    return fact(`HTTP_${input.httpStatus}`, input.httpStatus, 'retryable', 'provider_unavailable');
  }
  if (input.httpStatus >= 400) {
    return fact(`HTTP_${input.httpStatus}`, input.httpStatus, 'permanent', 'invalid_contract');
  }
  return UNKNOWN_FACT;
}

/**
 * RFC3986 percent-encoding per the official sample
 * (URLEncoder then + -> %20, * -> %2A, %7E -> ~; encodeURIComponent leaves
 * ! ' ( ) unencoded, so they are completed here).
 */
export function aliyunRpcPercentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/gi, '~')
    .replace(/[!'()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonical query: sorted percent-encoded k=v pairs joined by &, excluding Signature. */
export function canonicalizeRpcQuery(
  params: Readonly<Record<string, string | number | boolean>>,
): string {
  return Object.keys(params)
    .filter((key) => key !== 'Signature')
    .sort()
    .map((key) => `${aliyunRpcPercentEncode(key)}=${aliyunRpcPercentEncode(String(params[key]))}`)
    .join('&');
}

/**
 * RPC signature:
 * Base64(HMAC-SHA1(StringToSign, AccessKeySecret + "&")) with
 * StringToSign = HTTPMethod & percentEncode("/") & percentEncode(canonicalQuery).
 */
export function signRpcRequest(input: {
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly accessKeySecret: string;
  readonly httpMethod?: 'GET' | 'POST';
}): string {
  const canonical = canonicalizeRpcQuery(input.params);
  const stringToSign = `${input.httpMethod ?? 'GET'}&${aliyunRpcPercentEncode('/')}`
    + `&${aliyunRpcPercentEncode(canonical)}`;
  return createHmac('sha1', `${input.accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');
}

/** Canonical query with the RFC3986-encoded Signature appended. */
export function buildSignedRpcQuery(input: {
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly accessKeySecret: string;
  readonly httpMethod?: 'GET' | 'POST';
}): string {
  const signature = signRpcRequest(input);
  return `${canonicalizeRpcQuery(input.params)}&Signature=${aliyunRpcPercentEncode(signature)}`;
}

/** Constant-time RPC signature verification (used by the fixture and future callback adapter). */
export function verifyRpcSignature(
  params: Readonly<Record<string, string>>,
  accessKeySecret: string,
): boolean {
  const signature = params.Signature;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const received: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'Signature') continue;
    received[key] = value;
  }
  const expected = signRpcRequest({ params: received, accessKeySecret });
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(signature).digest();
  return timingSafeEqual(left, right);
}

export interface SingleSendMailSuccess {
  readonly envId: string;
  readonly requestId: string;
}

export class DirectMailContractError extends Error {
  readonly classification: DirectMailClassification;
  readonly lastErrorCategory: DirectMailErrorCategory;

  constructor(
    classification: DirectMailClassification,
    message: string,
    lastErrorCategory: DirectMailErrorCategory = 'invalid_contract',
  ) {
    super(message);
    this.name = 'DirectMailContractError';
    this.classification = classification;
    this.lastErrorCategory = lastErrorCategory;
  }
}

/** Strict SingleSendMail JSON success parse (Format=JSON). */
export function parseSingleSendMailSuccessBody(body: unknown): SingleSendMailSuccess {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DirectMailContractError('permanent',
      'SingleSendMail success body must be a JSON object', 'invalid_contract');
  }
  const record = body as Record<string, unknown>;
  const envId = typeof record.EnvId === 'string' ? record.EnvId : '';
  const requestId = typeof record.RequestId === 'string' ? record.RequestId : '';
  if (!envId || !requestId) {
    throw new DirectMailContractError('permanent',
      'SingleSendMail success body must carry EnvId and RequestId', 'invalid_contract');
  }
  return { envId, requestId };
}

export type DirectMailDeliveryOutcome =
  | 'delivered' | 'bounced' | 'complaint' | 'unsubscribed'
  | 'subscribed' | 'open' | 'click' | 'unknown';

export type DirectMailSuppressionDecision = 'suppress_recipient' | 'none';

export interface DirectMailCallbackFact {
  readonly source: 'eventbridge' | 'mns-legacy' | 'unknown';
  readonly eventType: string;
  readonly outcome: DirectMailDeliveryOutcome;
  readonly status?: string;
  readonly errorCode?: string;
  readonly failedType?: string;
  readonly envId?: string;
  readonly messageId?: string;
  readonly from?: string;
  readonly rcpt?: string;
  readonly tag?: string;
  readonly occurredAt?: string;
}

/**
 * Classify an EventBridge DirectMail event (data shapes documented in
 * https://help.aliyun.com/en/direct-mail/user-guide/set-up-eventbridge).
 */
export function classifyDirectMailEventBridgeEvent(
  event: Readonly<Record<string, unknown>>,
): DirectMailCallbackFact {
  const type = typeof event.type === 'string' ? event.type : '';
  const rawData = event.data;
  const data: Readonly<Record<string, unknown>> = rawData && typeof rawData === 'object'
    && !Array.isArray(rawData) ? rawData as Readonly<Record<string, unknown>> : {};
  const stringField = (key: string): string | undefined =>
    typeof data[key] === 'string' ? data[key] as string : undefined;
  const status = stringField('status');
  const failedType = stringField('failed_type');
  const errorCode = stringField('err_code');
  const base = {
    source: 'eventbridge' as const,
    eventType: type,
    status,
    failedType,
    errorCode,
    // Shared provider-message slot: feedback events (Subscribe/UnSubscribe)
    // document 'envid' as the official EventBridge spelling (gate doc 10.4)
    // while deliver/trace events use 'env_id'; both are accepted everywhere
    // and 'envid' wins when both are present (first-field-wins precedence,
    // same convention as operate_time/deliver_time and block_time/send_time).
    envId: stringField('envid') ?? stringField('env_id'),
    messageId: stringField('msg_id'),
    from: stringField('from'),
    rcpt: stringField('rcpt'),
    tag: stringField('tag'),
    occurredAt: stringField('operate_time') ?? stringField('deliver_time'),
  };
  switch (type) {
    case 'dm:Deliver:Succeed':
      return { ...base, outcome: 'delivered' as const };
    case 'dm:Deliver:Fail':
      return {
        ...base,
        outcome: status === '3' ? 'complaint' as const : status === '0' ? 'delivered' as const : 'bounced' as const,
      };
    case 'dm:Feedback:FblReport':
      // FblReport has its OWN documented shape (gate doc 10.4; official
      // EventBridge docs): the blocked recipient is `block_email`, the mail
      // identifier is `message_id`, and the complaint time is `block_time`
      // (fallback `send_time`), both UNIX epoch seconds. Precedence follows
      // the same first-field-wins convention as the other events
      // (`operate_time` ?? `deliver_time`): `block_time` ?? `send_time`.
      // These map into the shared rcpt/messageId/occurredAt slots so the
      // adapter verifier and the P5-29 reconciler see a uniform fact.
      return {
        ...base,
        messageId: stringField('message_id') ?? base.messageId,
        rcpt: stringField('block_email') ?? base.rcpt,
        occurredAt: stringField('block_time') ?? stringField('send_time') ?? base.occurredAt,
        outcome: 'complaint' as const,
      };
    case 'dm:Feedback:Subscribe':
      return { ...base, outcome: 'subscribed' as const };
    case 'dm:Feedback:UnSubscribe':
      return { ...base, outcome: 'unsubscribed' as const };
    case 'dm:Trace:Open':
      return { ...base, outcome: 'open' as const };
    case 'dm:Trace:Click':
      return { ...base, outcome: 'click' as const };
    default:
      return { ...base, source: 'unknown' as const, outcome: 'unknown' as const };
  }
}

/** Legacy MNS notification body: &-separated key=value pairs (documented in set-up-asynchronous-notifications). */
export function parseLegacyMnsNotificationMessage(text: string): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (const pair of text.split('&')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    record[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return record;
}

/**
 * FIX-L-059 closed mapping for the legacy MNS `deliver` event status values
 * (0 success, 2 invalid address, 3 spam, 4 failure; gate doc 10.4). The
 * `deliver` event is the ONLY legacy event whose outcome is carried by
 * `status`, so any other/missing status value is an unprovable combination and
 * fails closed to 'unknown' - never defaulted to delivered/bounced.
 */
const LEGACY_MNS_DELIVER_STATUS_OUTCOMES: Readonly<Record<string, DirectMailDeliveryOutcome>> =
  Object.freeze({
    '0': 'delivered',
    '2': 'bounced',
    '3': 'complaint',
    '4': 'bounced',
  });

/**
 * FIX-L-059 closed mapping for the remaining documented legacy MNS events
 * (set-up-asynchronous-notifications; same outcome semantics as their
 * EventBridge counterparts). These events carry no documented `status` field:
 * a non-empty status on them is an undocumented combination and fails closed.
 */
const LEGACY_MNS_EVENT_OUTCOMES: Readonly<Record<string, DirectMailDeliveryOutcome>> =
  Object.freeze({
    unsubscribe: 'unsubscribed',
    subscribe: 'subscribed',
    open: 'open',
    click: 'click',
    complaint: 'complaint',
  });

export function classifyLegacyMnsNotificationMessage(text: string): DirectMailCallbackFact {
  const record = parseLegacyMnsNotificationMessage(text);
  const event = record.event;
  const status = record.status;
  let outcome: DirectMailDeliveryOutcome;
  switch (event) {
    case 'deliver':
      // Event-first: the deliver event needs its documented status to confirm
      // the outcome. Missing/empty/undocumented status values fail closed.
      outcome = status !== undefined
        ? LEGACY_MNS_DELIVER_STATUS_OUTCOMES[status] ?? 'unknown'
        : 'unknown';
      break;
    case 'unsubscribe':
    case 'subscribe':
    case 'open':
    case 'click':
    case 'complaint':
      // Non-deliver events classify directly from the event; an empty status
      // carries no claim, but any non-empty status on them is an undocumented
      // combination (status only exists for deliver) and fails closed.
      outcome = status !== undefined && status !== ''
        ? 'unknown'
        : LEGACY_MNS_EVENT_OUTCOMES[event] ?? 'unknown';
      break;
    default:
      // Missing or unknown event: unprovable regardless of status.
      outcome = 'unknown';
  }
  return {
    source: 'mns-legacy',
    eventType: event ?? '',
    outcome,
    status,
    errorCode: record.err_code,
    failedType: record.failed_type,
    envId: record.env_id,
    messageId: record.msg_id,
    from: record.from,
    rcpt: record.rcpt,
    tag: record.tag,
    occurredAt: record.end_time ?? record.recv_time,
  };
}

/** Frozen unsubscribe/suppression policy for delivery-result callbacks. */
export function suppressionDecision(outcome: DirectMailDeliveryOutcome): DirectMailSuppressionDecision {
  if (outcome === 'bounced' || outcome === 'complaint' || outcome === 'unsubscribed') {
    return 'suppress_recipient';
  }
  return 'none';
}

/** SenderStatisticsDetailByParam mailDetail Status -> delivery outcome (0/2/3/4 per docs). */
export function classifySenderStatisticsMailDetail(
  detail: Readonly<Record<string, unknown>>,
): DirectMailDeliveryOutcome {
  const status = Number(detail.Status);
  if (status === 0) return 'delivered';
  if (status === 2 || status === 4) return 'bounced';
  if (status === 3) return 'complaint';
  return 'unknown';
}

const EVIDENCE_CREDENTIAL_KEY = /(?:accesskey|access_key|secret|token|password|credential|signature)/u;
const EVIDENCE_CONTENT_KEY = /(?:subject|body|content|text|html)/u;
const EVIDENCE_ADDRESS_KEY = /(?:toaddress|recipient|from|account|sender|rcpt|email)/u;
const EVIDENCE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const EVIDENCE_AKID = /\b(?:LTAI|AKID)[A-Za-z0-9]{8,}\b/gu;

/**
 * PII/credential redaction for evidence: never allow recipient addresses,
 * AccessKeyId material, or subject/body content markers into evidence output.
 *
 * Object input is walked recursively (JSON-parse safe) so values containing
 * escaped quotes or embedded colons can never partially evade the old
 * `"key": "value"` text regex (C3). Plain-string input is redacted with a
 * camelCase/snake/kebab-aware bare key=value matcher so evidence redaction
 * does not depend on the caller chaining redactSensitiveText (C2/C3).
 */
export function redactDirectMailEvidence(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(redactDirectMailEvidenceTree(value), null, 2) ?? '';
  }
  let text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  text = redactBareEvidenceKeyValues(text);
  text = text.replace(EVIDENCE_EMAIL, '[EMAIL REDACTED]');
  text = text.replace(EVIDENCE_AKID, '[AKID REDACTED]');
  return text;
}

function redactDirectMailEvidenceTree(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EVIDENCE_EMAIL, '[EMAIL REDACTED]')
      .replace(EVIDENCE_AKID, '[AKID REDACTED]');
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(redactDirectMailEvidenceTree);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (EVIDENCE_CREDENTIAL_KEY.test(lower)) {
        out[key] = '[CREDENTIAL REDACTED]';
        continue;
      }
      if (EVIDENCE_CONTENT_KEY.test(lower)) {
        out[key] = '[CONTENT REDACTED]';
        continue;
      }
      if (EVIDENCE_ADDRESS_KEY.test(lower)) {
        out[key] = '[EMAIL REDACTED]';
        continue;
      }
      out[key] = redactDirectMailEvidenceTree(item);
    }
    return out;
  }
  return value;
}

function redactBareEvidenceKeyValues(text: string): string {
  return text
    // camelCase/snake/kebab bare keys (C3): the marker word is the FINAL
    // component of the key (accessKeySecret=, callbackHmacSecret=, subject=).
    // The `(?<![A-Za-z0-9])` boundary keeps words that merely CONTAIN a marker
    // (secretion=, tokens=, bodyguard=) from being over-redacted.
    .replace(/(?<![A-Za-z0-9])([A-Za-z0-9_-]*(?:accesskey|access_key|secret|token|password|passwd|credential|signature))\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[CREDENTIAL REDACTED]')
    .replace(/(?<![A-Za-z0-9])([A-Za-z0-9_-]*(?:subject|body|content|text|html))\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[CONTENT REDACTED]')
    .replace(/(?<![A-Za-z0-9])([A-Za-z0-9_-]*(?:toaddress|recipient|sender|rcpt|account|email|from))\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[EMAIL REDACTED]');
}

