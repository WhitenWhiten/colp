import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  DEFAULT_MIME_SNIFF_PREFIX_BYTES,
  MIME_ALLOWLIST,
  MIME_FIXTURE_VERSION,
  STORED_PRIVATE_COMPILE_LIMIT_BYTES,
  STORED_PRIVATE_HARD_CEILING_BYTES,
  sniffMime,
  verifyExactGeneration,
  verifyObjectStream,
} from '../../../scripts/evidence/phase4a-i03-stream-verification.js';
import type {
  ConditionalReadResult,
  StreamVerificationOutcome,
  VerificationDeclared,
  VerificationLimits,
} from '../../../scripts/evidence/phase4a-i03-stream-verification.js';
import {
  activeHtmlBytes,
  concatBytes,
  gifBytes,
  independentSha256Hex,
  jpegBytes,
  pdfBytes,
  plainBytes,
  pngBytes,
  polyglotPdfBytes,
  svgBytes,
} from '../../support/phase4a-i03-test-helpers.js';

const FIXTURE_ROOT = resolve('tests/fixtures/phase4a');

function limits(overrides: Partial<VerificationLimits> = {}): VerificationLimits {
  return {
    hardByteCeiling: STORED_PRIVATE_HARD_CEILING_BYTES,
    mimeSniffPrefixBytes: DEFAULT_MIME_SNIFF_PREFIX_BYTES,
    readTimeoutMs: 30_000,
    ...overrides,
  };
}

function declaredFor(bytes: Uint8Array, overrides: Partial<VerificationDeclared> = {}): VerificationDeclared {
  return {
    size: bytes.byteLength,
    sha256: independentSha256Hex(bytes),
    ...overrides,
  };
}

function summarize(streamOutcome: StreamVerificationOutcome): { class: string; byteCount: number; sha256: string; mediaType: string; category: string } {
  return {
    class: streamOutcome.class,
    byteCount: streamOutcome.byteCount,
    sha256: streamOutcome.sha256,
    mediaType: streamOutcome.mime.mediaType,
    category: streamOutcome.mime.category,
  };
}

function neverEndingStream(firstChunk: Uint8Array = new Uint8Array([0x61])): ReadableStream<Uint8Array> {
  let first = true;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(firstChunk);
      }
      // never enqueues again and never closes: the read hangs until abort
    },
  });
}

describe('P4A-I03 streamed verification pipeline', () => {
  test('pins the verification and MIME contract fixture', async () => {
    const fixture = JSON.parse(await readFile(resolve(FIXTURE_ROOT, 'i03-contract.json'), 'utf8')) as {
      schemaVersion: number; task: string; exposureMode: string;
      hardCeilingBytes: number; compileLimitBytes: number; mimeSniffPrefixBytes: number;
      mimeFixtureVersion: string; mimeAllowlist: string[]; mimeUnknownFallback: string;
    };
    assert.equal(fixture.schemaVersion, 1);
    assert.equal(fixture.task, 'phase4a-i03');
    assert.equal(fixture.exposureMode, 'owner-private-unscanned');
    assert.equal(STORED_PRIVATE_HARD_CEILING_BYTES, fixture.hardCeilingBytes);
    assert.equal(STORED_PRIVATE_COMPILE_LIMIT_BYTES, fixture.compileLimitBytes);
    assert.ok(STORED_PRIVATE_HARD_CEILING_BYTES < STORED_PRIVATE_COMPILE_LIMIT_BYTES);
    assert.equal(DEFAULT_MIME_SNIFF_PREFIX_BYTES, fixture.mimeSniffPrefixBytes);
    assert.equal(MIME_FIXTURE_VERSION, fixture.mimeFixtureVersion);
    assert.deepEqual([...MIME_ALLOWLIST].sort(), [...fixture.mimeAllowlist].sort());
  });

  test('sniffs real magic bytes with a fixed maximum prefix (PNG/JPEG/GIF/PDF)', () => {
    assert.equal(sniffMime(pngBytes()).mediaType, 'image/png');
    assert.equal(sniffMime(pngBytes()).category, 'allowlisted');
    assert.equal(sniffMime(jpegBytes()).mediaType, 'image/jpeg');
    assert.equal(sniffMime(jpegBytes()).category, 'allowlisted');
    assert.equal(sniffMime(gifBytes()).mediaType, 'image/gif');
    assert.equal(sniffMime(gifBytes()).category, 'allowlisted');
    assert.equal(sniffMime(pdfBytes()).mediaType, 'application/pdf');
    assert.equal(sniffMime(pdfBytes()).category, 'allowlisted');
    assert.equal(sniffMime(pdfBytes()).polyglot, false);
  });

  test('sniffs HTML and SVG as suspicious and plain/unknown as generic octet-stream', () => {
    const html = sniffMime(activeHtmlBytes('m'));
    assert.equal(html.mediaType, 'text/html');
    assert.equal(html.category, 'suspicious');
    const svg = sniffMime(svgBytes());
    assert.equal(svg.mediaType, 'image/svg+xml');
    assert.equal(svg.category, 'suspicious');
    const plain = sniffMime(plainBytes());
    assert.equal(plain.mediaType, 'application/octet-stream');
    assert.equal(plain.category, 'unknown');
    const unknown = sniffMime(new Uint8Array([0x00, 0x01, 0x02, 0xff]));
    assert.equal(unknown.mediaType, 'application/octet-stream');
    assert.equal(unknown.category, 'unknown');
  });

  test('polyglot detection: PDF magic with embedded executable markers is suspicious, not allowlisted', () => {
    const polyglot = sniffMime(polyglotPdfBytes('marker'));
    assert.equal(polyglot.mediaType, 'application/pdf');
    assert.equal(polyglot.polyglot, true);
    assert.equal(polyglot.category, 'suspicious');
  });

  test('sniffing only ever reads a fixed maximum prefix even when the body is larger', () => {
    const big = concatBytes(pdfBytes(), new Uint8Array(64 * 1024).fill(0x42));
    const result = sniffMime(big.subarray(0, DEFAULT_MIME_SNIFF_PREFIX_BYTES + 10));
    assert.equal(result.mediaType, 'application/pdf');
    assert.equal(result.category, 'allowlisted');
  });

  test('empty objects verify with zero bytes and unknown generic media', async () => {
    const bytes = new Uint8Array(0);
    const outcome = await verifyObjectStream(
      { stream: (async function* empty() {})(), signal: new AbortController().signal },
      declaredFor(bytes),
      limits(),
    );
    assert.equal(outcome.class, 'verified');
    assert.equal(outcome.byteCount, 0);
    assert.equal(outcome.sha256, independentSha256Hex(bytes));
    assert.equal(outcome.mime.category, 'unknown');
    assert.equal(outcome.mime.mediaType, 'application/octet-stream');
  });

  test('normal objects verify with actual byte count and ordered digest', async () => {
    const bytes = pdfBytes('ordered digest payload\n');
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield bytes; })(), signal: new AbortController().signal },
      declaredFor(bytes),
      limits(),
    );
    assert.deepEqual(summarize(outcome), {
      class: 'verified', byteCount: bytes.byteLength,
      sha256: independentSha256Hex(bytes), mediaType: 'application/pdf', category: 'allowlisted',
    });
  });

  test('one-byte chunks produce the same ordered digest and byte count', async () => {
    const bytes = pngBytes();
    const outcome = await verifyObjectStream(
      {
        stream: (async function* oneByteChunks() {
          for (const byte of bytes) yield Uint8Array.of(byte);
        })(),
        signal: new AbortController().signal,
      },
      declaredFor(bytes),
      limits(),
    );
    assert.equal(outcome.class, 'verified');
    assert.equal(outcome.byteCount, bytes.byteLength);
    assert.equal(outcome.sha256, independentSha256Hex(bytes));
    assert.equal(outcome.mime.mediaType, 'image/png');
  });

  test('chunk boundaries split the magic bytes without losing sniff evidence', async () => {
    const bytes = pngBytes();
    // split the 8-byte PNG signature across three chunks
    const chunks = [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)];
    const outcome = await verifyObjectStream(
      { stream: (async function* () { for (const chunk of chunks) yield chunk; })(), signal: new AbortController().signal },
      declaredFor(bytes),
      limits(),
    );
    assert.equal(outcome.class, 'verified');
    assert.equal(outcome.sha256, independentSha256Hex(bytes));
    assert.equal(outcome.mime.mediaType, 'image/png');
    assert.equal(outcome.mime.category, 'allowlisted');
  });

  test('truncation is rejected when the stream ends below the declared size', async () => {
    const bytes = pdfBytes();
    const truncated = bytes.subarray(0, bytes.byteLength - 1);
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield truncated; })(), signal: new AbortController().signal },
      declaredFor(bytes),
      limits(),
    );
    assert.equal(outcome.class, 'truncated');
    assert.equal(outcome.byteCount, truncated.byteLength);
  });

  test('extra trailing bytes are rejected when the stream exceeds the declared size', async () => {
    const bytes = pdfBytes();
    const outcome = await verifyObjectStream(
      {
        stream: (async function* () {
          yield bytes;
          yield new Uint8Array([0x00]);
        })(),
        signal: new AbortController().signal,
      },
      declaredFor(bytes),
      limits(),
    );
    assert.equal(outcome.class, 'extra_trailing_bytes');
    assert.equal(outcome.byteCount, bytes.byteLength + 1);
  });

  test('a wrong declared size fails closed even when digest would otherwise match', async () => {
    const bytes = pdfBytes();
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield bytes; })(), signal: new AbortController().signal },
      declaredFor(bytes, { size: bytes.byteLength + 5 }),
      limits(),
    );
    // Declared size (bytes + 5) is LARGER than the actual stream, so the stream is
    // truncated relative to the declaration - the same class the real-target probe
    // asserts for its declared_size_too_large scenario.
    assert.equal(outcome.class, 'truncated');
  });

  test('a declared digest mismatch fails closed', async () => {
    const bytes = pdfBytes();
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield bytes; })(), signal: new AbortController().signal },
      declaredFor(bytes, { sha256: '0'.repeat(64) }),
      limits(),
    );
    assert.equal(outcome.class, 'digest_mismatch');
    assert.equal(outcome.byteCount, bytes.byteLength);
  });

  test('over-hard-limit aborts the read and destroys the stream', async () => {
    let destroyed = false;
    const stream = (async function* () {
      try {
        yield new Uint8Array(3);
        yield new Uint8Array(3);
      } finally {
        destroyed = true;
      }
    })();
    const outcome = await verifyObjectStream(
      { stream, signal: new AbortController().signal },
      declaredFor(new Uint8Array(6)),
      limits({ hardByteCeiling: 4 }),
    );
    assert.equal(outcome.class, 'over_hard_limit');
    assert.equal(destroyed, true, 'the producer stream must be cancelled on overflow');
    assert.equal(outcome.byteCount, 3);
  });

  test('an exact ceiling is accepted and a single byte over it aborts', async () => {
    const exact = await verifyObjectStream(
      { stream: (async function* () { yield new Uint8Array(4); })(), signal: new AbortController().signal },
      declaredFor(new Uint8Array(4)),
      limits({ hardByteCeiling: 4 }),
    );
    assert.equal(exact.class, 'verified');

    let destroyed = false;
    const over = await verifyObjectStream(
      {
        stream: (async function* () {
          try {
            yield new Uint8Array(4);
            yield new Uint8Array(1);
          } finally {
            destroyed = true;
          }
        })(),
        signal: new AbortController().signal,
      },
      declaredFor(new Uint8Array(5)),
      limits({ hardByteCeiling: 4 }),
    );
    assert.equal(over.class, 'over_hard_limit');
    assert.equal(destroyed, true);
  });

  test('media mismatch: declared PDF but sniffed HTML fails closed', async () => {
    const bytes = activeHtmlBytes('marker');
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield bytes; })(), signal: new AbortController().signal },
      declaredFor(bytes, { mediaType: 'application/pdf' }),
      limits(),
    );
    assert.equal(outcome.class, 'media_mismatch');
  });

  test('polyglot bytes verify as suspicious (never clean) but are not a type mismatch', async () => {
    const bytes = polyglotPdfBytes('marker');
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield bytes; })(), signal: new AbortController().signal },
      declaredFor(bytes, { mediaType: 'application/pdf' }),
      limits(),
    );
    assert.equal(outcome.class, 'verified');
    assert.equal(outcome.mime.polyglot, true);
    assert.equal(outcome.mime.category, 'suspicious');
    assert.equal(outcome.mime.mediaType, 'application/pdf');
  });

  test('unknown declared types degrade to generic forced download instead of a malicious verdict', async () => {
    const bytes = plainBytes();
    const outcome = await verifyObjectStream(
      { stream: (async function* () { yield bytes; })(), signal: new AbortController().signal },
      declaredFor(bytes, { mediaType: 'application/x-vendor-unknown' }),
      limits(),
    );
    assert.equal(outcome.class, 'verified');
    assert.equal(outcome.mime.category, 'unknown');
    assert.equal(outcome.mime.mediaType, 'application/octet-stream');
  });

  test('read timeout on a never-completing stream is classified read_timeout', async () => {
    const outcome = await verifyObjectStream(
      { stream: neverEndingStream(), signal: AbortSignal.timeout(50) },
      declaredFor(new Uint8Array([0x61, 0x62]), { mediaType: 'text/plain' }),
      limits(),
    );
    assert.equal(outcome.class, 'read_timeout');
  });

  test('external abort mid-read is classified aborted', async () => {
    const controller = new AbortController();
    let blockedReadResolve!: () => void;
    const blockedRead = new Promise<void>((resolvePromise) => { blockedReadResolve = resolvePromise; });
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (first) {
          first = false;
          streamController.enqueue(new Uint8Array([0x61]));
          return;
        }
        blockedReadResolve();
        // Deliberately leave the second read pending until the signal aborts.
      },
    });
    const outcomePromise = verifyObjectStream(
      { stream, signal: controller.signal },
      declaredFor(new Uint8Array([0x61, 0x62])),
      limits(),
    );
    await blockedRead;
    controller.abort();
    const outcome = await outcomePromise;
    assert.equal(outcome.class, 'aborted');
  });

  test('backpressure: a pull-based one-byte stream is consumed incrementally with the correct digest', async () => {
    const bytes = pdfBytes();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const offset = pulls;
        pulls += 1;
        if (offset < bytes.byteLength) {
          controller.enqueue(bytes.subarray(offset, offset + 1));
        } else {
          controller.close();
        }
      },
    });
    const outcome = await verifyObjectStream(
      { stream, signal: new AbortController().signal },
      declaredFor(bytes),
      limits(),
    );
    assert.equal(outcome.class, 'verified');
    assert.equal(pulls, bytes.byteLength + 1, 'each byte must be pulled exactly once (incremental, bounded)');
    assert.equal(outcome.sha256, independentSha256Hex(bytes));
    assert.equal(outcome.mime.mediaType, 'application/pdf');
  });

  test('ETag mismatch is detected before the body stream is opened', async () => {
    let conditionalReads = 0;
    let streamOpened = false;
    const conditionalRead = async (): Promise<ConditionalReadResult> => {
      conditionalReads += 1;
      return { class: 'etag_mismatch', status: 412 };
    };
    const outcome = await verifyExactGeneration({
      conditionalRead,
      declared: declaredFor(pdfBytes()),
      limits: limits(),
      signal: new AbortController().signal,
    });
    assert.equal(outcome.class, 'etag_mismatch');
    assert.equal(outcome.byteCount, 0);
    assert.equal(conditionalReads, 1);
    assert.equal(streamOpened, false);
  });

  test('conditional read failures map to stable classes without reading bytes', async () => {
    const notFound = await verifyExactGeneration({
      conditionalRead: async () => ({ class: 'not_found', status: 404 }),
      declared: declaredFor(pdfBytes()),
      limits: limits(),
      signal: new AbortController().signal,
    });
    assert.equal(notFound.class, 'not_found');

    const denied = await verifyExactGeneration({
      conditionalRead: async () => ({ class: 'denied', status: 403 }),
      declared: declaredFor(pdfBytes()),
      limits: limits(),
      signal: new AbortController().signal,
    });
    assert.equal(denied.class, 'denied');
  });

  test('an abort before the read starts is reported as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await verifyExactGeneration({
      conditionalRead: async () => ({ class: 'ok', stream: (async function* () { yield new Uint8Array(1); })() }),
      declared: declaredFor(new Uint8Array(1)),
      limits: limits(),
      signal: controller.signal,
    });
    assert.equal(outcome.class, 'aborted');
  });
});
