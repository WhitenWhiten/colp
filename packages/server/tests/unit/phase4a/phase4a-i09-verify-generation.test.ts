import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'vitest';
import {
  ATTACHMENTS_READ_OVERFLOW_ERROR_CODE,
  ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES,
  ATTACHMENTS_VERIFICATION_POLICY_VERSION,
  sniffMime,
  storedMediaTypeForEvidence,
  verifyEvidenceShape,
  verifyGenerationStream,
  type VerificationEvidence,
  type VerificationLimits,
} from '../../../src/modules/attachments/index.js';

const LIMITS: VerificationLimits = {
  hardByteCeiling: 64,
  mimeSniffPrefixBytes: ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES,
};

function independentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bodyOf(bytes: number, magic: Uint8Array = new Uint8Array()): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set(magic);
  for (let index = magic.byteLength; index < bytes; index += 1) body[index] = index % 251;
  return body;
}

async function* chunked(bytes: Uint8Array, chunk = 5): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    yield bytes.subarray(offset, Math.min(offset + chunk, bytes.byteLength));
  }
}

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = new TextEncoder().encode('%PDF-1.7');

function run(stream: AsyncIterable<Uint8Array>, declared: { size: number; sha256?: string | null; mediaType?: string | null }, signal: AbortSignal, limits: VerificationLimits = LIMITS) {
  return verifyGenerationStream({ stream, signal }, {
    size: declared.size,
    sha256: declared.sha256 ?? null,
    mediaType: declared.mediaType ?? null,
  }, limits);
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

describe('P4A-I09 verification pipeline: ordered bytes and boundaries', () => {
  test('empty object verifies with byteCount 0 and the empty digest', async () => {
    const evidence = await run(chunked(new Uint8Array(0), 1), { size: 0 }, neverAborted());
    assert.equal(evidence.verdict, 'verified');
    assert.equal(evidence.byteCount, 0);
    assert.equal(evidence.sha256, independentSha256(new Uint8Array(0)));
  });

  test('digest is computed over ACTUAL ordered bytes regardless of chunk size', async () => {
    const body = bodyOf(33, PNG);
    const expected = independentSha256(body);
    for (const chunk of [1, 3, 7, 16, 33, 64]) {
      const evidence = await run(chunked(body, chunk), {
        size: body.byteLength, sha256: expected, mediaType: 'image/png',
      }, neverAborted());
      assert.equal(evidence.verdict, 'verified', `chunk size ${chunk} must not change the verdict`);
      assert.equal(evidence.sha256, expected, `chunk size ${chunk} must not change the digest`);
      assert.equal(evidence.byteCount, body.byteLength);
    }
  });

  test('exact ceiling boundary verifies; ceiling+1 is over_hard_limit and cancels the stream', async () => {
    const at = bodyOf(LIMITS.hardByteCeiling);
    const atEvidence = await run(chunked(at), { size: at.byteLength, sha256: independentSha256(at) }, neverAborted());
    assert.equal(atEvidence.verdict, 'verified');

    let cancelled = false;
    const over = bodyOf(LIMITS.hardByteCeiling + 1);
    const cancellable = {
      cancel: async () => { cancelled = true; },
      [Symbol.asyncIterator]: async function* () {
        for (let offset = 0; offset < over.byteLength; offset += 10) {
          yield over.subarray(offset, Math.min(offset + 10, over.byteLength));
        }
      },
    };
    const evidence = await run(cancellable, { size: over.byteLength }, neverAborted());
    assert.equal(evidence.verdict, 'over_hard_limit');
    // bytesProcessed is the ACTUAL bytes consumed before the overflowing chunk
    // (chunk-size dependent by contract, never more than the ceiling).
    assert.ok(evidence.bytesProcessed > 0, 'some bytes were processed before the overflow');
    assert.ok(evidence.bytesProcessed <= LIMITS.hardByteCeiling, 'bytesProcessed must never exceed the ceiling');
    assert.equal(cancelled, true, 'the upstream stream must be cancelled on overflow');
  });

  test('truncation and extra trailing bytes are distinct failures', async () => {
    const body = bodyOf(20, PNG);
    const truncated = await run(chunked(body.subarray(0, 12)), { size: 20 }, neverAborted());
    assert.equal(truncated.verdict, 'truncated');
    assert.equal(truncated.byteCount, 12);

    const extra = bodyOf(24, PNG);
    const extraEvidence = await run(chunked(extra), { size: 20 }, neverAborted());
    assert.equal(extraEvidence.verdict, 'extra_trailing_bytes');
    assert.equal(extraEvidence.byteCount, 24);
  });

  test('a digest mismatch reports the ACTUAL digest', async () => {
    const body = bodyOf(16, PNG);
    const evidence = await run(chunked(body), {
      size: 16, sha256: 'f'.repeat(64), mediaType: 'image/png',
    }, neverAborted());
    assert.equal(evidence.verdict, 'digest_mismatch');
    assert.equal(evidence.sha256, independentSha256(body));
  });

  test('a stream that throws the overflow code is classified over_hard_limit', async () => {
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        yield new Uint8Array(10);
        const error = new Error('exceeded byte ceiling 64');
        (error as { code?: string }).code = ATTACHMENTS_READ_OVERFLOW_ERROR_CODE;
        throw error;
      },
    };
    const evidence = await run(stream, { size: 100 }, neverAborted());
    assert.equal(evidence.verdict, 'over_hard_limit');
  });
});

describe('P4A-I09 verification pipeline: MIME evidence', () => {
  test('real magic bytes sniff to allowlisted media', () => {
    assert.deepEqual(sniffMime(PNG), { mediaType: 'image/png', category: 'allowlisted', polyglot: false });
    assert.equal(sniffMime(PDF).mediaType, 'application/pdf');
  });

  test('unknown bytes degrade to generic octet-stream (never malware)', async () => {
    const body = bodyOf(16);
    const evidence = await run(chunked(body), { size: 16, mediaType: 'image/png' }, neverAborted());
    assert.equal(evidence.verdict, 'verified');
    assert.equal(evidence.sniffedMediaType, 'application/octet-stream');
    assert.equal(evidence.mediaCategory, 'unknown');
    assert.equal(storedMediaTypeForEvidence(evidence), 'application/octet-stream');
  });

  test('a declared allowlisted media that contradicts the bytes is a media mismatch', async () => {
    const body = bodyOf(16, PDF);
    const evidence = await run(chunked(body), { size: 16, mediaType: 'image/png' }, neverAborted());
    assert.equal(evidence.verdict, 'media_mismatch');
  });

  test('polyglot content (PNG magic + HTML markers) is suspicious, never clean', async () => {
    const polyglot = new Uint8Array(64);
    polyglot.set(PNG);
    polyglot.set(new TextEncoder().encode('<script>alert(1)</script>'), 8);
    const evidence = await run(chunked(polyglot), { size: 64, mediaType: 'image/png' }, neverAborted());
    assert.equal(evidence.verdict, 'verified', 'matching magic bytes still verify; the content is only suspicious');
    assert.equal(evidence.mediaCategory, 'suspicious');
    assert.equal(evidence.polyglot, true);
    assert.equal(storedMediaTypeForEvidence(evidence), 'application/octet-stream', 'suspicious content stores as generic forced download');
  });

  test('suspicious HTML stores as generic octet-stream', async () => {
    const html = new TextEncoder().encode('<!doctype html><html><body>hi</body></html>');
    const evidence = await run(chunked(html), { size: html.byteLength, mediaType: 'text/plain' }, neverAborted());
    assert.equal(evidence.verdict, 'verified');
    assert.equal(evidence.mediaCategory, 'suspicious');
    assert.equal(storedMediaTypeForEvidence(evidence), 'application/octet-stream');
  });
});

describe('P4A-I09 verification pipeline: abort/timeout and evidence shape', () => {
  test('an abort mid-stream is classified aborted (unified)', async () => {
    const controller = new AbortController();
    const body = bodyOf(64, PNG);
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        yield body.subarray(0, 8);
        controller.abort(new Error('boom'));
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    };
    const evidence = await run(stream, { size: 64 }, controller.signal);
    assert.equal(evidence.verdict, 'aborted');
    assert.equal(evidence.byteCount, 8);
  });

  test('a timeout abort is classified read_timeout', async () => {
    const controller = new AbortController();
    let readStartedResolve!: () => void;
    const readStarted = new Promise<void>((resolve) => { readStartedResolve = resolve; });
    const pendingRead = new Promise<IteratorResult<Uint8Array>>(() => {});
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            readStartedResolve();
            return pendingRead;
          },
        };
      },
    };
    const evidencePromise = run(stream, { size: 10 }, controller.signal);
    await readStarted;
    const error = new Error('timeout');
    error.name = 'TimeoutError';
    controller.abort(error);
    const evidence = await evidencePromise;
    assert.equal(evidence.verdict, 'read_timeout');
  });

  test('evidence is a closed allowlist and never claims clean or safe', async () => {
    const body = bodyOf(16, PNG);
    const evidence = await run(chunked(body), { size: 16, sha256: independentSha256(body), mediaType: 'image/png' }, neverAborted());
    assert.equal(evidence.verdict, 'verified');
    assert.ok(verifyEvidenceShape(evidence));
    assert.deepEqual(Object.keys(evidence).sort(), [
      'byteCount', 'bytesProcessed', 'mediaCategory', 'policyVersion',
      'polyglot', 'sha256', 'sniffedMediaType', 'verdict',
    ].sort());
    const json = JSON.stringify(evidence);
    assert.equal(json.includes('"clean"'), false);
    assert.equal(json.includes('"safe"'), false);
    assert.equal(json.includes('scanner'), false);
    assert.equal(evidence.policyVersion, ATTACHMENTS_VERIFICATION_POLICY_VERSION);
  });

  test('verifyEvidenceShape rejects extra fields and clean/safe verdicts', () => {
    const valid: VerificationEvidence = {
      verdict: 'verified', byteCount: 0, sha256: 'a'.repeat(64),
      sniffedMediaType: 'application/octet-stream', mediaCategory: 'unknown',
      polyglot: false, policyVersion: ATTACHMENTS_VERIFICATION_POLICY_VERSION, bytesProcessed: 0,
    };
    assert.equal(verifyEvidenceShape(valid), true);
    assert.equal(verifyEvidenceShape({ ...valid, safe: true }), false);
    assert.equal(verifyEvidenceShape({ ...valid, clean: true }), false);
    assert.equal(verifyEvidenceShape({ ...valid, verdict: 'clean' }), false);
    assert.equal(verifyEvidenceShape({ ...valid, extra: 1 }), false);
  });
});
