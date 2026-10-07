/**
 * FO-02 pure policy units: provider URL resolution / hostname normalization /
 * failure classification / retry scheduling, image structural decoding, and
 * GC eligibility. No I/O — the workers' transport and storage boundaries are
 * covered by the integration suite.
 */
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'vitest';
import {
  FAVICON_MAX_DECOMPRESSED_RATIO,
  classifyFaviconFetchFailure,
  faviconHostnameFromBookmarkUrl,
  isFaviconFetchSuccessStatus,
  isFaviconLiteralIpHostname,
  isFaviconReservedHostname,
  nextFaviconAttemptAt,
  normalizeFaviconHostname,
  resolveFaviconProviderUrl,
} from '../../../src/modules/collections/application/favicon-fetch-policy.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  BookmarkFaviconImageError,
} from '../../../src/modules/collections/application/favicon-store.js';
import {
  FAVICON_DEFAULT_MAX_DECOMPRESSED_BYTES,
  decodeFaviconImage,
  faviconCrc32,
} from '../../../src/modules/collections/application/favicon-image-decode.js';
import {
  FAVICON_GC_MAX_ATTEMPTS,
  isFaviconGcActionable,
  nextFaviconGcAttemptAt,
} from '../../../src/modules/collections/application/favicon-job-execution.js';
import { iconSourceActsOnline } from '../../../src/modules/collections/application/favicon-icon-source.js';
import { processFaviconGcClaim } from '../../../src/modules/collections/application/favicon-gc.js';
import { HardenedEgressError } from '../../../src/infrastructure/egress/index.js';

/** Build a fully valid (CRC-correct, inflatable) PNG. */
function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // truecolor
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (1 + width * 3)] = 0; // filter none
  }
  const idat = deflateSync(scanlines);
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(8 + data.byteLength + 4);
    out.writeUInt32BE(data.byteLength, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(faviconCrc32(Buffer.concat([out.subarray(4, 8), data])), 8 + data.byteLength);
    return out;
  };
  return Buffer.concat([signature, chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const PNG = buildPng(2, 2);

test('normalizeFaviconHostname: lowercases, strips dots/zones, rejects literals and reserved', () => {
  assert.equal(normalizeFaviconHostname('Example.COM.'), 'example.com');
  assert.equal(normalizeFaviconHostname('[2001:db8::1]'), null);
  assert.equal(normalizeFaviconHostname('192.168.1.1'), null);
  assert.equal(normalizeFaviconHostname('0x7f000001'), null);
  assert.equal(normalizeFaviconHostname('localhost'), null);
  assert.equal(normalizeFaviconHostname('svc.internal'), null);
  assert.equal(normalizeFaviconHostname(''), null);
  assert.equal(normalizeFaviconHostname('a/b'), null);
  assert.equal(normalizeFaviconHostname('user@host'), null);
  assert.equal(normalizeFaviconHostname('sub.host.example.org'), 'sub.host.example.org');
});

test('isFaviconLiteralIpHostname / isFaviconReservedHostname classify hard forms', () => {
  assert.equal(isFaviconLiteralIpHostname('127.0.0.1'), true);
  assert.equal(isFaviconLiteralIpHostname('10.1.2.3'), true);
  assert.equal(isFaviconLiteralIpHostname('2130706433'), true);
  assert.equal(isFaviconLiteralIpHostname('0x7f000001'), true);
  assert.equal(isFaviconLiteralIpHostname('::1'), true);
  assert.equal(isFaviconLiteralIpHostname('example.com'), false);
  assert.equal(isFaviconReservedHostname('localhost'), true);
  assert.equal(isFaviconReservedHostname('foo.local'), true);
  assert.equal(isFaviconReservedHostname('foo.internal.'), true);
  assert.equal(isFaviconReservedHostname('foo.example'), true);
  assert.equal(isFaviconReservedHostname('example.com'), false);
});

test('faviconHostnameFromBookmarkUrl accepts only http(s) without userinfo', () => {
  assert.equal(faviconHostnameFromBookmarkUrl('https://Example.com/page?q=1'), 'example.com');
  assert.equal(faviconHostnameFromBookmarkUrl('http://sub.host.example.org/a'), 'sub.host.example.org');
  assert.equal(faviconHostnameFromBookmarkUrl('ftp://example.com/x'), null);
  assert.equal(faviconHostnameFromBookmarkUrl('https://user:pass@example.com/'), null);
  assert.equal(faviconHostnameFromBookmarkUrl('https://192.168.1.1/'), null);
  assert.equal(faviconHostnameFromBookmarkUrl('not a url'), null);
});

test('resolveFaviconProviderUrl: default template resolves; unsafe shapes rejected', () => {
  assert.equal(
    resolveFaviconProviderUrl('https://favicone.com/{hostname}', 'Example.CO'),
    'https://favicone.com/example.co',
  );
  assert.equal(resolveFaviconProviderUrl('https://icons.duckduckgo.com/ip3/{hostname}.ico', 'example.com'),
    'https://icons.duckduckgo.com/ip3/example.com.ico');
  // Exactly one {hostname}; a template without it cannot be authorized.
  assert.equal(resolveFaviconProviderUrl('https://favicone.com/no-marker', 'example.com'), null);
  assert.equal(resolveFaviconProviderUrl('https://favicone.com/{hostname}/{hostname}', 'example.com'), null);
  // Non-HTTPS / userinfo / fragments / non-443 ports are rejected.
  assert.equal(resolveFaviconProviderUrl('http://favicone.com/{hostname}', 'example.com'), null);
  assert.equal(resolveFaviconProviderUrl('https://user:pass@favicone.com/{hostname}', 'example.com'), null);
  assert.equal(resolveFaviconProviderUrl('https://favicone.com/{hostname}#frag', 'example.com'), null);
  assert.equal(resolveFaviconProviderUrl('https://favicone.com:8443/{hostname}', 'example.com'), null);
  // A literal-IP or reserved provider host is refused even before DNS.
  assert.equal(resolveFaviconProviderUrl('https://127.0.0.1/{hostname}', 'example.com'), null);
  assert.equal(resolveFaviconProviderUrl('https://internal/{hostname}', 'example.com'), null);
  // A literal bookmark hostname cannot become the fetch target via the path.
  assert.equal(resolveFaviconProviderUrl('https://favicone.com/{hostname}', '10.0.0.1'), null);
});

test('classifyFaviconFetchFailure maps egress denials to unsafe_source, others to fetch_failed', () => {
  assert.equal(classifyFaviconFetchFailure(new HardenedEgressError('denied_address', 'x')), 'unsafe_source');
  assert.equal(classifyFaviconFetchFailure(new HardenedEgressError('invalid_url', 'x')), 'unsafe_source');
  assert.equal(classifyFaviconFetchFailure(new HardenedEgressError('dns_failure', 'x')), 'unsafe_source');
  assert.equal(classifyFaviconFetchFailure(new HardenedEgressError('too_many_redirects', 'x')), 'fetch_failed');
  assert.equal(classifyFaviconFetchFailure(new DOMException('timeout', 'AbortError')), 'fetch_failed');
  assert.equal(classifyFaviconFetchFailure(new Error('ECONNRESET')), 'fetch_failed');
  assert.equal(isFaviconFetchSuccessStatus(200), true);
  assert.equal(isFaviconFetchSuccessStatus(301), false);
  assert.equal(isFaviconFetchSuccessStatus(500), false);
});

test('nextFaviconAttemptAt follows the backoff schedule and stops at max attempts', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');
  const schedule = [1, 2, 4, 8, 16];
  assert.equal(nextFaviconAttemptAt(1, 5, schedule, now)?.getTime(), now.getTime() + 1_000);
  assert.equal(nextFaviconAttemptAt(2, 5, schedule, now)?.getTime(), now.getTime() + 2_000);
  assert.equal(nextFaviconAttemptAt(4, 5, schedule, now)?.getTime(), now.getTime() + 8_000);
  // attempt 5 >= max 5 → exhausted.
  assert.equal(nextFaviconAttemptAt(5, 5, schedule, now), null);
  // Clamps past the schedule end.
  assert.equal(nextFaviconAttemptAt(10, 20, schedule, now)?.getTime(), now.getTime() + 16_000);
  // Empty schedule degrades to a 1s retry.
  assert.equal(nextFaviconAttemptAt(1, 5, [], now)?.getTime(), now.getTime() + 1_000);
});

test('decodeFaviconImage: real PNG decodes with identity and dimensions preserved', () => {
  const decoded = decodeFaviconImage(PNG);
  assert.equal(decoded.mime, 'image/png');
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
});

test('decodeFaviconImage: rejects HTML, GIF, SVG, CUR, truncation and oversize', () => {
  for (const bad of [
    '<html><body>x</body></html>',
    Buffer.from('GIF89a........', 'ascii'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00]),
    PNG.subarray(0, 20),
  ]) {
    assert.throws(() => decodeFaviconImage(Buffer.isBuffer(bad) ? bad : Buffer.from(bad)), BookmarkFaviconImageError);
  }
  const oversized = Buffer.concat([PNG, Buffer.alloc(BOOKMARK_FAVICON_MAX_BYTES + 1 - PNG.byteLength, 0)]);
  assert.throws(() => decodeFaviconImage(oversized, BOOKMARK_FAVICON_MAX_BYTES), BookmarkFaviconImageError);
});

test('decodeFaviconImage: decompressed scanline size is verified against the budget', () => {
  // 4096x4096 truecolor claims an ~50MB pixel stream; a tiny budget must fail
  // the decompressed-size check before any allocation.
  const giant = buildPng(4096, 4096);
  assert.throws(() => decodeFaviconImage(giant, BOOKMARK_FAVICON_MAX_BYTES, 1_000), BookmarkFaviconImageError);
  // The same bytes under an ample budget decode fine.
  const decoded = decodeFaviconImage(giant, BOOKMARK_FAVICON_MAX_BYTES, 512 * 1024 * 1024);
  assert.equal(decoded.width, 4096);
  // CRC-32 helper sanity: the standard 4-byte value for "1234".
  assert.equal(faviconCrc32(Buffer.from([0x31, 0x32, 0x33, 0x34])), 0x9be3e0a3);
});

test('decodeFaviconImage: ICO-embedded PNG inflation is bounded by the shared decompressed budget', () => {
  // A 2048x2048 truecolor PNG inflates to ~12.6MB of scanlines but deflates to
  // a few KB, so the whole ICO fits inside the 64KB wire cap while driving a
  // large allocation if the embedding path budgeted by dimensions alone (the
  // old 4096^2*8 allowance admitted ~134MB from a tiny file inside the worker
  // decode path). The embedded PNG must share the default 4MB budget, which is
  // still far above any real ICO entry (the format bounds entries at 256x256).
  const giant = buildPng(2048, 2048);
  const ico = Buffer.alloc(6 + 16 + giant.byteLength);
  ico.writeUInt16LE(1, 2); // type = icon
  ico.writeUInt16LE(1, 4); // one image
  ico[6] = 0; // width byte 0 => 256
  ico[7] = 0; // height byte 0 => 256
  ico.writeUInt16LE(32, 6 + 6); // bit count
  ico.writeUInt32LE(giant.byteLength, 6 + 8); // payload size
  ico.writeUInt32LE(6 + 16, 6 + 12); // payload offset
  giant.copy(ico, 6 + 16);
  assert.ok(ico.byteLength <= BOOKMARK_FAVICON_MAX_BYTES,
    'the fixture must stay inside the wire cap for the inflation to be reachable');
  assert.throws(() => decodeFaviconImage(ico), BookmarkFaviconImageError);

  // A real-size embedded icon (256x256 RGBA is the format maximum) decodes.
  const small = buildPng(256, 256);
  const smallIco = Buffer.alloc(6 + 16 + small.byteLength);
  smallIco.writeUInt16LE(1, 2);
  smallIco.writeUInt16LE(1, 4);
  smallIco[6] = 0;
  smallIco[7] = 0;
  smallIco.writeUInt16LE(32, 6 + 6);
  smallIco.writeUInt32LE(small.byteLength, 6 + 8);
  smallIco.writeUInt32LE(6 + 16, 6 + 12);
  small.copy(smallIco, 6 + 16);
  const decoded = decodeFaviconImage(smallIco);
  assert.equal(decoded.mime, 'image/x-icon');
  assert.equal(decoded.width, 256);
  assert.equal(decoded.height, 256);
});

test('decodeFaviconImage: JPEG marker walk accepts a valid JPEG and rejects truncation', () => {
  // SOI + SOF0 (1x1, 8-bit, one component) + EOI is structurally complete.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
  const decoded = decodeFaviconImage(jpeg);
  assert.equal(decoded.mime, 'image/jpeg');
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.throws(() => decodeFaviconImage(jpeg.subarray(0, jpeg.byteLength - 1)), BookmarkFaviconImageError);
  assert.throws(() => decodeFaviconImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), BookmarkFaviconImageError);
});

test('decodeFaviconImage: WebP RIFF structure (VP8L) and ICO directory entry decode', () => {
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8L', 'ascii'),
    Buffer.alloc(4),
    Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]),
  ]);
  webp.writeUInt32LE(webp.byteLength - 8, 4);
  webp.writeUInt32LE(5, 12 + 4);
  const decoded = decodeFaviconImage(webp);
  assert.equal(decoded.mime, 'image/webp');
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);

  // ICO containing one 16-byte directory entry pointing at an embedded PNG.
  const embedded = buildPng(1, 1);
  const ico = Buffer.alloc(6 + 16 + embedded.byteLength);
  ico.writeUInt16LE(1, 2); // type = icon
  ico.writeUInt16LE(1, 4); // one image
  ico[6] = 1; // width
  ico[7] = 1; // height
  ico.writeUInt16LE(32, 6 + 6); // bit count
  ico.writeUInt32LE(embedded.byteLength, 6 + 8); // size
  ico.writeUInt32LE(6 + 16, 6 + 12); // offset
  embedded.copy(ico, 6 + 16);
  const icoDecoded = decodeFaviconImage(ico);
  assert.equal(icoDecoded.mime, 'image/x-icon');
  assert.equal(icoDecoded.width, 1);
  assert.equal(icoDecoded.height, 1);
});

test('decodeFaviconImage: standard lossy WebP (VP8 with frame tag) is accepted and dims decode', () => {
  // Real encoders (libwebp/ImageMagick) always emit the 3-byte VP8 frame tag
  // before the 0x9d 0x01 0x2a start code (RFC 6386 §9.1/§9.5). Layout of a
  // 720x480 key frame: tag b0 27 02, start code 9d 01 2a, 14-bit LE dims.
  const frameTag = Buffer.from([0xb0, 0x27, 0x02]);
  const startCode = Buffer.from([0x9d, 0x01, 0x2a]);
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(720, 0);
  dims.writeUInt16LE(480, 2);
  const buildChunk = (payload: Buffer): Buffer => {
    const out = Buffer.concat([
      Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'),
      Buffer.from('VP8 '), Buffer.alloc(4), payload,
    ]);
    out.writeUInt32LE(out.byteLength - 8, 4);
    out.writeUInt32LE(payload.byteLength, 12 + 4);
    return out;
  };
  const decoded = decodeFaviconImage(buildChunk(Buffer.concat([frameTag, startCode, dims])));
  assert.equal(decoded.mime, 'image/webp');
  assert.equal(decoded.width, 720);
  assert.equal(decoded.height, 480);

  // A frame tag with nonzero partition/version bits still parses.
  const altTag = Buffer.from([0x90, 0x03, 0x00]);
  const alt = decodeFaviconImage(buildChunk(Buffer.concat([altTag, startCode, dims])));
  assert.equal(alt.width, 720);
  assert.equal(alt.height, 480);

  // The old broken expectation (start code at payload offset 0) is rejected:
  // those bytes are the frame tag and can never equal the start code.
  assert.throws(
    () => decodeFaviconImage(buildChunk(Buffer.concat([startCode, dims, Buffer.alloc(3)]))),
    BookmarkFaviconImageError,
  );

  // Truncation: missing start code or missing dims are rejected.
  assert.throws(() => decodeFaviconImage(buildChunk(Buffer.concat([frameTag, startCode]))),
    BookmarkFaviconImageError);
  assert.throws(() => decodeFaviconImage(buildChunk(frameTag)), BookmarkFaviconImageError);
  assert.throws(() => decodeFaviconImage(buildChunk(Buffer.alloc(0))), BookmarkFaviconImageError);
});

test('decompressed budget constant and ratio are coherent', () => {
  assert.equal(FAVICON_MAX_DECOMPRESSED_RATIO, 64);
  assert.equal(FAVICON_DEFAULT_MAX_DECOMPRESSED_BYTES, BOOKMARK_FAVICON_MAX_BYTES * 64);
});

test('iconSourceActsOnline: inherit follows the account default, uploaded/none never act online', () => {
  for (const newDefault of ['capture', 'online', 'none'] as const) {
    assert.equal(iconSourceActsOnline({ sourceMode: 'online', newDefault }), true,
      `explicit online under ${newDefault}`);
  }
  for (const newDefault of ['capture', 'none'] as const) {
    assert.equal(iconSourceActsOnline({ sourceMode: null, newDefault }), false,
      `untouched inherit under ${newDefault}`);
    assert.equal(iconSourceActsOnline({ sourceMode: 'inherit', newDefault }), false,
      `explicit inherit under ${newDefault}`);
  }
  assert.equal(iconSourceActsOnline({ sourceMode: null, newDefault: 'online' }), true,
    'untouched inherit under an online default acts online');
  assert.equal(iconSourceActsOnline({ sourceMode: 'inherit', newDefault: 'online' }), true,
    'explicit inherit under an online default acts online');
  for (const mode of ['uploaded', 'none'] as const) {
    assert.equal(iconSourceActsOnline({ sourceMode: mode, newDefault: 'online' }), false,
      `${mode} never acts online`);
  }
});

test('GC eligibility: only past-window records are actionable', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');
  const past = new Date(now.getTime() - 1_000);
  const future = new Date(now.getTime() + 1_000);
  assert.equal(isFaviconGcActionable({ deletableAt: past }, now), true);
  assert.equal(isFaviconGcActionable({ deletableAt: future }, now), false);
  assert.equal(FAVICON_GC_MAX_ATTEMPTS, 10);
  assert.equal(nextFaviconGcAttemptAt(0, [1, 2, 4, 8, 16], now).getTime(), now.getTime() + 1_000);
  assert.equal(nextFaviconGcAttemptAt(4, [1, 2, 4, 8, 16], now).getTime(), now.getTime() + 16_000);
});

test('GC processing: referenced object is never deleted; delete failure schedules retry', async () => {
  const now = () => new Date('2026-09-14T00:00:00.000Z');
  const deleted: string[] = [];
  let failDelete = false;
  const store = {
    async delete(objectId: string) {
      if (failDelete) throw new Error('storage_unavailable');
      deleted.push(objectId);
    },
  };
  const retries: Array<{ attempts: number; nextAttemptAt: Date }> = [];
  const repository = {
    async isObjectReferenced() { return true; },
    async markDeleted() { return true; },
    async scheduleRetry(input: { attempts: number; nextAttemptAt: Date }) { retries.push(input); return true; },
  };
  const referenced = await processFaviconGcClaim({
    store, repository, backoffSeconds: [1], now,
  }, { objectId: 'o1', leaseOwner: 'w', nodeId: 'n', collectionId: 'c', deletableAt: new Date(0), attempts: 0 });
  assert.equal(referenced.outcome, 'reference_held');
  assert.deepEqual(deleted, []);
  assert.equal(retries.length, 1);

  failDelete = true;
  const failing = await processFaviconGcClaim({
    store,
    repository: { ...repository, isObjectReferenced: async () => false },
    backoffSeconds: [1],
    now,
  }, { objectId: 'o2', leaseOwner: 'w', nodeId: 'n', collectionId: 'c', deletableAt: new Date(0), attempts: 0 });
  assert.equal(failing.outcome, 'retry_scheduled');

  failDelete = false;
  const ok = await processFaviconGcClaim({
    store,
    repository: { ...repository, isObjectReferenced: async () => false },
    backoffSeconds: [1],
    now,
  }, { objectId: 'o2', leaseOwner: 'w', nodeId: 'n', collectionId: 'c', deletableAt: new Date(0), attempts: 1 });
  assert.equal(ok.outcome, 'deleted');
  assert.deepEqual(deleted, ['o2']);
});

test('ICO rejects repeated payloads, oversized directories and cumulative decode budgets', () => {
  const png = buildPng(256, 256);
  const makeIco = (count: number, shared: boolean) => {
    const tableEnd = 6 + count * 16;
    const result = Buffer.alloc(tableEnd + png.length * (shared ? 1 : count));
    result.writeUInt16LE(1, 2);
    result.writeUInt16LE(count, 4);
    for (let i = 0; i < count; i++) {
      const start = tableEnd + (shared ? 0 : i * png.length);
      result.writeUInt32LE(png.length, 6 + i * 16 + 8);
      result.writeUInt32LE(start, 6 + i * 16 + 12);
      png.copy(result, start);
    }
    return result;
  };
  assert.throws(() => decodeFaviconImage(makeIco(4, true)), /payloads overlap/);
  assert.throws(() => decodeFaviconImage(makeIco(17, true)), /entry count/);
  assert.throws(() => decodeFaviconImage(makeIco(8, false)), /cumulative decoded size/);
  const mismatched = makeIco(1, false);
  mismatched[6] = 128;
  assert.throws(() => decodeFaviconImage(mismatched), /dimensions do not match/);
  assert.equal(decodeFaviconImage(makeIco(2, false)).width, 256);
});
