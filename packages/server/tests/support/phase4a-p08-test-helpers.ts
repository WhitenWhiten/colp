/**
 * P4A-P08 shared helpers for the focused suites (not a vitest test file).
 *
 * Provides:
 *  - `p08Config`: the module `AttachmentsFeatureConfig` fixture with the
 *    credential-free delivery audience on a registrable domain DIFFERENT from
 *    the app origin (`delivery.attachments-probe.invalid`, the same probe
 *    namespace the real-R2 evidence uses — never same-site);
 *  - `P08ObjectServer`: a REAL local HTTP/1.1 server with the minimal
 *    single-PUT S3 semantics (create-only PUT with If-None-Match, HEAD with
 *    If-Match, exact-key DELETE) PLUS the delivery GET surface the RO
 *    adapter needs (If-Match, restricted single `bytes=` Range -> 206 with
 *    Content-Range, chunked streaming with per-key delay, server-side
 *    premature-close recording and per-key bytes-written counters for the
 *    slow-client/abort backpressure proofs). The PRODUCTION R2 adapter is
 *    pointed at this server, so the delivery host reads REAL bytes over the
 *    REAL transport;
 *  - `p08Bundle`: composes the PRODUCTION delivery composition
 *    (`composeAttachmentDelivery`: PostgreSQL admission closure + RO-only
 *    isolated host with the version-fenced generation resolver) and the
 *    PRODUCTION app (`buildP03App` with the download route port), with a
 *    deterministic injectable clock shared by the signer, the admission and
 *    the delivery verifier (fixed short-window expiry proofs without
 *    wall-clock sleeps);
 *  - `p08Admit` / `p08DeliveryUrl` / `p08TokenFrom` route/DTO helpers.
 *
 * The suites never read `.known-local/phase4a-r2.env`; real R2 is the
 * `evidence:phase4a-p08` subcommand boundary.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  composeAttachmentDelivery,
  createPostgresDeliveryGenerationResolver,
  type AttachmentDeliveryComposition,
} from '../../src/bootstrap/attachments-delivery-composition.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import {
  createDeliveryRateLimiter,
  type AttachmentsFeatureConfig,
  type AttachmentsR2Config,
  type DeliveryRateLimiter,
} from '../../src/modules/attachments/index.js';
import {
  P03_BUCKET,
  P03_RO_CREDENTIAL,
  buildP03App,
  makeP03Config,
  type P03AppBundle,
} from './phase4a-p03-test-helpers.js';
import { p07Headers, p07UploadToStored } from './phase4a-p07-test-helpers.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import type { BrowserSessionAuthority } from '../../src/modules/auth/index.js';
import type { AuthenticatedTestClient } from './product-http-harness.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import { waitForCondition, waitForRealTime } from './async-test-helpers.js';

export const P08_DELIVERY_ORIGIN = 'https://delivery.attachments-probe.invalid';
/** Deterministic HMAC secret for the focused suites (never a real credential). */
export const P08_DELIVERY_SECRET = Buffer.from('p08-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');
export const P08_ISSUER = 'https://issuer.example';
export const P08_COLLECTION_A = 'p08-collection-a';
export const P08_COLLECTION_B = 'p08-collection-b';
export const P08_COLLECTION_OTHER = 'p08-collection-other-owner';
export const P08_LIVE_PREFIX = 'attachments/live/';
export const P08_PROBE_PREFIX = 'attachments/probe/';

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export function p08Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const { r2: r2Overrides, ...rest } = overrides;
  // Merge the caller's r2 overrides over the P08 defaults so a partial r2
  // (e.g. just an endpoint swap) keeps the production bucket/live/probe
  // prefixes (typed-safe partial merge); non-r2 overrides still win.
  const r2: Partial<AttachmentsR2Config> = Object.assign(
    { livePrefix: P08_LIVE_PREFIX, probePrefix: P08_PROBE_PREFIX },
    r2Overrides ?? {},
  );
  return makeP03Config({
    isolatedDeliveryOrigin: P08_DELIVERY_ORIGIN,
    deliveryCapabilitySecretRef: 'known/p08/delivery/hmac',
    r2,
    ...rest,
  });
}

// ---------------------------------------------------------------------------
// Real local object server (create-only PUT + HEAD + GET + DELETE subset)
// ---------------------------------------------------------------------------

export interface P08StoredObject {
  readonly etag: string;
  readonly size: number;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface P08RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/**
 * REAL HTTP transport stand-in for the R2 endpoint used by BOTH the RW
 * surface (upload: create-only PUT, verification HEAD) and the RO delivery
 * surface (exact-key HEAD + bounded ranged GET). GET responses stream in
 * real chunks with a per-key delay; the server records how many bytes it
 * handed to the socket per key and counts premature closes, so the P08
 * slow-client/abort proofs observe REAL backpressure and REAL stream
 * destruction instead of asserting on strings or fixtures.
 */
export class P08ObjectServer {
  readonly objects = new Map<string, P08StoredObject>();
  readonly requests: P08RecordedRequest[] = [];
  /** Per-key GET chunk delay (ms); 0/absent means stream without delay. */
  readonly getDelays = new Map<string, number>();
  /** Exact keys whose HEAD must fail with a retryable 500. */
  readonly headFailures = new Set<string>();
  /** Exact keys whose GET response socket closed before the body finished. */
  readonly prematureCloses = new Map<string, number>();
  /** Total body bytes the server handed to the socket per key (GET only). */
  readonly bytesWritten = new Map<string, number>();
  private readonly chunkSize: number;
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  url = '';

  constructor(options: { readonly chunkSize?: number } = {}) {
    this.chunkSize = options.chunkSize ?? 16 * 1024;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolvePromise) => this.server.listen(0, '127.0.0.1', resolvePromise));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  prematureCloseCount(key: string): number {
    return this.prematureCloses.get(key) ?? 0;
  }

  bytesWrittenOf(key: string): number {
    return this.bytesWritten.get(key) ?? 0;
  }

  async waitForPrematureClose(key: string, timeoutMs: number): Promise<number> {
    await waitForCondition(() => this.prematureCloseCount(key) > 0, {
      timeoutMs,
      description: `the P08 object response for ${key} to close prematurely`,
    });
    return this.prematureCloseCount(key);
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const parts: Buffer[] = [];
    for await (const chunk of request) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(parts);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);
    // Path shape: /<bucket>/<key...>
    const key = segments.slice(1).join('/');
    const method = request.method ?? '';
    this.requests.push({ method, path: request.url ?? '', headers: request.headers, body });

    if (method === 'PUT') {
      if (this.objects.has(key)) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const contentType = request.headers['content-type'];
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.startsWith('x-amz-meta-') && typeof value === 'string') {
          metadata[name.slice('x-amz-meta-'.length)] = value;
        }
      }
      const etag = `"${sha256Hex(body).slice(0, 32)}"`;
      this.objects.set(key, {
        etag,
        size: body.byteLength,
        contentType: typeof contentType === 'string' ? contentType : null,
        metadata: Object.freeze(metadata),
        body,
      });
      response.writeHead(200, { ETag: etag });
      response.end();
      return;
    }

    if (method === 'HEAD') {
      if (this.headFailures.has(key)) {
        response.writeHead(500, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        ETag: object.etag,
        'Content-Length': String(object.size),
        'Content-Type': object.contentType ?? 'application/octet-stream',
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }

    if (method === 'GET') {
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      let start = 0;
      let end = object.size - 1;
      let status = 200;
      const rangeHeader = request.headers.range;
      if (typeof rangeHeader === 'string') {
        const match = /^bytes=(\d+)-(\d+)$/iu.exec(rangeHeader.trim());
        if (!match) {
          response.writeHead(416, { 'Content-Range': `bytes */${object.size}`, 'Content-Length': '0' });
          response.end();
          return;
        }
        start = Number(match[1]!);
        end = Math.min(Number(match[2]!), object.size - 1);
        status = 206;
      }
      if (start >= object.size || end < start) {
        response.writeHead(416, { 'Content-Range': `bytes */${object.size}`, 'Content-Length': '0' });
        response.end();
        return;
      }
      const slice = object.body.subarray(start, end + 1);
      const headers: Record<string, string> = {
        ETag: object.etag,
        'Content-Type': object.contentType ?? 'application/octet-stream',
        'Content-Length': String(slice.byteLength),
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${object.size}`;
      response.writeHead(status, headers);
      const delayMs = this.getDelays.get(key) ?? 0;
      let offset = 0;
      let finished = false;
      response.on('close', () => {
        if (!finished) {
          this.prematureCloses.set(key, (this.prematureCloses.get(key) ?? 0) + 1);
        }
      });
      try {
        while (offset < slice.byteLength) {
          if (response.destroyed) return;
          const endOffset = Math.min(offset + this.chunkSize, slice.byteLength);
          const chunk = slice.subarray(offset, endOffset);
          this.bytesWritten.set(key, (this.bytesWritten.get(key) ?? 0) + chunk.byteLength);
          if (!response.write(chunk)) {
            await new Promise<void>((resolvePromise) => response.once('drain', resolvePromise));
          }
          offset = endOffset;
          if (delayMs > 0 && offset < slice.byteLength) {
            await waitForRealTime(delayMs, 'inject P08 streamed-object chunk latency');
          }
        }
        finished = true;
        response.end();
      } catch {
        if (!finished) response.destroy();
      }
      return;
    }

    if (method === 'DELETE') {
      const deleted = this.objects.delete(key);
      response.writeHead(deleted ? 204 : 404, { 'Content-Length': '0' });
      response.end();
      return;
    }

    response.writeHead(405, { 'Content-Length': '0' });
    response.end();
  }
}

// ---------------------------------------------------------------------------
// Production delivery composition + app bundle for the focused suites
// ---------------------------------------------------------------------------

export interface P08Bundle {
  readonly bundle: P03AppBundle;
  /** The production delivery composition (admission closure + RO-only host). */
  readonly delivery: AttachmentDeliveryComposition;
  /** The delivery host's actual bound origin (127.0.0.2:<port>). */
  readonly boundOrigin: string;
  /** Deterministic clock shared by signer/admission/verifier. */
  readonly clock: { readonly now: Date; advance(ms: number): void };
}

export interface P08BundleOptions {
  /** The isolated I07 runtime (schema + databaseUrl + pool/db). */
  readonly runtime: I07MigrationRuntime;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly objectServerUrl: string;
  readonly config: AttachmentsFeatureConfig;
  readonly rateLimiter?: DeliveryRateLimiter;
}

/**
 * Composes the PRODUCTION delivery composition and the PRODUCTION app with
 * the download admission route port. The capability audience is the fixed
 * credential-free https origin (config contract); the host binds locally on
 * 127.0.0.2 and the suites fetch through `boundOrigin`. The signer, the
 * admission use case and the delivery verifier share ONE deterministic clock
 * so the fixed short-window expiry/replay proofs need no wall-clock sleeps.
 */
export async function p08Bundle(options: P08BundleOptions): Promise<P08Bundle> {
  const mutable = { now: new Date('2026-08-08T12:00:00.000Z') };
  const clock = () => new Date(mutable.now);
  const delivery = await composeAttachmentDelivery({
    config: options.config,
    ledger: createPostgresAttachmentsPorts(),
    uow: createUnitOfWork(options.runtime.runtime.db),
    accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
    resolveGeneration: createPostgresDeliveryGenerationResolver(options.runtime.runtime.pool),
    resolveSecret: async (ref) => {
      if (ref === options.config.r2.roSecretRef) return P03_RO_CREDENTIAL;
      if (ref === options.config.deliveryCapabilitySecretRef) return P08_DELIVERY_SECRET;
      throw new Error(`p08_unexpected_secret_ref:${ref}`);
    },
    rateLimiter: options.rateLimiter
      ?? createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 500, maxTrackedPrincipals: 128 }),
    clock,
    hostname: '127.0.0.2',
  });
  const bundle = buildP03App({
    runtime: options.runtime.runtime,
    databaseUrl: options.runtime.databaseUrl,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    objectServerUrl: options.objectServerUrl,
    attachmentsConfig: options.config,
    delivery,
  });
  await delivery.deliveryHost.start();
  return {
    bundle,
    delivery,
    boundOrigin: delivery.deliveryHost.boundOrigin,
    clock: {
      get now() {
        return new Date(mutable.now);
      },
      advance(ms: number) {
        mutable.now = new Date(mutable.now.getTime() + ms);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Route / DTO helpers
// ---------------------------------------------------------------------------

export interface P08AdmissionDto {
  readonly kind: 'granted';
  readonly blobId: string;
  readonly generationId: string;
  readonly method: 'GET';
  readonly deliveryOrigin: string;
  readonly downloadUrl: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface P08HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
}

/** POST /api/v1/attachments/{blobId}/download (session + Origin + CSRF). */
export function p08Admit(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  blobId: string,
): Promise<P08HttpResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/attachments/${encodeURIComponent(blobId)}/download`,
    headers: {
      cookie: client.cookie,
      origin: p08AppOrigin(),
      'x-csrf-token': client.csrfToken,
    },
  });
}

/** The app origin the focused suites use for the Origin/CSRF gate. */
export function p08AppOrigin(): string {
  return 'https://app.known.example';
}

/** Extracts the raw capability token from a granted admission DTO. */
export function p08TokenFrom(admission: P08AdmissionDto): string {
  const prefix = `${admission.deliveryOrigin}/d/`;
  assert.ok(admission.downloadUrl.startsWith(prefix), 'downloadUrl must live on the isolated delivery origin');
  return admission.downloadUrl.slice(prefix.length);
}

/** The delivery URL on the host's actual bound origin (same token). */
export function p08DeliveryUrl(boundOrigin: string, token: string): string {
  return `${boundOrigin}/d/${token}`;
}

/** Deterministic distinct body marker per slot (old/new must differ in size). */
export function p08Body(slot: number): Uint8Array {
  return new TextEncoder().encode(`p08-body-${slot}-${'x'.repeat(64 + slot)}`);
}

export { p07Headers, p07UploadToStored };
