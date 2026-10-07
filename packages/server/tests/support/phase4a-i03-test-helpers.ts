/**
 * Shared helpers for the P4A-I03 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * It provides real magic-byte fixtures and an INDEPENDENT SHA-256 implementation
 * (FIPS 180-4 written directly here, not the production pipeline's helper) so
 * expected digests are never computed by the same code path under test. The
 * fixture byte store is a real in-memory byte store that streams actual bytes
 * to the delivery reference host; it is not a mock of the delivery path.
 */
import { randomUUID } from 'node:crypto';
import type { MimeCategory } from '../../scripts/evidence/phase4a-i03-stream-verification.js';
import type {
  ByteRange,
  DeliveryReadOutcome,
  DeliveryStatOutcome,
  DeliveryStore,
} from '../../scripts/evidence/phase4a-i03-delivery-host.js';
export const KEY_PREFIX = 'capability-probes/deployment-01/';

export function uuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

/** Independent FIPS 180-4 SHA-256 (32-bit ops only, no shared hash helper). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export function independentSha256Hex(input: Uint8Array): string {
  const bitLength = input.byteLength * 8;
  const padded = new Uint8Array((Math.ceil((input.byteLength + 9) / 64)) * 64);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.byteLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let j = 0; j < 16; j += 1) words[j] = view.getUint32(offset + j * 4);
    for (let j = 16; j < 64; j += 1) {
      const s0 = sha256Rotr(words[j - 15]!, 7) ^ sha256Rotr(words[j - 15]!, 18) ^ (words[j - 15]! >>> 3);
      const s1 = sha256Rotr(words[j - 2]!, 17) ^ sha256Rotr(words[j - 2]!, 19) ^ (words[j - 2]! >>> 10);
      words[j] = (words[j - 16]! + s0 + words[j - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 64; j += 1) {
      const sigma1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + SHA256_K[j]! + words[j]!) >>> 0;
      const sigma0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Real magic bytes: PNG signature `89 50 4E 47 0D 0A 1A 0A` plus payload. */
export function pngBytes(extra = 'known-phase4a-i03-png\n'): Uint8Array {
  return concatBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), text(extra));
}

/** Real magic bytes: JPEG SOI marker `FF D8 FF`. */
export function jpegBytes(extra = 'known-phase4a-i03-jpeg\n'): Uint8Array {
  return concatBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), text(extra));
}

/** Real magic bytes: GIF89a header. */
export function gifBytes(extra = 'known-phase4a-i03-gif\n'): Uint8Array {
  return concatBytes(text('GIF89a'), text(extra));
}

/** Real magic bytes: `%PDF` header with a minimal trailer. */
export function pdfBytes(extra = 'known-phase4a-i03-pdf\n'): Uint8Array {
  return concatBytes(text('%PDF-1.4\n'), text(extra), text('%%EOF\n'));
}

/** Active HTML with a unique side-effect marker; must never execute. */
export function activeHtmlBytes(marker: string, beaconUrl?: string): Uint8Array {
  const beacon = beaconUrl ? `fetch(${JSON.stringify(beaconUrl)});` : '';
  return text(
    `<!DOCTYPE html><html><head><title>active</title></head><body>`
    + `<script>${beacon}document.body.setAttribute('data-i03-executed', ${JSON.stringify(marker)});`
    + `document.title=${JSON.stringify(marker)};</script>`
    + `</body></html>`,
  );
}

/** SVG with an embedded script; must never execute inline. */
export function svgBytes(marker = 'svg-marker'): Uint8Array {
  return text(
    `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">`
    + `<script>document.title=${JSON.stringify(marker)};</script>`
    + `<rect width="1" height="1"/></svg>`,
  );
}

/** Polyglot: PDF magic followed by active HTML/JS markers within the sniff prefix. */
export function polyglotPdfBytes(marker: string, beaconUrl?: string): Uint8Array {
  const beacon = beaconUrl ? `fetch(${JSON.stringify(beaconUrl)});` : '';
  return concatBytes(
    text('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'),
    text(`<script>${beacon}document.title=${JSON.stringify(marker)};</script>`),
    text('\n%%EOF\n'),
  );
}

export function plainBytes(extra = 'plain text with no magic bytes\n'): Uint8Array {
  return text(extra);
}

export interface StoredPrivateFixture {
  blobId: string;
  generationId: string;
  ownerSubject: string;
  bytes: Uint8Array;
  mediaType: string;
  category: MimeCategory;
  etag: string;
}

/**
 * A real local byte store used by the unit/browser suites and the reference
 * delivery host. Bytes are kept in memory and streamed back as actual
 * ReadableStreams; ownership and active-generation facts live here so the host
 * re-checks current owner facts on every delivery (revocation takes effect
 * immediately, both before and after capability issuance).
 */
export class FixturePrivateStore implements DeliveryStore {
  private readonly objects = new Map<string, StoredPrivateFixture>();
  private readonly ownerByBlob = new Map<string, string>();

  seed(fixture: StoredPrivateFixture): void {
    this.objects.set(fixture.generationId, fixture);
    this.ownerByBlob.set(fixture.blobId, fixture.ownerSubject);
  }

  hasGeneration(generationId: string): boolean {
    return this.objects.has(generationId);
  }

  ownerOf(blobId: string): string | undefined {
    return this.ownerByBlob.get(blobId);
  }

  setOwner(blobId: string, ownerSubject: string): void {
    this.ownerByBlob.set(blobId, ownerSubject);
  }

  removeOwner(blobId: string): void {
    this.ownerByBlob.delete(blobId);
  }

  async statGeneration(blobId: string, generationId: string): Promise<DeliveryStatOutcome> {
    const fixture = this.objects.get(generationId);
    if (!fixture || this.ownerByBlob.get(blobId) !== fixture.ownerSubject) {
      return { class: 'not_found' };
    }
    return {
      class: 'ok',
      byteCount: fixture.bytes.byteLength,
      mediaType: fixture.mediaType,
      category: fixture.category,
      etag: fixture.etag,
    };
  }

  async readGeneration(blobId: string, generationId: string, range?: ByteRange): Promise<DeliveryReadOutcome> {
    const fixture = this.objects.get(generationId);
    if (!fixture || this.ownerByBlob.get(blobId) !== fixture.ownerSubject) {
      return { class: 'not_found' };
    }
    const size = fixture.bytes.byteLength;
    if (!range) {
      return {
        class: 'ok',
        stream: this.streamBytes(fixture.bytes),
        byteCount: size,
        totalSize: size,
        mediaType: fixture.mediaType,
        category: fixture.category,
        etag: fixture.etag,
      };
    }
    let start = range.start;
    let end = range.end;
    if (start === -1) {
      const suffixLength = end;
      if (suffixLength <= 0 || size <= 0) {
        return { class: 'range_not_satisfiable', totalSize: size };
      }
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    }
    if (start < 0 || end < start || start >= size) {
      return { class: 'range_not_satisfiable', totalSize: size };
    }
    const boundedEnd = Math.min(end, size - 1);
    const slice = fixture.bytes.slice(start, boundedEnd + 1);
    return {
      class: 'ok',
      stream: this.streamBytes(slice),
      byteCount: slice.byteLength,
      totalSize: size,
      mediaType: fixture.mediaType,
      category: fixture.category,
      etag: fixture.etag,
    };
  }

  private streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}

export interface MutableClock {
  now(): Date;
  advance(ms: number): void;
}

export function mutableClock(startIso = '2026-08-08T00:00:00.000Z'): MutableClock {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export function randomCapabilityId(): string {
  return `i03-${randomUUID()}`;
}

export function newBlob(): { blobId: string; generationId: string } {
  return { blobId: uuidFor(Math.floor(Math.random() * 1000)), generationId: uuidFor(Math.floor(Math.random() * 1000) + 5000) };
}

