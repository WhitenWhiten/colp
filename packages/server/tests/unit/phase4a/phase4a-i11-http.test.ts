/**
 * P4A-I11 raw HTTP integration suite over the PRODUCTION delivery host.
 *
 * The host is the real `bootstrap/delivery.ts` composition: production I10
 * capability signer+verifier, the pure delivery policies, and the I06 RO
 * object-store adapter over a REAL controlled fault transport (a local HTTP
 * server scripted S3-style, driven through the production @aws-sdk client).
 * Raw HTTP asserts full headers/status/body/range semantics, credential
 * rejection, non-forwarding of Cookie/Authorization/Referer, cache-key
 * isolation between two principals with the same filename, bounded
 * Content-Disposition for oversized filename suggestions, slow-consumer
 * backpressure/bounded buffering, client-abort propagation (upstream body
 * destruction proven by the fault transport), R2 interruption/timeout ->
 * stable zero-body errors with no redirect, method allowlist, and the
 * no-key/URL-in-logs contract.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import {
  createHmacOwnerDeliveryCapabilitySigner,
  DELIVERY_CONTENT_DISPOSITION_HARD_CAP,
  formatContentDisposition,
  type DeliveryRequestLogEntry,
  type GenerationObjectStorePort,
} from '../../../src/modules/attachments/index.js';
import {
  BlobStorePortError,
  createGenerationObjectStoreAdapter,
  createR2ReadOnlyGenerationStore,
  type BlobStorePort,
  type ReadOnlyBlobStorePort,
} from '../../../src/infrastructure/object-storage/index.js';
import { composeDeliveryHost, type DeliveryHost } from '../../../src/bootstrap/delivery.js';
import {
  startFaultServer,
  s3ErrorBody,
} from '../../support/phase4a-i06-fault-server.js';
import type { FaultScript, FaultServer, RecordedRequest } from '../../support/phase4a-i06-fault-server.js';
import { waitForRealTime } from '../../support/async-test-helpers.js';
import {
  FixtureDeliveryObjectStore,
  I11_OWNER_A,
  I11_OWNER_B,
  activeHtmlBytes,
  fixtureKey,
  fixtureResolver,
  i11Config,
  issueCapability,
  plainBytes,
  type I11FixtureObject,
} from '../../support/phase4a-i11-test-helpers.js';

const BUCKET = 'known-quarantine-production';
const LIVE_PREFIX = 'attachments/live/';
const RO_CREDENTIAL = { accessKeyId: 'i11-read-access-key-marker', secretAccessKey: 'i11-read-secret-access-key-marker' };
const UPSTREAM_TIMEOUT_MS = 5_000;

function objectWith(suffix: string, bytes: Uint8Array, ownerSubject = I11_OWNER_A): I11FixtureObject {
  return {
    blobId: `018f6f7a-8f2a-7a3d-a123-12345678${suffix.slice(0, 2)}01`,
    generationId: `018f6f7a-8f2a-7a3d-a123-12345678${suffix.slice(0, 2)}02`,
    key: fixtureKey(`${suffix}-${randomUUID()}`),
    ownerSubject,
    bytes,
    etag: `"i11-etag-${suffix}"`,
  };
}

function headHeaders(size: number, etag: string): Record<string, string> {
  return {
    'content-length': String(size),
    etag: etag.replace(/^"|"$/g, ''),
    'x-amz-meta-probe': 'phase4a-i11',
    'x-amz-meta-nonce': 'i11-nonce-marker',
    'last-modified': 'Sat, 08 Aug 2026 00:00:00 GMT',
  };
}

/** Scripts S3-style HEAD/GET (with Range) responses for the fixture objects. */
function createS3Script(objects: readonly I11FixtureObject[]) {
  return (request: RecordedRequest) => {
    const object = objects.find((candidate) => request.path.includes(candidate.key));
    if (!object) return { status: 404, headers: {}, body: '' };
    if (request.method === 'HEAD') {
      return { status: 200, headers: headHeaders(object.bytes.byteLength, object.etag), body: '' };
    }
    if (request.method === 'GET') {
      const range = request.headers.range;
      if (typeof range === 'string' && range.startsWith('bytes=')) {
        const [rawStart, rawEnd] = range.slice('bytes='.length).split('-');
        const start = Number(rawStart);
        const end = rawEnd === '' ? object.bytes.byteLength - 1 : Number(rawEnd);
        const boundedEnd = Math.min(end, object.bytes.byteLength - 1);
        const slice = object.bytes.slice(start, boundedEnd + 1);
        return {
          status: 206,
          headers: {
            ...headHeaders(slice.byteLength, object.etag),
            'content-range': `bytes ${start}-${boundedEnd}/${object.bytes.byteLength}`,
          },
          body: Buffer.from(slice),
        };
      }
      return { status: 200, headers: headHeaders(object.bytes.byteLength, object.etag), body: Buffer.from(object.bytes) };
    }
    return { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') };
  };
}

interface HttpHostHarness {
  host: DeliveryHost;
  origin: string;
  fault: FaultServer;
  store: ReadOnlyBlobStorePort;
  signer: ReturnType<typeof createHmacOwnerDeliveryCapabilitySigner>;
  objects: readonly I11FixtureObject[];
}

async function startHttpHarness(options: {
  objects: readonly I11FixtureObject[];
  faultScript?: (request: RecordedRequest) => unknown;
  upstreamTimeoutMs?: number;
}): Promise<HttpHostHarness> {
  const fault = await startFaultServer((options.faultScript ?? createS3Script(options.objects)) as FaultScript);
  const roStore = createR2ReadOnlyGenerationStore({
    endpoint: fault.url,
    region: 'auto',
    bucket: BUCKET,
    livePrefix: LIVE_PREFIX,
    probePrefix: 'attachments/probe/',
    roCredential: RO_CREDENTIAL,
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
  });
  const objectStore = createGenerationObjectStoreAdapter(roStore);
  const host = await composeDeliveryHost({
    config: i11Config(),
    objectStore,
    capabilitySecret: Buffer.from('i11-http-delivery-capability-hmac-secret-0123456789abcdef', 'utf8'),
    resolveGeneration: fixtureResolver(options.objects),
    hostname: '127.0.0.2',
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
    forceCloseConnections: true,
  });
  const origin = await host.start();
  const signer = createHmacOwnerDeliveryCapabilitySigner({
    secret: Buffer.from('i11-http-delivery-capability-hmac-secret-0123456789abcdef', 'utf8'),
    audienceOrigin: origin,
  });
  return { host, origin, fault, store: roStore, signer, objects: options.objects };
}

async function stopHttpHarness(harness: HttpHostHarness): Promise<void> {
  await harness.host.close();
  await harness.store.close();
  await harness.fault.close();
}

function requestsByMethod(fault: FaultServer, method: string): RecordedRequest[] {
  return fault.requests.filter((request) => request.method === method);
}

describe('P4A-I11 production delivery host over a fault transport', () => {
  test('GET 200 delivers exact bytes with the full security-header contract and no Set-Cookie', async () => {
    const object = objectWith('aa', plainBytes('i11 exact payload\n'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const response = await fetch(`${harness.origin}/d/${token}?filename=report.txt`, {
        headers: {
          cookie: 'known_session=i11-cookie-marker',
          authorization: 'Bearer i11-bearer-marker',
          referer: 'http://127.0.0.1:9/',
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(response.headers.get('content-disposition'), formatContentDisposition('report.txt'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('etag'), object.etag);
      assert.equal(response.headers.get('content-length'), String(object.bytes.byteLength));
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('location'), null, 'never redirect to an R2 URL');
      const body = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(body, object.bytes);
      assert.ok(harness.host.requestLog.length >= 1);
      // Cookie/Authorization/Referer must never reach the upstream (R2)
      // transport. The RO object store always emits its OWN SigV4 Authorization
      // header, so the check is that the client's marker never appears.
      for (const method of ['HEAD', 'GET']) {
        for (const request of requestsByMethod(harness.fault, method)) {
          assert.equal(request.headers.cookie, undefined, `${method} must not forward Cookie`);
          const upstreamAuth = String(request.headers.authorization ?? '');
          assert.ok(!upstreamAuth.includes('i11-bearer-marker'), `${method} must not forward the client Authorization`);
          assert.equal(request.headers.referer, undefined, `${method} must not forward Referer`);
        }
      }
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('HEAD returns identical headers with an empty body and never reads the upstream body', async () => {
    const object = objectWith('ab', plainBytes('i11 head payload\n'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const response = await fetch(`${harness.origin}/d/${token}?filename=head.bin`, { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), String(object.bytes.byteLength));
      assert.equal(response.headers.get('content-disposition'), formatContentDisposition('head.bin'));
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
      assert.equal(await response.text(), '');
      // HEAD must mirror GET headers without issuing (and leaking) an upstream
      // body GET: only the exact-key HEAD reaches the object store.
      assert.equal(requestsByMethod(harness.fault, 'GET').length, 0, 'HEAD must not issue an upstream body GET');
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('method allowlist: GET/HEAD allowed; others 405 with Allow; unknown paths 404', async () => {
    const object = objectWith('ac', plainBytes('i11 method payload'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const url = `${harness.origin}/d/${token}`;
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await fetch(url, { method });
        assert.equal(response.status, 405, `${method} must be denied`);
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
        assert.equal(await response.text(), '');
        assert.equal(response.headers.get('cache-control'), 'private,no-store');
      }
      const missing = await fetch(`${harness.origin}/d/not-a-token`);
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), '');
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('invalid/expired/tampered/wrong-audience credentials are zero-body 404 without redirect; duplicate replay is valid', async () => {
    const object = objectWith('ad', plainBytes('i11 credential payload'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const url = `${harness.origin}/d/${token}`;

      const duplicate = await fetch(url);
      assert.equal(duplicate.status, 200, 'replay within the TTL is valid (the exposure window IS the TTL)');
      const replay = await fetch(url);
      assert.equal(replay.status, 200);

      const expired = issueCapability(harness.signer, object, {
        ttlSeconds: 60,
        now: new Date(Date.now() - 61_000),
      });
      const expiredResponse = await fetch(`${harness.origin}/d/${expired}`);
      assert.equal(expiredResponse.status, 404);
      assert.equal(await expiredResponse.text(), '');
      assert.equal(expiredResponse.headers.get('location'), null);

      const [version, payload, signature] = token.split('.') as [string, string, string];
      const tampered = `${version}.${payload!.slice(0, -2)}AA.${signature}`;
      const tamperedResponse = await fetch(`${harness.origin}/d/${tampered}`);
      assert.equal(tamperedResponse.status, 404);

      const wrongAudienceToken = createHmacOwnerDeliveryCapabilitySigner({
        secret: Buffer.from('i11-http-delivery-capability-hmac-secret-0123456789abcdef', 'utf8'),
        audienceOrigin: 'http://127.0.0.2:99999',
      }).sign({
        blobId: object.blobId, generationId: object.generationId, ownerSubject: object.ownerSubject, ttlSeconds: 60,
      }).token;
      const wrongAudience = await fetch(`${harness.origin}/d/${wrongAudienceToken}`);
      assert.equal(wrongAudience.status, 404);

      const garbage = await fetch(`${harness.origin}/d/v1.garbage`);
      assert.equal(garbage.status, 404);
      assert.equal(garbage.headers.get('cache-control'), 'private,no-store');
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('filename policy over HTTP: CJK/RTL/CRLF are strictly encoded and never inject', async () => {
    const object = objectWith('ae', plainBytes('i11 filename payload'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const cjk = await fetch(`${harness.origin}/d/${token}?filename=${encodeURIComponent('报告.pdf')}`);
      assert.equal(cjk.headers.get('content-disposition'), formatContentDisposition('报告.pdf'));
      assert.ok(!cjk.headers.get('content-disposition')!.includes('\r'));
      assert.ok(!cjk.headers.get('content-disposition')!.includes('\n'));

      const rtl = await fetch(`${harness.origin}/d/${token}?filename=${encodeURIComponent('דוח.pdf')}`);
      assert.equal(rtl.headers.get('content-disposition'), formatContentDisposition('דוח.pdf'));

      const crlf = await fetch(`${harness.origin}/d/${token}?filename=${encodeURIComponent('safe\r\nSet-Cookie: evil=1\nname.txt')}`);
      const header = crlf.headers.get('content-disposition')!;
      assert.ok(!header.includes('\r') && !header.includes('\n'), 'CRLF cannot inject a header line');
      assert.equal(crlf.headers.get('set-cookie'), null, 'the injection attempt must never become a real Set-Cookie header');
      assert.ok(header.startsWith('attachment; filename="'));
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('oversized filename suggestions yield a bounded Content-Disposition header', async () => {
    const object = objectWith('b8', plainBytes('i11 bounded filename payload'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);

      const longAscii = `${'a'.repeat(300)}.pdf`;
      const asciiResponse = await fetch(`${harness.origin}/d/${token}?filename=${encodeURIComponent(longAscii)}`);
      assert.equal(asciiResponse.status, 200);
      const asciiHeader = asciiResponse.headers.get('content-disposition')!;
      assert.equal(asciiHeader, formatContentDisposition(longAscii), 'the HTTP header matches the pure policy');
      assert.ok(asciiHeader.length <= DELIVERY_CONTENT_DISPOSITION_HARD_CAP, 'long ASCII names stay bounded');

      const longCjk = `${'报告'.repeat(200)}.pdf`;
      const cjkResponse = await fetch(`${harness.origin}/d/${token}?filename=${encodeURIComponent(longCjk)}`);
      assert.equal(cjkResponse.status, 200);
      const cjkHeader = cjkResponse.headers.get('content-disposition')!;
      assert.equal(cjkHeader, formatContentDisposition(longCjk), 'the HTTP header matches the pure policy');
      assert.ok(cjkHeader.includes('.pdf'), 'the safe extension survives truncation over HTTP');
      assert.ok(cjkHeader.length <= DELIVERY_CONTENT_DISPOSITION_HARD_CAP, 'multi-byte names stay bounded');
      assert.ok(!cjkHeader.includes('\r') && !cjkHeader.includes('\n'));
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('single ranges are 206 with exact Content-Range; unsatisfiable/multi-range are 416 with zero body', async () => {
    const object = objectWith('af', plainBytes('0123456789'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const base = `${harness.origin}/d/${token}`;

      const first = await fetch(base, { headers: { range: 'bytes=0-3' } });
      assert.equal(first.status, 206);
      assert.equal(first.headers.get('content-range'), 'bytes 0-3/10');
      assert.equal(await first.text(), '0123');

      const suffix = await fetch(base, { headers: { range: 'bytes=-3' } });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), '789');

      const openEnded = await fetch(base, { headers: { range: 'bytes=2-' } });
      assert.equal(openEnded.status, 206);
      assert.equal(await openEnded.text(), '23456789');

      const outOfRange = await fetch(base, { headers: { range: 'bytes=999-' } });
      assert.equal(outOfRange.status, 416);
      assert.equal(outOfRange.headers.get('content-range'), 'bytes */10');
      assert.equal(await outOfRange.text(), '');

      const multi = await fetch(base, { headers: { range: 'bytes=0-1,3-4' } });
      assert.equal(multi.status, 416, 'restricted single-range policy rejects multi-range');
      assert.equal(await multi.text(), '');

      const malformed = await fetch(base, { headers: { range: 'items=0-1' } });
      assert.equal(malformed.status, 416);
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('If-None-Match matching returns 304 with no body; a mismatch returns 200', async () => {
    const object = objectWith('b0', plainBytes('i11 etag payload'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const url = `${harness.origin}/d/${token}`;
      const notModified = await fetch(url, { headers: { 'if-none-match': object.etag } });
      assert.equal(notModified.status, 304);
      assert.equal(await notModified.text(), '');
      assert.equal(notModified.headers.get('cache-control'), 'private,no-store');

      const mismatch = await fetch(url, { headers: { 'if-none-match': '"other-etag"' } });
      assert.equal(mismatch.status, 200);
      assert.deepEqual(new Uint8Array(await mismatch.arrayBuffer()), object.bytes);
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('If-Range: only a matching strong ETag honors Range; stale/weak/date/invalid If-Range falls back to the full 200 (GET and HEAD) (FIX-L-047)', async () => {
    const object = objectWith('b9', plainBytes('0123456789'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const base = `${harness.origin}/d/${token}`;

      // Matching strong If-Range: the Range is honored (206, exact Content-Range).
      const matched = await fetch(base, { headers: { range: 'bytes=0-3', 'if-range': object.etag } });
      assert.equal(matched.status, 206);
      assert.equal(matched.headers.get('content-range'), 'bytes 0-3/10');
      assert.equal(await matched.text(), '0123');

      // Stale ETag in If-Range: Range is ignored and the CURRENT full object
      // is served as 200 — never a 206 of a different version.
      const stale = await fetch(base, { headers: { range: 'bytes=0-3', 'if-range': '"old-etag"' } });
      assert.equal(stale.status, 200);
      assert.equal(stale.headers.get('content-range'), null);
      assert.equal(stale.headers.get('content-length'), String(object.bytes.byteLength));
      assert.equal(stale.headers.get('etag'), object.etag);
      assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), object.bytes);

      // A weak entity-tag is invalid for If-Range: Range is ignored.
      const weak = await fetch(base, { headers: { range: 'bytes=0-3', 'if-range': `W/${object.etag}` } });
      assert.equal(weak.status, 200);
      assert.equal(weak.headers.get('content-range'), null);
      assert.deepEqual(new Uint8Array(await weak.arrayBuffer()), object.bytes);

      // The HTTP-date form is not supported: explicitly ignored, full 200.
      const date = await fetch(base, {
        headers: { range: 'bytes=0-3', 'if-range': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      });
      assert.equal(date.status, 200);
      assert.equal(date.headers.get('content-range'), null);
      assert.deepEqual(new Uint8Array(await date.arrayBuffer()), object.bytes);

      // Malformed/invalid If-Range values are ignored, full 200.
      const invalid = await fetch(base, { headers: { range: 'bytes=0-3', 'if-range': 'not-an-etag' } });
      assert.equal(invalid.status, 200);
      assert.equal(invalid.headers.get('content-range'), null);

      // A stale If-Range also overrides an otherwise-unsatisfiable Range: the
      // Range header is ignored entirely, so there is no 416 and no Content-Range.
      const staleUnsatisfiable = await fetch(base, {
        headers: { range: 'bytes=999-', 'if-range': '"old-etag"' },
      });
      assert.equal(staleUnsatisfiable.status, 200);
      assert.equal(staleUnsatisfiable.headers.get('content-range'), null);
      assert.deepEqual(new Uint8Array(await staleUnsatisfiable.arrayBuffer()), object.bytes);

      // Without If-Range the unsatisfiable range still yields the fixed 416.
      const unsatisfiable = await fetch(base, { headers: { range: 'bytes=999-' } });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');
      assert.equal(await unsatisfiable.text(), '');

      // HEAD mirrors the GET headers: a matching If-Range reports the range
      // length with Content-Range and no body; a stale If-Range reports the
      // full length without Content-Range.
      const headMatched = await fetch(base, {
        method: 'HEAD', headers: { range: 'bytes=0-3', 'if-range': object.etag },
      });
      assert.equal(headMatched.status, 206);
      assert.equal(headMatched.headers.get('content-range'), 'bytes 0-3/10');
      assert.equal(headMatched.headers.get('content-length'), '4');
      assert.equal(await headMatched.text(), '');

      const headStale = await fetch(base, {
        method: 'HEAD', headers: { range: 'bytes=0-3', 'if-range': '"old-etag"' },
      });
      assert.equal(headStale.status, 200);
      assert.equal(headStale.headers.get('content-range'), null);
      assert.equal(headStale.headers.get('content-length'), String(object.bytes.byteLength));
      assert.equal(await headStale.text(), '');
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('two principals requesting the same filename get isolated bytes and private,no-store (no cache sharing)', async () => {
    const objectA = objectWith('b1', plainBytes('principal-A-bytes\n'), I11_OWNER_A);
    const objectB = objectWith('b2', plainBytes('principal-B-bytes-different-length\n'), I11_OWNER_B);
    const harness = await startHttpHarness({ objects: [objectA, objectB] });
    try {
      const tokenA = issueCapability(harness.signer, objectA);
      const tokenB = issueCapability(harness.signer, objectB);
      const responseA = await fetch(`${harness.origin}/d/${tokenA}?filename=shared.bin`);
      const responseB = await fetch(`${harness.origin}/d/${tokenB}?filename=shared.bin`);
      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);
      assert.deepEqual(new Uint8Array(await responseA.arrayBuffer()), objectA.bytes);
      assert.deepEqual(new Uint8Array(await responseB.arrayBuffer()), objectB.bytes);
      assert.notEqual(responseA.headers.get('etag'), responseB.headers.get('etag'));
      assert.equal(responseA.headers.get('cache-control'), 'private,no-store');
      assert.equal(responseB.headers.get('cache-control'), 'private,no-store');
      assert.equal(responseA.headers.get('content-disposition'), responseB.headers.get('content-disposition'));
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('active HTML bytes are never served inline: content-type stays octet-stream', async () => {
    const object = objectWith('b3', activeHtmlBytes('i11-http-marker'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const response = await fetch(`${harness.origin}/d/${token}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(response.headers.get('content-disposition')!.startsWith('attachment;'), true);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('slow consumer: delivery is streamed with backpressure and bounded buffering', async () => {
    const object = objectWith('b4', new Uint8Array(1024 * 1024).fill(7));
    const pulls: string[] = [];
    const fixtureStore = new FixtureDeliveryObjectStore({ onPull: (generationId) => pulls.push(generationId) });
    fixtureStore.seed(object);
    const fault = await startFaultServer(() => ({ status: 404, headers: {}, body: '' }));
    const host = await composeDeliveryHost({
      config: i11Config(),
      objectStore: fixtureStore as GenerationObjectStorePort,
      capabilitySecret: Buffer.from('i11-http-delivery-capability-hmac-secret-0123456789abcdef', 'utf8'),
      resolveGeneration: fixtureResolver([object]),
      hostname: '127.0.0.2',
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    const origin = await host.start();
    const signer = createHmacOwnerDeliveryCapabilitySigner({
      secret: Buffer.from('i11-http-delivery-capability-hmac-secret-0123456789abcdef', 'utf8'),
      audienceOrigin: origin,
    });
    try {
      const token = issueCapability(signer, object);
      const response = await fetch(`${origin}/d/${token}`);
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      const pulledAfterFirstChunk = pulls.length;
      // Idle the consumer: a buffering host would drain the whole upstream now.
      await waitForRealTime(
        400,
        'exercise real socket/fetch backpressure while the downstream consumer is intentionally idle',
      );
      const pulledWhileIdle = pulls.length - pulledAfterFirstChunk;
      const totalChunks = Math.ceil(object.bytes.byteLength / (4 * 1024));
      // A backpressured host buffers only a bounded prefix (readable buffer +
      // socket/fetch layers); an unbounded host would drain the WHOLE object
      // while the client is idle. Assert at most half the object is pulled.
      assert.ok(pulledWhileIdle <= totalChunks / 2, `bounded buffering: pulled ${pulledWhileIdle} of ${totalChunks} chunks while the client was idle`);
      let received = first.value?.byteLength ?? 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
      }
      assert.equal(received, object.bytes.byteLength, 'a slow consumer still receives every byte');
      assert.ok(pulls.length >= totalChunks, 'the whole upstream is consumed on demand');
    } finally {
      await host.close();
      await fault.close();
    }
  });

  test('client abort mid-body destroys the upstream stream (fault transport proves destruction)', async () => {
    const object = objectWith('b5', plainBytes('x'.repeat(2048)));
    const harness = await startHttpHarness({
      objects: [object],
      faultScript: (request) => {
        if (request.method === 'HEAD') {
          return { status: 200, headers: headHeaders(object.bytes.byteLength, object.etag), body: '' };
        }
        if (request.method === 'GET') {
          return {
            status: 200,
            headers: headHeaders(object.bytes.byteLength, object.etag),
            chunks: [
              { data: Buffer.from(object.bytes.subarray(0, 1024)), delayMs: 20 },
              { data: Buffer.from(object.bytes.subarray(1024)), delayMs: 500 },
            ],
          };
        }
        return { status: 403, headers: {}, body: '' };
      },
    });
    try {
      const token = issueCapability(harness.signer, object);
      const controller = new AbortController();
      const response = await fetch(`${harness.origin}/d/${token}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      controller.abort();
      void reader.cancel().catch(() => undefined);
      const closed = await harness.fault.waitForPrematureClose(3_000);
      assert.ok(closed >= 1, 'the upstream R2 body must be destroyed on client abort');
      assert.ok(requestsByMethod(harness.fault, 'GET').length === 1);
    } finally {
      await stopHttpHarness(harness);
    }
  }, 10_000);

  test('R2 interruption and timeout are stable zero-body 503 errors with no redirect', async () => {
    const object = objectWith('b6', plainBytes('i11 r2 failure payload'));

    const interrupted = await startHttpHarness({
      objects: [object],
      faultScript: (request) => {
        if (request.method === 'HEAD') return { dropConnection: true };
        return { status: 500, headers: {}, body: '' };
      },
    });
    try {
      const token = issueCapability(interrupted.signer, object);
      const response = await fetch(`${interrupted.origin}/d/${token}`);
      assert.equal(response.status, 503);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('location'), null, 'no redirect');
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
    } finally {
      await stopHttpHarness(interrupted);
    }

    const timedOut = await startHttpHarness({
      objects: [object],
      upstreamTimeoutMs: 400,
      faultScript: (request) => {
        if (request.method === 'HEAD') {
          return { status: 200, headers: headHeaders(object.bytes.byteLength, object.etag), body: '' };
        }
        if (request.method === 'GET') {
          return { status: 200, headers: headHeaders(object.bytes.byteLength, object.etag), holdOpen: true };
        }
        return { status: 500, headers: {}, body: '' };
      },
    });
    try {
      const token = issueCapability(timedOut.signer, object);
      const response = await fetch(`${timedOut.origin}/d/${token}`);
      assert.equal(response.status, 503);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('location'), null);
    } finally {
      await stopHttpHarness(timedOut);
    }
  });

  test('the delivery request log never contains tokens, keys, or URLs', async () => {
    const object = objectWith('b7', plainBytes('i11 log payload'));
    const harness = await startHttpHarness({ objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const response = await fetch(`${harness.origin}/d/${token}?filename=secret.txt`);
      assert.equal(response.status, 200);
      const serialized = JSON.stringify(harness.host.requestLog as DeliveryRequestLogEntry[]);
      assert.ok(!serialized.includes(token), 'the capability token must never appear in logs');
      assert.ok(!serialized.includes(object.key), 'the R2 key must never appear in logs');
      assert.ok(!serialized.includes(harness.origin), 'URLs must never appear in logs');
      assert.ok(!serialized.includes('secret.txt'), 'filenames must never appear in logs');
    } finally {
      await stopHttpHarness(harness);
    }
  });

  test('the RO-only object store fails closed on write operations (store_read_only)', async () => {
    // The ReadOnlyBlobStorePort type already omits the write surface (compile
    // guard); this pins the RUNTIME fail-closed behavior if that boundary is
    // ever bypassed (cast/refactor). No network is needed: writes fail before
    // any request is issued.
    const roStore = createR2ReadOnlyGenerationStore({
      endpoint: 'http://127.0.0.1:9',
      region: 'auto',
      bucket: BUCKET,
      livePrefix: LIVE_PREFIX,
      probePrefix: 'attachments/probe/',
      roCredential: RO_CREDENTIAL,
      grantTtlSeconds: 60,
      singlePutMaxBytes: 5 * 1024 * 1024,
    });
    try {
      const handle = { generationId: '018f6f7a-8f2a-7a3d-a123-123456789000', key: `${LIVE_PREFIX}ro-write-fail-closed` };
      const writableView = roStore as unknown as Pick<BlobStorePort, 'issueCreateOnlyGrant' | 'deleteExact'>;
      await assert.rejects(
        writableView.issueCreateOnlyGrant(handle, {
          ttlSeconds: 60,
          contentType: 'application/octet-stream',
          contentLength: 1,
        }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'store_read_only',
        'issueCreateOnlyGrant must fail closed on a read-only store',
      );
      await assert.rejects(
        writableView.deleteExact(handle),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'store_read_only',
        'deleteExact must fail closed on a read-only store',
      );
    } finally {
      await roStore.close();
    }
  });
});
