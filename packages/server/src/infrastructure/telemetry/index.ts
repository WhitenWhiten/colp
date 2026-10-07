import pino, { type DestinationStream, type Logger } from 'pino';

export interface Metrics {
  increment(name: string, value?: number): void;
  gauge(name: string, value: number): void;
  observe(name: string, value: number): void;
  get(name: string): number;
  observations(name: string): readonly number[];
}
export interface InMemoryMetricsOptions {
  /** Called after an increment so production can forward critical counters. */
  readonly onIncrement?: (name: string, value: number) => void;
  /** Maximum recent observations retained for each metric name. */
  readonly maxObservationsPerMetric?: number;
}

const DEFAULT_MAX_OBSERVATIONS_PER_METRIC = 1_024;

interface ObservationRing {
  readonly samples: number[];
  nextIndex: number;
  count: number;
  sum: number;
}

export interface PrometheusMetrics {
  renderPrometheus(): string;
}

export class InMemoryMetrics implements Metrics {
  private readonly values = new Map<string, number>();
  private readonly valueKinds = new Map<string, 'counter' | 'gauge'>();
  private readonly observed = new Map<string, ObservationRing>();
  private readonly observationLimit: number;

  constructor(private readonly options: InMemoryMetricsOptions = {}) {
    const limit = options.maxObservationsPerMetric ?? DEFAULT_MAX_OBSERVATIONS_PER_METRIC;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('maxObservationsPerMetric must be a positive safe integer');
    }
    this.observationLimit = limit;
  }
  increment(name: string, value = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + value);
    this.valueKinds.set(name, 'counter');
    this.options.onIncrement?.(name, value);
  }
  gauge(name: string, value: number): void {
    this.values.set(name, value);
    this.valueKinds.set(name, 'gauge');
  }
  observe(name: string, value: number): void {
    const ring = this.observed.get(name) ?? { samples: [], nextIndex: 0, count: 0, sum: 0 };
    ring.count += 1;
    ring.sum += value;
    if (ring.samples.length < this.observationLimit) {
      ring.samples.push(value);
    } else {
      ring.samples[ring.nextIndex] = value;
      ring.nextIndex = (ring.nextIndex + 1) % this.observationLimit;
    }
    this.observed.set(name, ring);
  }
  get(name: string): number { return this.values.get(name) ?? 0; }
  observations(name: string): readonly number[] {
    const ring = this.observed.get(name);
    if (!ring) return [];
    if (ring.samples.length < this.observationLimit || ring.nextIndex === 0) return [...ring.samples];
    return [...ring.samples.slice(ring.nextIndex), ...ring.samples.slice(0, ring.nextIndex)];
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, value] of [...this.values.entries()].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const metric = prometheusMetricName(name);
      lines.push(`# TYPE ${metric} ${this.valueKinds.get(name) ?? 'gauge'}`);
      lines.push(`${metric} ${prometheusNumber(value)}`);
    }
    for (const [name, ring] of [...this.observed.entries()].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const metric = prometheusMetricName(name);
      lines.push(`# TYPE ${metric} summary`);
      lines.push(`${metric}_sum ${prometheusNumber(ring.sum)}`);
      lines.push(`${metric}_count ${ring.count}`);
    }
    return `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}`;
  }
}

export function isPrometheusMetrics(metrics: Metrics): metrics is Metrics & PrometheusMetrics {
  return typeof (metrics as Partial<PrometheusMetrics>).renderPrometheus === 'function';
}

function prometheusMetricName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_:]/g, '_');
  return `known_${normalized}`;
}

function prometheusNumber(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  if (Number.isNaN(value)) return 'NaN';
  return String(value);
}
export interface Tracer { startSpan(name: string): { end(): void }; }
export class NoopTracer implements Tracer { startSpan(_name: string) { return { end() {} }; } }
const REDACTED_LOG_PATHS = [
  'req.headers.authorization', 'req.headers.cookie',
  'req.raw.headers.authorization', 'req.raw.headers.cookie',
  'authorization', 'cookie', 'databaseUrl', 'password', 'token', 'secret',
  'secretKeys', 'fingerprintKey', 'secret_envelope', '*.secretKeys', '*.fingerprintKey', '*.secret_envelope',
  'config.classification.secretKeys', 'config.classification.fingerprintKey', 'req.body.secret', 'body.secret',
  'code_verifier', 'codeVerifier', 'nonce', 'state', 'pkce_verifier',
  '*.authorization', '*.cookie', '*.databaseUrl', '*.password', '*.token', '*.secret',
  '*.code_verifier', '*.codeVerifier', '*.nonce', '*.state', '*.pkce_verifier',
  // C4: Better Auth MFA/OTP/session material must never reach a log line.
  'otp', 'otpCode', 'totp', 'totpSecret', 'backupCode', 'backupCodes',
  'backup_code', 'recoveryCode', 'recoveryCodes', 'recovery_code',
  'twoFactorPending', 'twoFactorCookie', 'twoFactorSecret',
  'session_token', 'sessionToken', 'sessionTokenHash',
  '*.otp', '*.otpCode', '*.totp', '*.totpSecret', '*.backupCode', '*.backupCodes',
  '*.backup_code', '*.recoveryCode', '*.recoveryCodes', '*.recovery_code',
  '*.twoFactorPending', '*.twoFactorCookie', '*.twoFactorSecret',
  '*.session_token', '*.sessionToken', '*.sessionTokenHash',
  // F2: the product session view carries the raw browser CSRF token (a
  // session-bound bearer proof); it must never reach a log line.
  'csrfToken', 'csrfTokenHash', 'csrf_token', 'csrf_token_hash',
  '*.csrfToken', '*.csrfTokenHash', '*.csrf_token', '*.csrf_token_hash',
] as const;

/**
 * I10 owner-delivery capability path segments (`/d/<token>`) are bearer
 * secrets (plan V4A-05): the whole segment after `/d/` is scrubbed in the
 * raw-URL fallback of the request serializer and in `redactSensitiveText`, so
 * a capability URL can never reach a log line even when it arrives at an
 * unregistered route. The token shape is `v1.<base64url>.<base64url>`; the
 * segment class also covers percent-encoded and otherwise malformed variants
 * (the capability token itself never contains a literal `/`).
 */
const DELIVERY_CAPABILITY_PATH_PATTERN = /(\/d\/)[^/?#\s]*/g;

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-xsrf-token',
  'csrf-token',
]);

export type RawHeaderPairs = ReadonlyArray<readonly [string, string]>;

interface RequestForLog {
  readonly method?: unknown;
  readonly url?: unknown;
  readonly headers?: { readonly host?: unknown };
  readonly socket?: { readonly remoteAddress?: unknown; readonly remotePort?: unknown };
  readonly remoteAddress?: unknown;
  readonly remotePort?: unknown;
  readonly routeOptions?: { readonly url?: unknown };
}

export function serializeRequestForLog(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const request = value as RequestForLog;
  const routeTemplate = request.routeOptions?.url;
  const rawUrl = typeof routeTemplate === 'string'
    ? routeTemplate
    : typeof request.url === 'string'
      ? request.url.replace(DELIVERY_CAPABILITY_PATH_PATTERN, '$1[REDACTED]')
      : '';
  return {
    method: request.method,
    url: rawUrl.split('?', 1)[0] ?? '',
    host: request.headers?.host,
    remoteAddress: request.socket?.remoteAddress ?? request.remoteAddress,
    remotePort: request.socket?.remotePort ?? request.remotePort,
  };
}

export function serializeRawHeaderPairs(pairs: unknown): unknown {
  if (!Array.isArray(pairs)) return pairs;
  return pairs.map((pair: unknown) => {
    if (!Array.isArray(pair) || pair.length < 2) return pair;
    const name = String(pair[0]);
    return [name, SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? '[REDACTED]' : String(pair[1])];
  });
}

export function redactSensitiveText(value: unknown): string {
  const text = serializeErrorChain(value);
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token|csrf-token)\s*[:=]\s*[^\r\n]+/gi, '$1=[REDACTED]')
    .replace(/(?<![A-Za-z0-9])(password|passwd|token|secret|api[_-]?key|session[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    // camelCase composite keys (C2): ...Secret / ...Token / ...Key /
    // ...Password / ...Passwd as the FINAL word component of the key name
    // (accessKeySecret=, callbackHmacSecret=, accessKey=, ...). The sensitive
    // word must start with a capital (true camelCase), so ordinary words such
    // as monkey=, secretion=, tokenizer=, tokens= are never over-redacted.
    // A JSON-quoted key ("accessKeySecret": "x") is left intact here and
    // handled by redactDirectMailEvidence.
    .replace(/(?<!["'])(?<![A-Za-z0-9])([A-Za-z0-9_-]*[A-Za-z0-9](?:Secret|Token|Key|Password|Passwd))\s*[:=]\s*([^\s,;]+)/g, '$1=[REDACTED]')
    // OIDC browser secrets (state, nonce, PKCE verifier) must never appear in logs/errors.
    .replace(/\b(code_verifier|codeVerifier|pkce_verifier|pkceVerifier)\s*[:=]\s*([^\s,;&]+)/gi, '$1=[REDACTED]')
    .replace(/\b(nonce|state)\s*[:=]\s*([A-Za-z0-9._~+/-]{8,})/gi, '$1=[REDACTED]')
    .replace(/([?&](?:code_verifier|code|state|nonce)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    // C4: Better Auth browser cookies (session, MFA pending challenge,
    // trusted device, OAuth state) — the signed values are bearer secrets
    // even when the surrounding text has no 'cookie' key word.
    .replace(/\b(__Host-known_session|known_session|known\.two_factor|known\.trust_device|known\.state|known\.dont_remember)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    // C4: OTP / TOTP / backup (recovery) code values, incl. 'backup code:'
    // and 'recovery code:' prose shapes. The value must look like a code
    // (4+ chars), so config words (otpLength=6, otpMaxAttempts=3) are not
    // over-redacted. The KEY is the capture ($1) and the VALUE is a
    // non-capture, so the replacement never echoes the code back as a key.
    .replace(/\b((?:otp|otpCode|twoFactorCode|totp|totpSecret|backupCodes?|recoveryCodes?|backup[ -]?codes?|recovery[ -]?codes?))\s*[:=]\s*(?:[A-Za-z0-9-]{4,64})/gi, '$1=[REDACTED]')
    // C4: TOTP provisioning URIs carry the base32 secret in the query.
    .replace(/\botpauth:\/\/[^\s]+/gi, '[REDACTED]')
    // I10 owner-delivery capability URLs (`/d/<token>`) are bearer secrets:
    // the whole capability segment is redacted wherever a URL appears in
    // error text, including percent-encoded tokens (plan V4A-05).
    .replace(/(\/d\/)[^/?#\s]*/g, '$1[REDACTED]')
    // Bare I10 capability tokens (`v1.<base64url payload>.<base64url sig>`)
    // embedded without a `/d/` prefix: both segments are long (the payload
    // carries the full claims JSON), so a 20+ char minimum per segment never
    // catches ordinary version strings like `v1.0.20` (plan V4A-05).
    .replace(/\bv1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bkn_[cp]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]');
}

function serializeErrorChain(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (!(value instanceof Error)) return String(value);
  const code = 'code' in value && typeof value.code === 'string' ? ` [${value.code}]` : '';
  const current = `${value.name}${code}: ${value.message}`;
  if (depth >= 3 || value.cause === undefined || seen.has(value.cause)) return current;
  seen.add(value);
  return `${current}; cause: ${serializeErrorChain(value.cause, depth + 1, seen)}`;
}

export function createLogger(level = 'info', destination?: DestinationStream): Logger {
  return pino({
    level,
    redact: { paths: [...REDACTED_LOG_PATHS], censor: '[REDACTED]' },
    serializers: { req: serializeRequestForLog, rawHeaderPairs: serializeRawHeaderPairs },
  }, destination);
}

export * from './sync-server.js';
export * from './metrics-http-server.js';
