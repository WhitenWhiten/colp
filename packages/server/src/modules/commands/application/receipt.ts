import { createHash } from 'node:crypto';

export interface ProductCommandBinding {
  readonly principalId: string;
  readonly commandScope: string;
  readonly commandId: string;
}

export interface ProductCommandResult {
  readonly status: number;
  readonly body: Uint8Array;
  readonly stableHeaders: Readonly<Record<string, string>>;
  readonly mediaType: string;
  readonly contractVersion: string;
  readonly targetIdentity?: string;
}

export type ProductCommandClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'replay'; readonly result: ProductCommandResult }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DYNAMIC_RESPONSE_HEADERS = new Set([
  'date', 'x-request-id', 'request-id', 'traceparent', 'tracestate',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after',
]);
const STABLE_RESPONSE_HEADERS = new Set(['cache-control', 'content-type', 'etag', 'location']);

export function assertCanonicalCommandId(commandId: string): string {
  if (!UUID_V4.test(commandId)) throw new Error('Known-Command-Id must be a canonical lowercase UUID v4');
  return commandId;
}

export function canonicalJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'string') {
      for (let index = 0; index < input.length; index += 1) {
        const unit = input.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = input.charCodeAt(index + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) {
            throw new TypeError('canonical JSON requires valid Unicode');
          }
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw new TypeError('canonical JSON requires valid Unicode');
        }
      }
      return JSON.stringify(input);
    }
    if (typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('canonical JSON does not allow non-finite numbers');
      if (Number.isInteger(input) && !Number.isSafeInteger(input)) throw new TypeError('canonical JSON requires safe integers');
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, item]) => `${encode(key)}:${encode(item)}`).join(',')}}`;
    }
    throw new TypeError('canonical JSON does not allow this value');
  };
  return encode(value);
}

export function stableReplayHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const stable: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (DYNAMIC_RESPONSE_HEADERS.has(normalizedName)) continue;
    if (!STABLE_RESPONSE_HEADERS.has(normalizedName)) {
      throw new Error(`response header is not safe for command replay: ${normalizedName}`);
    }
    stable[normalizedName] = value;
  }
  return stable;
}

export function canonicalCommandFingerprint(request: {
  readonly method: string;
  readonly route: string;
  readonly resource?: string | null;
  readonly mediaType: string;
  readonly query?: unknown;
  readonly conditions?: unknown;
  readonly body?: unknown;
}): string {
  const canonical = canonicalJson({
    method: request.method.toUpperCase(), route: request.route,
    resource: request.resource ?? null, mediaType: request.mediaType.toLowerCase(),
    query: request.query ?? {}, conditions: request.conditions ?? {}, body: request.body ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface ProductCommandReceiptPort {
  claim(binding: ProductCommandBinding, fingerprint: string): Promise<ProductCommandClaim>;
  complete(binding: ProductCommandBinding, fingerprint: string, result: ProductCommandResult): Promise<void>;
  purgeExpired(options?: { readonly limit?: number; readonly onPurged?: (count: number) => void }): Promise<number>;
  deletePrincipalReceipts(principalId: string): Promise<number>;
}

/** Application use case for account removal. The caller owns the transaction. */
export async function deleteAccountReceipts(
  receipts: ProductCommandReceiptPort,
  principalId: string,
): Promise<number> {
  if (!principalId) throw new Error('principalId is required');
  return receipts.deletePrincipalReceipts(principalId);
}

export type ProductCommandReceiptPortFactory =
  () => ProductCommandReceiptPort | Promise<ProductCommandReceiptPort>;

/** Schedules bounded receipt compaction without keeping a database transaction open. */
export function scheduleReceiptPurge(
  receipts: ProductCommandReceiptPortFactory,
  options: {
    readonly intervalMs: number;
    readonly batchSize?: number;
    readonly onPurged?: (count: number) => void;
    readonly onError?: (error: unknown) => void;
  },
): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.resolve(receipts()).then((port) => port.purgeExpired({ limit: options.batchSize ?? 100 }))
      .then((count) => options.onPurged?.(count))
      .catch(options.onError ?? (() => undefined)).finally(() => {
      running = false;
    });
  }, options.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
