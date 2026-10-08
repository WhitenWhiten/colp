/**
 * Shared helpers for the P4A-I02 focused unit suite. This file is not a test
 * file: it matches no vitest test pattern and is not listed in the focused
 * config, so it never runs as a suite on its own.
 */
import type { GenerationLedgerRecord } from '../../scripts/evidence/phase4a-i02-generation-ledger.js';
import type {
  ExactGenerationStore,
  HttpTransport,
  PresignedPutGrant,
  Presigner,
  RawPutRequest,
  UploadScenarioDeps,
  UploadScenarioParams,
} from '../../scripts/evidence/phase4a-i02-upload-probe.js';
import { yieldToEventLoop } from './async-test-helpers.js';

export const KEY_PREFIX = 'capability-probes/deployment-01/';

export const completeConfiguration = {
  P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
  P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  P4A_R2_BUCKET: 'known-quarantine-production',
  P4A_R2_PROBE_PREFIX: 'capability-probes/deployment-01/',
  P4A_R2_ACCESS_KEY_ID: 'write-access-key-marker',
  P4A_R2_SECRET_ACCESS_KEY: 'write-secret-access-key-marker',
};

export function uuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export function opaqueKey(uuidValue = uuidFor(900)): string {
  return `${KEY_PREFIX}${uuidValue}`;
}

export const DEFAULT_BODY = Buffer.from('known-phase4a-i02\n', 'utf8');

export function storedMetadata(): Record<string, string> {
  return { probe: 'phase4a-i02', nonce: 'opaque-nonce-marker' };
}

export function scenario(overrides: Partial<UploadScenarioParams> = {}): UploadScenarioParams {
  return {
    intentId: uuidFor(1),
    generationId: uuidFor(2),
    blobId: uuidFor(3),
    bucket: 'known-quarantine-production',
    key: opaqueKey(),
    body: DEFAULT_BODY,
    metadata: storedMetadata(),
    ttlSeconds: 60,
    ...overrides,
  };
}

let sequence = 0;
export function nextScenario(overrides: Partial<UploadScenarioParams> = {}): UploadScenarioParams {
  sequence += 1;
  return scenario({
    intentId: uuidFor(100 + sequence), generationId: uuidFor(200 + sequence), blobId: uuidFor(300 + sequence),
    key: opaqueKey(uuidFor(400 + sequence)),
    ...overrides,
  });
}

export function grantFromRecord(record: GenerationLedgerRecord, body: Uint8Array, options: { metadata: Record<string, string>; contentType: string; ttlSeconds: number; now: () => Date }): PresignedPutGrant {
  const signedAt = options.now();
  return {
    url: `https://r2.example/${record.bucket}/${record.key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=marker&X-Amz-Date=20260808T000000Z&X-Amz-Expires=${options.ttlSeconds}&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=content-length%3Bhost%3Bif-none-match%3Bx-amz-meta-nonce%3Bx-amz-meta-probe&x-id=PutObject`,
    method: 'PUT',
    signedAtIso: signedAt.toISOString(),
    expiresAtIso: new Date(signedAt.getTime() + options.ttlSeconds * 1000).toISOString(),
    ttlSeconds: options.ttlSeconds,
    bucket: record.bucket,
    key: record.key,
    keyFingerprint: record.fingerprint,
    ifNoneMatch: '*',
    metadataHeaders: Object.fromEntries(Object.entries(options.metadata).map(([k, v]) => [`x-amz-meta-${k.toLowerCase()}`, v])),
    contentLength: body.byteLength,
    contentType: options.contentType,
  };
}

export function fakePresigner(): Presigner {
  return {
    async presignPut(record, body, options) {
      return grantFromRecord(record, body, options);
    },
  };
}

export function fakeStore(overrides: {
  head?: (record: GenerationLedgerRecord) => { class: 'ok' | 'not_found' | 'denied' | 'retryable' | 'unknown'; size?: number; etag?: string; metadata?: Record<string, string>; status?: number };
  readBounded?: (record: GenerationLedgerRecord, maxBytes: number) => { class: 'ok' | 'not_found' | 'denied' | 'retryable' | 'unknown'; bytes?: Uint8Array };
  deleteExactKey?: (record: GenerationLedgerRecord) => Promise<void>;
} = {}): ExactGenerationStore & { seenKeys: string[] } {
  const seenKeys: string[] = [];
  return {
    seenKeys,
    async head(record) {
      seenKeys.push(record.key);
      if (overrides.head) return overrides.head(record);
      return {
        class: 'ok', size: DEFAULT_BODY.byteLength, etag: '"opaque-etag"',
        metadata: storedMetadata(), status: 200,
      };
    },
    async readBounded(record, maxBytes) {
      if (overrides.readBounded) return overrides.readBounded(record, maxBytes);
      return { class: 'ok', bytes: DEFAULT_BODY };
    },
    async deleteExactKey(record) {
      if (overrides.deleteExactKey) return overrides.deleteExactKey(record);
    },
  };
}

export interface ConditionalTransport extends HttpTransport {
  requests: RawPutRequest[];
  peakInFlight(): number;
  exists(): boolean;
}

export function conditionalTransport(initialExists = false): ConditionalTransport {
  const requests: RawPutRequest[] = [];
  let exists = initialExists;
  let inFlight = 0;
  let peak = 0;
  return {
    requests,
    peakInFlight: () => peak,
    exists: () => exists,
    async request(method, request) {
      requests.push(request);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await yieldToEventLoop();
      inFlight -= 1;
      if (method !== 'PUT') return { status: 403, ok: false, headers: {}, bodyText: 'signature' };
      if (!request.headers.some(([name]) => name.toLowerCase() === 'if-none-match')) {
        return { status: 403, ok: false, headers: {}, bodyText: 'signature' };
      }
      if (exists) return { status: 412, ok: false, headers: {}, bodyText: 'precondition' };
      exists = true;
      return { status: 200, ok: true, headers: {}, bodyText: '' };
    },
  };
}

export function memoryLedger(records: GenerationLedgerRecord[] = []) {
  const byGen = new Map<string, GenerationLedgerRecord>();
  const byKey = new Map<string, GenerationLedgerRecord>();
  return {
    async commit(record: Omit<GenerationLedgerRecord, 'committedAtIso'>) {
      const full: GenerationLedgerRecord = { ...record, committedAtIso: '2026-08-08T00:00:00.000Z' };
      if (byGen.has(full.generationId)) throw new Error('ledger_duplicate_generation');
      if (byKey.has(full.key)) throw new Error('ledger_duplicate_key');
      records.push(full);
      byGen.set(full.generationId, full);
      byKey.set(full.key, full);
      return full;
    },
    findByGeneration(generationId: string) { return byGen.get(generationId); },
    list: () => records,
    close: async () => {},
  };
}

export function depsWith(overrides: Partial<UploadScenarioDeps> = {}): UploadScenarioDeps {
  return {
    ledger: memoryLedger(),
    presigner: fakePresigner(),
    transport: conditionalTransport(false),
    store: fakeStore(),
    clock: () => new Date('2026-08-08T00:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  };
}

export function mutableClock(startIso = '2026-08-08T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
  };
}
