import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
  verify as cryptoVerify,
  X509Certificate,
} from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  DIRECTMAIL_API_VERSION,
  DIRECTMAIL_DEFAULT_FORMAT,
  DIRECTMAIL_SIGNATURE_METHOD,
  DIRECTMAIL_SIGNATURE_VERSION,
  DirectMailContractError,
  buildSignedRpcQuery,
  classifyDirectMailApiError,
  classifyDirectMailEventBridgeEvent,
  classifyLegacyMnsNotificationMessage,
  classifySenderStatisticsMailDetail,
  parseLegacyMnsNotificationMessage,
  parseSingleSendMailSuccessBody,
  redactDirectMailEvidence,
  type DirectMailApiErrorFact,
} from './aliyun-directmail-contract.js';
import { redactSensitiveText } from '../telemetry/index.js';
import {
  EMAIL_BODY_MAX_BYTES,
  EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  EMAIL_SUBJECT_MAX_CHARS,
  EmailCallbackRejectedError,
  type EmailCallbackFact,
  type EmailCallbackVerificationInput,
  type EmailDeliveryOutcome,
  type EmailLookupInput,
  type EmailLookupResult,
  type EmailProviderAdapter,
  type EmailSendInput,
  type EmailSendResult,
} from '../../modules/email/index.js';

/**
 * Narrow Alibaba Cloud DirectMail provider adapter (P5-28).
 *
 * Implements the application-layer email delivery port
 * (modules/email/email-delivery-port.ts) over the frozen
 * P5-27 RPC protocol helpers (aliyun-directmail-contract.ts). This adapter
 * performs network I/O and holds credentials, but:
 * - never logs credentials, recipient addresses, subjects or bodies;
 * - classifies every outcome into success/retryable/permanent/unknown with the
 *   frozen last_error_category values;
 * - honors AbortSignal + a bounded per-request timeout (timeout/abort =>
 *   retryable provider_unavailable);
 * - supports graceful close() that aborts in-flight requests;
 * - verifies delivery-result callbacks (legacy MNS RSA-SHA1 push and the
 *   frozen EventBridge/controlled-sink HMAC envelope) and returns ONLY stable
 *   delivery facts (never creates Notifications or resource grants);
 * - never writes evidence/fixtures.
 */

/** Official MNS HTTP push Date replay window (15 minutes, past only). */
export const MNS_HTTP_PUSH_DATE_REPLAY_WINDOW_MS = 15 * 60 * 1_000;

/**
 * Bounded clock-skew tolerance for callback timestamps that are in the
 * FUTURE (m3/A3). Official semantics are 'received within N minutes AFTER
 * sent': a timestamp may be up to the past replay window old, but only a
 * small bounded skew (60s) is accepted ahead of the verification clock - a
 * timestamp further in the future is rejected as expired_timestamp. The
 * injectable `now` clock keeps tests exact.
 */
export const CALLBACK_TIMESTAMP_FUTURE_SKEW_MS = 60_000;

/** SenderStatisticsDetailByParam page size (official Length bound 1..100). */
export const LOOKUP_PAGE_SIZE = 100;
/** Bounded pagination cap: at most 10 pages (1000 rows) are aggregated per lookup. */
export const LOOKUP_MAX_PAGES = 10;
/** Bounded DirectMail RPC response budget (send/lookup JSON bodies; official responses are a few KB per page). */
export const RPC_RESPONSE_MAX_BYTES = 256 * 1024;
/** Bounded MNS signing-certificate PEM budget (X.509 certificates are a few KB). */
export const MNS_CERTIFICATE_MAX_BYTES = 64 * 1024;

export interface AliyunDirectMailAdapterOptions {
  /** DirectMail RPC endpoint (https only, no query/fragment/userinfo). */
  readonly endpoint: string;
  /** DirectMail console/EventBridge region (default cn-hangzhou). */
  readonly regionId: string;
  /** Verified DirectMail sender AccountName. */
  readonly accountName: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  /** Per-request total timeout, bounded 500..60000 ms. */
  readonly timeoutMs: number;
  /** TagName prefix prepended to the stable idempotencyKey. */
  readonly tagPrefix: string;
  /** Maximum TagName length (prefix + idempotencyKey), bounded 16..128. */
  readonly maxTagChars: number;
  /** Shared secret for the frozen X-Known-DM-* HMAC callback envelope; optional. */
  readonly callbackHmacSecret?: string | null;
  /** Past replay window for X-Known-DM-Timestamp, bounded 1000..600000 ms (default 300000). A separate 60s future clock-skew tolerance applies (CALLBACK_TIMESTAMP_FUTURE_SKEW_MS). */
  readonly callbackTimestampReplayWindowMs?: number;
  /** Accept the committed local test certificate (fixture-only seam). */
  readonly fixtureTls?: boolean;
  /** Certificate fetch seam for MNS RSA verification (default fetches + caches). */
  readonly mnsCertificateFetcher?: MnsCertificateFetcher;
  /** HTTP transport seam (unit tests script malformed responses through this). */
  readonly transport?: EmailAdapterTransport;
}

export interface AdapterTransportResponse {
  readonly httpStatus: number;
  readonly bodyText: string;
}

export interface EmailAdapterTransport {
  request(input: {
    readonly url: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly rejectUnauthorized: boolean;
  }): Promise<AdapterTransportResponse>;
}

export interface MnsCertificateFetcher {
  fetchCertificate(certUrl: string): Promise<string>;
}

class DirectMailRequestAbortedError extends Error {
  readonly abortReason: 'timeout' | 'closed' | 'external';

  constructor(abortReason: 'timeout' | 'closed' | 'external', message: string) {
    super(message);
    this.name = 'DirectMailRequestAbortedError';
    this.abortReason = abortReason;
  }
}

/** Fixed transport-level error raised when a provider response exceeds the bounded byte budget. */
class DirectMailResponseTooLargeError extends Error {
  constructor(readonly label: string, readonly maxBytes: number) {
    super(`${label} response exceeded ${maxBytes} bytes`);
    this.name = 'DirectMailResponseTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly; used by the adapter).
// ---------------------------------------------------------------------------

function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** PII/credential-safe error text: shared redactors applied to every failure path. */
export function redactEvidence(value: unknown): string {
  return redactDirectMailEvidence(redactSensitiveText(value));
}

export function buildRpcCommonParams(
  action: string,
  options: { readonly accessKeyId: string; readonly regionId: string },
): Record<string, string> {
  return {
    AccessKeyId: options.accessKeyId,
    Action: action,
    Format: DIRECTMAIL_DEFAULT_FORMAT,
    RegionId: options.regionId,
    SignatureMethod: DIRECTMAIL_SIGNATURE_METHOD,
    SignatureNonce: randomUUID(),
    SignatureVersion: DIRECTMAIL_SIGNATURE_VERSION,
    Timestamp: utcTimestamp(),
    Version: DIRECTMAIL_API_VERSION,
  };
}

export interface SingleSendMailParamsOptions {
  readonly accountName: string;
  readonly regionId: string;
  readonly accessKeyId: string;
  /** Final TagName (tagPrefix + idempotencyKey). */
  readonly tagName: string;
}

/** Frozen SingleSendMail request shape (D2/D3/D7; probe-conservative tracking settings). */
export function buildSingleSendMailParams(
  input: EmailSendInput,
  options: SingleSendMailParamsOptions,
): Record<string, string> {
  const params: Record<string, string> = {
    ...buildRpcCommonParams('SingleSendMail', options),
    AccountName: options.accountName,
    AddressType: '1',
    ReplyToAddress: 'true',
    Subject: input.message.subject,
    ToAddress: input.message.to,
    TagName: options.tagName,
    ClickTrace: '0',
    UnSubscribeLinkType: 'disabled',
    UnSubscribeFilterLevel: 'disabled',
  };
  if (input.message.textBody !== undefined) params.TextBody = input.message.textBody;
  if (input.message.htmlBody !== undefined) params.HtmlBody = input.message.htmlBody;
  return params;
}

/** SenderStatisticsDetailByParam honors the official at-most-ONE-of rule: TagName only. */
export function buildSenderStatisticsParams(
  idempotencyKey: string,
  options: { readonly accessKeyId: string; readonly regionId: string; readonly tagName: string },
  nextStart?: string,
): Record<string, string> {
  void idempotencyKey;
  return {
    ...buildRpcCommonParams('SenderStatisticsDetailByParam', options),
    TagName: options.tagName,
    Length: String(LOOKUP_PAGE_SIZE),
    ...(nextStart !== undefined && nextStart !== '' ? { NextStart: nextStart } : {}),
  };
}

export interface EmailSendValidationLimits {
  readonly tagPrefix: string;
  readonly maxTagChars: number;
}

export function validateIdempotencyKey(
  key: string,
  limits: EmailSendValidationLimits,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (typeof key !== 'string' || key.length === 0 || key.length > EMAIL_IDEMPOTENCY_KEY_MAX_CHARS) {
    return { ok: false, reason: `idempotencyKey must be 1..${EMAIL_IDEMPOTENCY_KEY_MAX_CHARS} chars` };
  }
  if (`${limits.tagPrefix}${key}`.length > limits.maxTagChars) {
    return { ok: false, reason: `TagName (tagPrefix + idempotencyKey) exceeds ${limits.maxTagChars} chars` };
  }
  return { ok: true };
}

/** Frozen code-owned template budgets (D7): Subject chars, body bytes, at least one body. */
export function validateEmailSendInput(
  input: EmailSendInput,
  limits: EmailSendValidationLimits,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const keyValidation = validateIdempotencyKey(input.idempotencyKey, limits);
  if (!keyValidation.ok) return keyValidation;
  const message = input.message;
  if (!message || typeof message.to !== 'string' || message.to.trim() === '') {
    return { ok: false, reason: 'message.to is required' };
  }
  if (typeof message.subject !== 'string' || message.subject.length === 0
      || message.subject.length > EMAIL_SUBJECT_MAX_CHARS) {
    return { ok: false, reason: `subject must be 1..${EMAIL_SUBJECT_MAX_CHARS} chars` };
  }
  const textBody = message.textBody ?? '';
  const htmlBody = message.htmlBody ?? '';
  if (textBody === '' && htmlBody === '') {
    return { ok: false, reason: 'at least one of textBody/htmlBody is required' };
  }
  if (Buffer.byteLength(textBody, 'utf8') > EMAIL_BODY_MAX_BYTES) {
    return { ok: false, reason: `textBody exceeds ${EMAIL_BODY_MAX_BYTES} bytes` };
  }
  if (Buffer.byteLength(htmlBody, 'utf8') > EMAIL_BODY_MAX_BYTES) {
    return { ok: false, reason: `htmlBody exceeds ${EMAIL_BODY_MAX_BYTES} bytes` };
  }
  return { ok: true };
}

/** Frozen error taxonomy -> port result. Provider Message text is never forwarded. */
export function mapApiErrorFactToSendResult(fact: DirectMailApiErrorFact, code: string): EmailSendResult {
  return {
    classification: fact.classification,
    providerMessageId: null,
    requestId: null,
    errorCategory: fact.lastErrorCategory,
    redactedError: redactEvidence(`DirectMail request failed: HTTP ${fact.httpStatus}${code ? ` ${code}` : ''}`),
  };
}

export function mapApiErrorFactToLookupResult(fact: DirectMailApiErrorFact, code: string): EmailLookupResult {
  return {
    classification: fact.classification,
    outcome: 'unknown',
    requestId: null,
    errorCategory: fact.lastErrorCategory,
    redactedError: redactEvidence(`DirectMail request failed: HTTP ${fact.httpStatus}${code ? ` ${code}` : ''}`),
  };
}

/**
 * SenderStatisticsDetailByParam Status -> port outcome. Reuses the frozen
 * classifySenderStatisticsMailDetail (Status 0 delivered, 2 bounce, 3 complaint)
 * and refines Status 4 to `failed` per the official API doc (Status 4 = other
 * failure, distinct from Status 2 invalid address). The P5-29 worker maps
 * bounced/complaint/failed to the frozen suppression policy (D6 treats deliver
 * status 2/4 as bounce).
 */
export function classifyLookupDetailOutcome(detail: Readonly<Record<string, unknown>>): EmailDeliveryOutcome {
  const base = classifySenderStatisticsMailDetail(detail);
  if (base === 'bounced' && Number(detail.Status) === 4) return 'failed';
  if (base === 'bounced') return 'bounced';
  if (base === 'delivered') return 'delivered';
  if (base === 'complaint') return 'complaint';
  return 'unknown';
}

export interface LookupDetailFact {
  readonly outcome: EmailDeliveryOutcome;
  /** Provider event time in epoch ms; null when the row carries no reliable time. */
  readonly eventTimeMs: number | null;
  readonly errorClassification: string | null;
}

export type LookupFailureOutcome = 'bounced' | 'complaint' | 'failed';

export type LookupAggregationResult =
  | { readonly kind: 'no_facts' }
  | { readonly kind: 'delivered'; readonly winner: LookupDetailFact }
  | {
    readonly kind: 'suppression';
    readonly outcome: LookupFailureOutcome;
    readonly winner: LookupDetailFact;
  }
  | { readonly kind: 'conflicting_facts' };

/**
 * Provider event time from the official row fields (UtcLastUpdateTime UNIX
 * epoch seconds/milliseconds, LastUpdateTime date-time). Naive (zone-less)
 * LastUpdateTime values are treated as UTC: the provider emits every row of a
 * lookup in the same format, so relative ordering is preserved; the absolute
 * value only matters for cross-format comparisons, which stay conservative
 * (unprovable order -> conflicting_facts). Returns null when unreliable.
 */
export function parseLookupEventTime(detail: Readonly<Record<string, unknown>>): number | null {
  const utc = detail.UtcLastUpdateTime;
  if (typeof utc === 'number' && Number.isFinite(utc)) {
    return utc > 1e12 ? utc : utc * 1000;
  }
  if (typeof utc === 'string') {
    if (/^\d{10}(?:\.\d+)?$/u.test(utc)) return Number(utc) * 1000;
    if (/^\d{13}$/u.test(utc)) return Number(utc);
  }
  const last = detail.LastUpdateTime;
  if (typeof last === 'string' && last.trim() !== '') {
    const trimmed = last.trim();
    const withoutZone = trimmed.replace(/Z$/u, '');
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(withoutZone);
    if (match) {
      return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4]), Number(match[5]), match[6] === undefined ? 0 : Number(match[6]));
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** Official per-row fields -> classified fact (Status 0/2/3/4 + provider event time). */
export function classifyLookupDetail(detail: Readonly<Record<string, unknown>>): LookupDetailFact {
  const outcome = classifyLookupDetailOutcome(detail);
  const errorClassification = typeof detail.ErrorClassification === 'string'
    ? detail.ErrorClassification : null;
  return { outcome, eventTimeMs: parseLookupEventTime(detail), errorClassification };
}

/** Deterministic tie-break precedence for suppression sources (informational + source selection). */
const LOOKUP_FAILURE_PRECEDENCE: Readonly<Record<LookupFailureOutcome, number>> =
  Object.freeze({ complaint: 3, bounced: 2, failed: 1 });

/** Latest reliably-timed fact; ties (or all-missing times) prefer the row carrying the ErrorClassification. */
function pickLatestFact(rows: readonly LookupDetailFact[]): LookupDetailFact {
  let best = rows[0]!;
  for (const row of rows.slice(1)) {
    if (factIsBetter(row, best)) best = row;
  }
  return best;
}

function factIsBetter(candidate: LookupDetailFact, current: LookupDetailFact): boolean {
  const candidateTime = candidate.eventTimeMs;
  const currentTime = current.eventTimeMs;
  if (candidateTime !== null && currentTime === null) return true;
  if (candidateTime === null && currentTime !== null) return false;
  if (candidateTime !== null && currentTime !== null && candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  // Equal reliable times or all-missing times: prefer the row carrying the
  // ErrorClassification so the pick is independent of array order.
  return candidate.errorClassification !== null && current.errorClassification === null;
}

/** Latest reliably-timed failure; ties break by deterministic precedence (complaint > bounced > failed). */
function pickLatestFailure(rows: ReadonlyArray<LookupDetailFact & { outcome: LookupFailureOutcome }>):
LookupDetailFact & { outcome: LookupFailureOutcome } {
  let best = rows[0]!;
  for (const row of rows.slice(1)) {
    if (failureIsBetter(row, best)) best = row;
  }
  return best;
}

function failureIsBetter(candidate: LookupDetailFact & { outcome: LookupFailureOutcome },
  current: LookupDetailFact & { outcome: LookupFailureOutcome }): boolean {
  const candidateTime = candidate.eventTimeMs;
  const currentTime = current.eventTimeMs;
  if (candidateTime !== null && currentTime === null) return true;
  if (candidateTime === null && currentTime !== null) return false;
  if (candidateTime !== null && currentTime !== null && candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  // Equal reliable times or all-missing times: deterministic precedence
  // (complaint > bounced > failed) keeps the source selection independent of
  // the provider array order.
  return LOOKUP_FAILURE_PRECEDENCE[candidate.outcome] > LOOKUP_FAILURE_PRECEDENCE[current.outcome];
}

/**
 * Order-independent conservative aggregation over ALL lookup rows (FIX-M-025).
 *
 * - Only rows with a verifiable outcome participate (Status 0/2/3/4; other rows
 *   carry no fact).
 * - Any provably-newer delivered fact blocks irreversible suppression based on
 *   older failures; the latest terminal state wins ONLY when the provider event
 *   time is reliable on every row of the losing side.
 * - Delivered + suppression facts with unprovable relative order return
 *   conflicting_facts so the caller dead-letters for manual review instead of
 *   suppressing or completing on unproven evidence.
 * - Failure-only rows agree on suppression regardless of order; the recorded
 *   source is the latest reliably-timed failure (deterministic precedence on
 *   ties/missing times).
 */
export function aggregateLookupFacts(facts: readonly LookupDetailFact[]): LookupAggregationResult {
  const delivered: LookupDetailFact[] = [];
  const failures: Array<LookupDetailFact & { outcome: LookupFailureOutcome }> = [];
  for (const fact of facts) {
    const outcome = fact.outcome;
    if (outcome === 'delivered') {
      delivered.push(fact);
    } else if (outcome === 'bounced' || outcome === 'complaint' || outcome === 'failed') {
      failures.push({ outcome, eventTimeMs: fact.eventTimeMs, errorClassification: fact.errorClassification });
    }
  }
  if (delivered.length === 0 && failures.length === 0) {
    // No verifiable fact: statistics may lag after send. Not an error.
    return Object.freeze({ kind: 'no_facts' });
  }
  if (delivered.length === 0) {
    const winner = pickLatestFailure(failures);
    return Object.freeze({ kind: 'suppression', outcome: winner.outcome, winner });
  }
  if (failures.length === 0) {
    return Object.freeze({ kind: 'delivered', winner: pickLatestFact(delivered) });
  }
  const newestFailure = pickLatestFailure(failures);
  const newestDelivered = pickLatestFact(delivered);
  const everyDeliveredTimed = delivered.every((row) => row.eventTimeMs !== null);
  const everyFailureTimed = failures.every((row) => row.eventTimeMs !== null);
  if (newestFailure.eventTimeMs !== null && everyDeliveredTimed
      && newestDelivered.eventTimeMs !== null
      && newestFailure.eventTimeMs > newestDelivered.eventTimeMs) {
    return Object.freeze({ kind: 'suppression', outcome: newestFailure.outcome, winner: newestFailure });
  }
  if (newestDelivered.eventTimeMs !== null && everyFailureTimed
      && newestFailure.eventTimeMs !== null
      && newestDelivered.eventTimeMs > newestFailure.eventTimeMs) {
    return Object.freeze({ kind: 'delivered', winner: newestDelivered });
  }
  return Object.freeze({ kind: 'conflicting_facts' });
}

function parseJsonBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

function extractErrorCode(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const code = (body as Record<string, unknown>).Code;
  return typeof code === 'string' ? code : '';
}

function parseLookupBody(
  bodyText: string,
): {
  readonly requestId: string | null;
  readonly mailDetail: readonly Record<string, unknown>[];
  /** Official paging continuation token (data.NextStart); null when absent. */
  readonly nextStart: string | null;
} | undefined {
  const body = parseJsonBody(bodyText);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const data = record.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const details = (data as Record<string, unknown>).mailDetail;
  if (!Array.isArray(details)) return undefined;
  const requestId = typeof record.RequestId === 'string' ? record.RequestId : null;
  const mailDetail = details
    .filter((detail): detail is Record<string, unknown> =>
      Boolean(detail) && typeof detail === 'object' && !Array.isArray(detail));
  const rawNextStart = (data as Record<string, unknown>).NextStart;
  const nextStart = typeof rawNextStart === 'string' && rawNextStart !== '' ? rawNextStart : null;
  return { requestId, mailDetail, nextStart };
}
// ---------------------------------------------------------------------------
// MNS HTTP push RSA-SHA1 verification (official doc format).
// ---------------------------------------------------------------------------

/**
 * FIX-L-061 EXACT Aliyun signing-certificate URL allowlist: the two
 * whitelisted hosts PLUS the single documented certificate filename
 * `x509_public_certificate.pem`. Any other path under a whitelisted host is
 * rejected (the previous loose prefix match let an unauthenticated flood
 * rotate paths to force cache misses and outbound fetches before RSA
 * verification). Case variants, explicit default ports, percent-encoded or
 * dot-segment paths fail the anchored literal match and stay rejected (the
 * URL is also parsed above, so only well-formed https URLs reach here).
 */
export function assertMnsCertificateUrlPrefix(certUrl: string): boolean {
  return /^https:\/\/mnstest\.oss-cn-hangzhou\.aliyuncs\.com\/x509_public_certificate\.pem$/u.test(certUrl)
    || /^https:\/\/mns-cert\.oss-cn-[a-z0-9-]+\.aliyuncs\.com\/x509_public_certificate\.pem$/u.test(certUrl);
}

function canonicalizedResourceFromUrl(url: string | undefined): string {
  if (url === undefined) return '/';
  if (url === '') throw new TypeError('MNS canonicalized resource URL must not be empty');
  // Absolute URLs keep the legacy normalization (host/port stripped via URL).
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(url)) {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }
  // Relative request target (what Fastify reports in request.url): the official
  // CanonicalizedResource is the URI path + query as received, excluding the
  // host/port and preserving percent-encoding byte-for-byte.
  const withoutFragment = url.split('#', 1)[0] ?? url;
  if (!withoutFragment.startsWith('/')) {
    throw new TypeError('MNS canonicalized resource must be an absolute URL or an origin-form request target');
  }
  return withoutFragment;
}

/**
 * StringToSign = HttpMethod \n Content-MD5 \n Content-Type \n Date \n
 * CanonicalizedMNSHeaders \n CanonicalizedResource (official MNS doc).
 */
export function buildMnsStringToSign(input: {
  readonly method: string;
  readonly url: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly contentMd5: string;
  readonly contentType: string;
  readonly date: string;
}): string {
  const canonicalHeaders = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value ?? ''] as const)
    .filter(([name]) => name.startsWith('x-mns-'))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
  return [
    input.method,
    input.contentMd5,
    input.contentType,
    input.date,
    canonicalHeaders,
    canonicalizedResourceFromUrl(input.url),
  ].join('\n');
}

/**
 * Reads an HTTPS response body under a hard byte cap (FIX-L-060). The
 * Content-Length header is only a cheap pre-check and is never trusted: a
 * lying header is rejected before the body is read, while a missing or wrong
 * one is caught by the cumulative stream check. Once the accumulated size
 * exceeds maxBytes the response stream is destroyed immediately, which stops
 * reading at the limit and releases the connection promptly. Bodies of exactly
 * maxBytes are accepted (boundary value).
 */
function readBoundedResponseBody(
  response: IncomingMessage,
  label: string,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      response.destroy();
      fail(new DirectMailResponseTooLargeError(label, maxBytes));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        fail(new DirectMailResponseTooLargeError(label, maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks));
    });
    response.on('error', (error: Error) => fail(error));
  });
}

/**
 * FIX-L-061 canonical certificate URL used as BOTH the cache key and the
 * request target: lowercase hostname (URL parser), default https port
 * dropped, query/fragment/userinfo stripped, exact pathname preserved.
 * Semantically-equivalent URLs (host case, `:443`, query noise) therefore
 * share ONE cache entry and can never force repeated outbound fetches.
 * Fails closed on non-https schemes (the adapter only admits https URLs).
 */
function normalizeMnsCertificateUrl(certUrl: string): string {
  const parsed = new URL(certUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('MNS certificate URL must use https');
  }
  const port = parsed.port === '' || parsed.port === '443' ? '' : `:${parsed.port}`;
  return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
}

/** HTTPS certificate fetcher with a per-URL TTL cache (cert URLs are fixed per region). */
export function createDefaultMnsCertificateFetcher(options: {
  readonly timeoutMs?: number;
  readonly rejectUnauthorized?: boolean;
  readonly cacheTtlMs?: number;
} = {}): MnsCertificateFetcher {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 3_600_000;
  const cache = new Map<string, { readonly pem: string; readonly fetchedAt: number }>();
  const agent = new Agent({ rejectUnauthorized: options.rejectUnauthorized ?? true });
  return {
    async fetchCertificate(certUrl: string): Promise<string> {
      const normalized = normalizeMnsCertificateUrl(certUrl);
      const cached = cache.get(normalized);
      if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) return cached.pem;
      const pem = await new Promise<string>((resolvePromise, rejectPromise) => {
        const request = httpsRequest(normalized, { method: 'GET', agent }, (response) => {
          readBoundedResponseBody(response, 'MNS certificate', MNS_CERTIFICATE_MAX_BYTES).then(
            (body) => {
              if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
                resolvePromise(body.toString('utf8'));
              } else {
                rejectPromise(new Error(`certificate fetch failed with HTTP ${response.statusCode ?? 0}`));
              }
            },
            rejectPromise,
          );
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('certificate fetch timed out')));
        request.on('error', rejectPromise);
        request.end();
      });
      cache.set(normalized, { pem, fetchedAt: Date.now() });
      return pem;
    },
  };
}

function safeEqualText(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

function validateAdapterOptions(options: AliyunDirectMailAdapterOptions): void {
  if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
    throw new Error('AliyunDirectMailAdapter endpoint is required');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error('AliyunDirectMailAdapter endpoint must be an absolute https URL');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
    throw new Error('AliyunDirectMailAdapter endpoint must be a clean https URL without userinfo/query/fragment');
  }
  for (const [label, value] of [
    ['regionId', options.regionId],
    ['accountName', options.accountName],
    ['accessKeyId', options.accessKeyId],
    ['accessKeySecret', options.accessKeySecret],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`AliyunDirectMailAdapter ${label} is required`);
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 500 || options.timeoutMs > 60_000) {
    throw new Error('AliyunDirectMailAdapter timeoutMs must be an integer in 500..60000');
  }
  if (typeof options.tagPrefix !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(options.tagPrefix)) {
    throw new Error('AliyunDirectMailAdapter tagPrefix must match [A-Za-z0-9_-]{1,32}');
  }
  if (!Number.isInteger(options.maxTagChars) || options.maxTagChars < 16 || options.maxTagChars > 128) {
    throw new Error('AliyunDirectMailAdapter maxTagChars must be an integer in 16..128');
  }
  const windowMs = options.callbackTimestampReplayWindowMs ?? 300_000;
  if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 600_000) {
    throw new Error('AliyunDirectMailAdapter callbackTimestampReplayWindowMs must be an integer in 1000..600000');
  }
}
export class AliyunDirectMailAdapter implements EmailProviderAdapter {
  private readonly endpointBase: string;
  private readonly regionId: string;
  private readonly accountName: string;
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly timeoutMs: number;
  private readonly tagPrefix: string;
  private readonly maxTagChars: number;
  private readonly callbackHmacSecret: string | null;
  private readonly callbackTimestampReplayWindowMs: number;
  private readonly rejectUnauthorized: boolean;
  private readonly agent: Agent;
  private readonly transport: EmailAdapterTransport;
  private readonly mnsCertificateFetcher: MnsCertificateFetcher;
  private readonly closeController = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: AliyunDirectMailAdapterOptions) {
    validateAdapterOptions(options);
    this.endpointBase = options.endpoint.replace(/\/+$/u, '');
    this.regionId = options.regionId;
    this.accountName = options.accountName;
    this.accessKeyId = options.accessKeyId;
    this.accessKeySecret = options.accessKeySecret;
    this.timeoutMs = options.timeoutMs;
    this.tagPrefix = options.tagPrefix;
    this.maxTagChars = options.maxTagChars;
    this.callbackHmacSecret = options.callbackHmacSecret ?? null;
    this.callbackTimestampReplayWindowMs = options.callbackTimestampReplayWindowMs ?? 300_000;
    this.rejectUnauthorized = options.fixtureTls === true ? false : true;
    this.agent = new Agent({ keepAlive: true, rejectUnauthorized: this.rejectUnauthorized });
    this.transport = options.transport ?? {
      request: (input) => this.performHttpsGet(input.url, input.signal),
    };
    this.mnsCertificateFetcher = options.mnsCertificateFetcher
      ?? createDefaultMnsCertificateFetcher({ rejectUnauthorized: this.rejectUnauthorized, timeoutMs: this.timeoutMs });
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    if (this.closed) {
      return {
        classification: 'retryable',
        providerMessageId: null,
        requestId: null,
        errorCategory: 'provider_unavailable',
        redactedError: redactEvidence('DirectMail adapter is closed'),
      };
    }
    const validation = validateEmailSendInput(input, {
      tagPrefix: this.tagPrefix,
      maxTagChars: this.maxTagChars,
    });
    if (!validation.ok) {
      return {
        classification: 'permanent',
        providerMessageId: null,
        requestId: null,
        errorCategory: 'invalid_contract',
        redactedError: redactEvidence(`SingleSendMail input rejected: ${validation.reason}`),
      };
    }
    const params = buildSingleSendMailParams(input, {
      accountName: this.accountName,
      regionId: this.regionId,
      accessKeyId: this.accessKeyId,
      tagName: `${this.tagPrefix}${input.idempotencyKey}`,
    });
    const url = this.buildSignedUrl(params);
    try {
      const response = await this.requestWithAbort(url, input.signal);
      if (response.httpStatus >= 200 && response.httpStatus < 300) {
        try {
          const parsed = parseSingleSendMailSuccessBody(parseJsonBody(response.bodyText));
          return {
            classification: 'success',
            providerMessageId: parsed.envId,
            requestId: parsed.requestId,
            errorCategory: null,
          };
        } catch (error) {
          if (error instanceof DirectMailContractError) {
            return {
              classification: 'permanent',
              providerMessageId: null,
              requestId: null,
              errorCategory: 'invalid_contract',
              redactedError: redactEvidence(error.message),
            };
          }
          throw error;
        }
      }
      const code = extractErrorCode(parseJsonBody(response.bodyText));
      const fact = classifyDirectMailApiError({ httpStatus: response.httpStatus, code });
      return mapApiErrorFactToSendResult(fact, code);
    } catch (error) {
      const base = this.requestFailureBase('send', error);
      return { ...base };
    }
  }

  async lookup(input: EmailLookupInput): Promise<EmailLookupResult> {
    if (this.closed) {
      return {
        classification: 'retryable',
        outcome: 'unknown',
        requestId: null,
        errorCategory: 'provider_unavailable',
        redactedError: redactEvidence('DirectMail adapter is closed'),
      };
    }
    const validation = validateIdempotencyKey(input.idempotencyKey, {
      tagPrefix: this.tagPrefix,
      maxTagChars: this.maxTagChars,
    });
    if (!validation.ok) {
      return {
        classification: 'permanent',
        outcome: 'unknown',
        requestId: null,
        errorCategory: 'invalid_contract',
        redactedError: redactEvidence(`SenderStatisticsDetailByParam input rejected: ${validation.reason}`),
      };
    }
    let requestId: string | null = null;
    const facts: LookupDetailFact[] = [];
    let nextStart: string | undefined;
    let truncated = false;
    for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
      const params = buildSenderStatisticsParams(input.idempotencyKey, {
        accessKeyId: this.accessKeyId,
        regionId: this.regionId,
        tagName: `${this.tagPrefix}${input.idempotencyKey}`,
      }, nextStart);
      const url = this.buildSignedUrl(params);
      try {
        const response = await this.requestWithAbort(url, undefined);
        if (response.httpStatus < 200 || response.httpStatus >= 300) {
          const code = extractErrorCode(parseJsonBody(response.bodyText));
          const fact = classifyDirectMailApiError({ httpStatus: response.httpStatus, code });
          return mapApiErrorFactToLookupResult(fact, code);
        }
        const parsed = parseLookupBody(response.bodyText);
        if (parsed === undefined) {
          return {
            classification: 'unknown',
            outcome: 'unknown',
            requestId: null,
            errorCategory: 'other',
            redactedError: redactEvidence('SenderStatisticsDetailByParam response is malformed'),
          };
        }
        requestId = requestId ?? parsed.requestId;
        for (const row of parsed.mailDetail) facts.push(classifyLookupDetail(row));
        const pageNext = parsed.nextStart;
        const pageFull = parsed.mailDetail.length >= LOOKUP_PAGE_SIZE;
        if (!pageFull || pageNext === null || pageNext === nextStart) break;
        if (page === LOOKUP_MAX_PAGES - 1) {
          // A continuation token is still offered after the bounded cap: the
          // aggregation may be missing facts, so no definitive outcome is safe.
          truncated = true;
          break;
        }
        nextStart = pageNext;
      } catch (error) {
        const base = this.requestFailureBase('lookup', error);
        return { ...base, outcome: 'unknown' as const };
      }
    }
    if (truncated) {
      return {
        classification: 'unknown',
        outcome: 'unknown',
        requestId,
        errorCategory: 'other',
        redactedError: redactEvidence('SenderStatisticsDetailByParam pagination exceeded the bounded cap; delivery facts may be incomplete'),
      };
    }
    const aggregate = aggregateLookupFacts(facts);
    switch (aggregate.kind) {
      case 'no_facts':
        // No matching detail row yet: statistics may lag after send. Not an error.
        return { classification: 'unknown', outcome: 'unknown', requestId, errorCategory: null };
      case 'delivered':
        return {
          classification: 'success',
          outcome: 'delivered',
          requestId,
          errorCategory: null,
          // FIX-L-062: surface the winner's provider event time so the worker
          // records it on any derived durable suppression fact instead of the
          // local reconcile clock.
          eventTimeMs: aggregate.winner.eventTimeMs,
          ...(aggregate.winner.errorClassification !== null
            ? { errorClassification: aggregate.winner.errorClassification } : {}),
        };
      case 'suppression':
        return {
          classification: 'success',
          outcome: aggregate.outcome,
          requestId,
          errorCategory: null,
          eventTimeMs: aggregate.winner.eventTimeMs,
          ...(aggregate.winner.errorClassification !== null
            ? { errorClassification: aggregate.winner.errorClassification } : {}),
        };
      case 'conflicting_facts':
        // Delivered and bounce/complaint/failed rows with no provable event
        // order: take NO irreversible action (never suppress on an unproven
        // failure, never complete delivered on an unproven success).
        return {
          classification: 'success',
          outcome: 'conflicting_facts',
          requestId,
          errorCategory: null,
          redactedError: redactEvidence('SenderStatisticsDetailByParam returned conflicting delivery facts (delivered vs bounce/complaint/failed) with no provable event order; manual review required'),
        };
    }
  }

  async verifyCallback(input: EmailCallbackVerificationInput): Promise<EmailCallbackFact> {
    const headers = this.normalizeHeaders(input);
    if (headers['x-mns-signing-cert-url'] !== undefined && this.callbackHmacSecret === null) {
      return this.verifyMnsCallback(input, headers);
    }
    if (headers['x-known-dm-signature'] !== undefined) {
      return this.verifyHmacEnvelopeCallback(input, headers);
    }
    throw new EmailCallbackRejectedError('missing_signature_headers');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort(new Error('DirectMail adapter closed'));
    const pending = [...this.inFlight];
    if (pending.length > 0) {
      const grace = new Promise<void>((resolveGrace) => {
        const timer = setTimeout(resolveGrace, 1_000);
        timer.unref();
      });
      await Promise.race([Promise.allSettled(pending), grace]);
    }
    this.agent.destroy();
  }
  // -- internals ------------------------------------------------------------

  private normalizeHeaders(
    input: EmailCallbackVerificationInput,
  ): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (result[lower] === undefined) {
        result[lower] = Array.isArray(value) ? value[0] : value;
      }
    }
    return result;
  }

  private async verifyMnsCallback(
    input: EmailCallbackVerificationInput,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<EmailCallbackFact> {
    const certUrlBase64 = headers['x-mns-signing-cert-url'] ?? '';
    let certUrl: string;
    try {
      certUrl = Buffer.from(certUrlBase64, 'base64').toString('utf8');
      void new URL(certUrl);
    } catch {
      throw new EmailCallbackRejectedError('invalid_certificate_url');
    }
    const authorization = headers.authorization;
    if (!authorization) throw new EmailCallbackRejectedError('missing_signature_headers');
    const date = headers.date ?? headers['x-mns-date'];
    if (!date) throw new EmailCallbackRejectedError('missing_signature_headers');
    const dateMs = Date.parse(date);
    const now = input.now ?? new Date();
    // Past window: the Date must be at most the 15-minute replay window old;
    // future: only a bounded clock skew (60s) is tolerated (official
    // 'received within N minutes after sent' semantics, m3/A3).
    if (Number.isNaN(dateMs)
        || now.getTime() - dateMs > MNS_HTTP_PUSH_DATE_REPLAY_WINDOW_MS
        || dateMs - now.getTime() > CALLBACK_TIMESTAMP_FUTURE_SKEW_MS) {
      throw new EmailCallbackRejectedError('expired_timestamp');
    }
    // FIX-L-061 local-cheap-check ordering: the Content-MD5 presence and
    // integrity checks are PURE-LOCAL (headers vs body) and run BEFORE the
    // certificate URL policy and the outbound certificate fetch, so a
    // tampered/MD5-less push is rejected without consuming any outbound
    // connection or crypto work. Fail closed on the legacy MNS path: a push
    // WITHOUT a Content-MD5 header leaves the body OUTSIDE the RSA
    // string-to-sign, so an on-path attacker who captures a signed push
    // could rewrite status/rcpt/err_code within the 15-minute Date window
    // and drive durable suppression or delivered transitions. The official
    // MNS doc tolerates an absent Content-MD5 ("leave blank"), but that
    // default is NOT acceptable for a surface that drives durable
    // suppression - the alternative is trusting an unsigned body. This is a
    // deliberate fail-closed decision: REJECT any MNS push that does not
    // carry a Content-MD5 header, and keep the integrity check (header vs
    // actual body MD5) for the header-present case.
    const contentMd5 = headers['content-md5'];
    if (contentMd5 === undefined || contentMd5 === '') {
      throw new EmailCallbackRejectedError('missing_content_md5');
    }
    const actual = createHash('md5').update(input.body, 'utf8').digest('base64');
    if (!safeEqualText(actual, contentMd5)) {
      throw new EmailCallbackRejectedError('signature_mismatch');
    }
    // FIX-L-061: the certificate URL policy is an EXACT allowlist (whitelisted
    // hosts + the single documented certificate filename), so an unauthenticated
    // flood cannot rotate paths under a whitelisted host to force cache misses
    // and outbound fetches. It runs after the header/time/MD5 checks and always
    // before the fetch.
    if (!assertMnsCertificateUrlPrefix(certUrl)) {
      throw new EmailCallbackRejectedError('invalid_certificate_url');
    }
    // A malformed request target must fail closed as an EmailCallbackRejectedError
    // (mapped to 401/403) and can never escape as a raw TypeError/500.
    let stringToSign: string;
    try {
      stringToSign = buildMnsStringToSign({
        method: input.method ?? 'POST',
        url: input.url,
        headers,
        contentMd5,
        contentType: headers['content-type'] ?? '',
        date,
      });
    } catch {
      throw new EmailCallbackRejectedError('signature_mismatch');
    }
    let pem: string;
    try {
      pem = await this.mnsCertificateFetcher.fetchCertificate(certUrl);
    } catch {
      throw new EmailCallbackRejectedError('invalid_certificate_url');
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      throw new EmailCallbackRejectedError('invalid_certificate_url');
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(authorization, 'base64');
    } catch {
      throw new EmailCallbackRejectedError('signature_mismatch');
    }
    let verified = false;
    try {
      verified = cryptoVerify('RSA-SHA1', Buffer.from(stringToSign, 'utf8'), cert.publicKey, signature);
    } catch {
      verified = false;
    }
    if (!verified) throw new EmailCallbackRejectedError('signature_mismatch');
    // FIX-L-059: the legacy body is classified event-first, so a status field
    // is NOT required anymore (unsubscribe/subscribe/open/click/complaint
    // pushes carry no status). The event discriminator must exist; every other
    // unprovable event/status combination is rejected as unknown below.
    const record = parseLegacyMnsNotificationMessage(input.body);
    if (record.event === undefined || record.event === '') {
      throw new EmailCallbackRejectedError('malformed_callback_body');
    }
    const classified = classifyLegacyMnsNotificationMessage(input.body);
    if (classified.outcome === 'unknown') {
      throw new EmailCallbackRejectedError('unknown_event_type');
    }
    return toCallbackFact(classified);
  }

  private async verifyHmacEnvelopeCallback(
    input: EmailCallbackVerificationInput,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<EmailCallbackFact> {
    const signature = headers['x-known-dm-signature'];
    const timestamp = headers['x-known-dm-timestamp'];
    const nonce = headers['x-known-dm-nonce'];
    if (!signature || !timestamp || !nonce) {
      throw new EmailCallbackRejectedError('missing_signature_headers');
    }
    if (this.callbackHmacSecret === null) {
      throw new EmailCallbackRejectedError('not_configured');
    }
    const timestampMs = Date.parse(timestamp);
    const now = input.now ?? new Date();
    // Past window: the timestamp must be at most callbackTimestampReplayWindowMs
    // old; future: only a bounded clock skew (60s) is tolerated (official
    // 'received within N minutes after sent' semantics, m3/A3).
    if (Number.isNaN(timestampMs)
        || now.getTime() - timestampMs > this.callbackTimestampReplayWindowMs
        || timestampMs - now.getTime() > CALLBACK_TIMESTAMP_FUTURE_SKEW_MS) {
      throw new EmailCallbackRejectedError('expired_timestamp');
    }
    const expected = createHmac('sha256', this.callbackHmacSecret)
      .update(`${input.body}\n${timestamp}\n${nonce}`, 'utf8')
      .digest('base64');
    if (!safeEqualText(expected, signature)) {
      throw new EmailCallbackRejectedError('signature_mismatch');
    }
    let event: unknown;
    try {
      event = JSON.parse(input.body);
    } catch {
      throw new EmailCallbackRejectedError('malformed_callback_body');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new EmailCallbackRejectedError('malformed_callback_body');
    }
    const classified = classifyDirectMailEventBridgeEvent(event as Readonly<Record<string, unknown>>);
    if (classified.outcome === 'unknown' || classified.source === 'unknown') {
      throw new EmailCallbackRejectedError('unknown_event_type');
    }
    return toCallbackFact(classified);
  }

  private buildSignedUrl(params: Record<string, string>): string {
    const query = buildSignedRpcQuery({
      params,
      accessKeySecret: this.accessKeySecret,
      httpMethod: 'GET',
    });
    return `${this.endpointBase}/?${query}`;
  }

  private performHttpsGet(url: string, signal: AbortSignal): Promise<AdapterTransportResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      const request = httpsRequest(url, {
        method: 'GET',
        agent: this.agent,
        signal,
        headers: { Accept: 'application/json, text/plain' },
      }, (response) => {
        readBoundedResponseBody(response, 'DirectMail RPC', RPC_RESPONSE_MAX_BYTES).then(
          (body) => {
            resolvePromise({
              httpStatus: response.statusCode ?? 0,
              bodyText: body.toString('utf8'),
            });
          },
          rejectPromise,
        );
      });
      request.on('error', rejectPromise);
      request.end();
    });
  }

  private async requestWithAbort(
    url: string,
    externalSignal: AbortSignal | undefined,
  ): Promise<AdapterTransportResponse> {
    const controller = new AbortController();
    const timeoutError = new Error(`DirectMail request exceeded ${this.timeoutMs}ms timeout`);
    const timer = setTimeout(() => controller.abort(timeoutError), this.timeoutMs);
    timer.unref();
    const signals: AbortSignal[] = [controller.signal, this.closeController.signal];
    if (externalSignal !== undefined) signals.push(externalSignal);
    const combined = AbortSignal.any(signals);
    const promise = this.transport.request({
      url,
      signal: combined,
      timeoutMs: this.timeoutMs,
      rejectUnauthorized: this.rejectUnauthorized,
    }).finally(() => {
      this.inFlight.delete(promise);
      clearTimeout(timer);
    });
    this.inFlight.add(promise);
    try {
      return await promise;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DirectMailRequestAbortedError('timeout', timeoutError.message);
      }
      if (this.closeController.signal.aborted) {
        throw new DirectMailRequestAbortedError('closed', 'DirectMail adapter closed while request in flight');
      }
      if (externalSignal?.aborted) {
        throw new DirectMailRequestAbortedError('external', 'request aborted by caller');
      }
      throw error;
    }
  }

  private requestFailureBase(
    operation: string,
    error: unknown,
  ): {
    readonly classification: 'retryable';
    readonly providerMessageId: null;
    readonly requestId: null;
    readonly errorCategory: 'provider_unavailable';
    readonly redactedError: string;
  } {
    if (error instanceof DirectMailResponseTooLargeError) {
      return {
        classification: 'retryable',
        providerMessageId: null,
        requestId: null,
        errorCategory: 'provider_unavailable',
        redactedError: redactEvidence(`DirectMail ${operation} response exceeded the bounded size limit`),
      };
    }
    if (error instanceof DirectMailRequestAbortedError) {
      const detail = error.abortReason === 'timeout' ? 'timeout'
        : error.abortReason === 'closed' ? 'adapter closed while request in flight'
        : 'aborted by caller';
      return {
        classification: 'retryable',
        providerMessageId: null,
        requestId: null,
        errorCategory: 'provider_unavailable',
        redactedError: redactEvidence(`DirectMail ${operation} ${detail}`),
      };
    }
    return {
      classification: 'retryable',
      providerMessageId: null,
      requestId: null,
      errorCategory: 'provider_unavailable',
      redactedError: redactEvidence(`DirectMail ${operation} failed at transport level`),
    };
  }
}

function toCallbackFact(
  classified: {
    readonly outcome: EmailDeliveryOutcome | 'unsubscribed' | 'subscribed' | 'open' | 'click';
    readonly envId?: string;
    readonly messageId?: string;
    readonly rcpt?: string;
    readonly occurredAt?: string;
    readonly tag?: string;
  },
): EmailCallbackFact {
  // FblReport complaints arrive through the shared slots: the classifier maps
  // block_email -> rcpt, message_id -> messageId and block_time/send_time ->
  // occurredAt, so the verified fact below carries recipient / providerMessageId
  // / occurredAt for complaints exactly like the other callback kinds.
  const kind = classified.outcome as EmailCallbackFact['kind'];
  return {
    kind,
    ...(classified.envId ?? classified.messageId
      ? { providerMessageId: classified.envId ?? classified.messageId } : {}),
    ...(classified.rcpt ? { recipient: classified.rcpt } : {}),
    ...(classified.occurredAt ? { occurredAt: classified.occurredAt } : {}),
    ...(classified.tag ? { tag: classified.tag } : {}),
  };
}