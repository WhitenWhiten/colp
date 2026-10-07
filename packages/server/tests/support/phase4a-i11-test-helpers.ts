/**
 * Shared helpers for the P4A-I11 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides a real in-memory byte store that implements the attachments
 * `GenerationObjectStorePort` (actual bytes streamed back, single-range
 * slicing, AbortSignal-aware, bounded by the requested ceiling, with an
 * optional pull recorder for backpressure evidence), active content fixtures
 * (HTML/JS, SVG, PDF polyglot) with unique side-effect markers, a fixture
 * generation resolver, and a capability-issuance helper. The production
 * delivery host is composed with these fixtures exactly as production wiring
 * composes it with the RO R2 adapter. The Chromium isolation scenario lives in
 * `scripts/evidence/phase4a-i11-browser-scenario.ts` (shared with
 * the real-R2 evidence CLI).
 */
import type {
  DeliveryGenerationResolver,
  GenerationHeadOutcome,
  GenerationObjectHandle,
  GenerationObjectStorePort,
  GenerationReadOutcome,
  OwnerDeliveryCapabilitySigner,
} from '../../src/modules/attachments/index.js';
import type { AttachmentsFeatureConfig } from '../../src/modules/attachments/index.js';
import { makeI10Config } from './phase4a-i10-test-helpers.js';

export const I11_LIVE_PREFIX = 'attachments/live/';
export const I11_DELIVERY_SECRET = Buffer.from('i11-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');
export const I11_OWNER_A = 'i11-subject-owner-a';
export const I11_OWNER_B = 'i11-subject-owner-b';

export function i11Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  return makeI10Config(overrides);
}

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Active HTML with an inline script that would set the title, mutate the DOM
 * (side-effect marker), and beacon out. Never executes at the isolated origin. */
export function activeHtmlBytes(marker: string, beaconUrl?: string): Uint8Array {
  const beacon = beaconUrl ? `fetch(${JSON.stringify(beaconUrl)});` : '';
  return text(
    `<!DOCTYPE html><html><head><title>${marker}</title></head><body>`
    + `<script>${beacon}document.title=${JSON.stringify(marker)};`
    + `document.body.setAttribute('data-i11-executed', ${JSON.stringify(marker)});</script>`
    + `</body></html>`,
  );
}

/** SVG with an embedded script; must never execute inline. */
export function svgBytes(marker: string, beaconUrl?: string): Uint8Array {
  const beacon = beaconUrl ? `fetch(${JSON.stringify(beaconUrl)});` : '';
  return text(
    `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">`
    + `<script>${beacon}document.title=${JSON.stringify(marker)};`
    + `document.documentElement.setAttribute('data-i11-executed', ${JSON.stringify(marker)});</script>`
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

export function plainBytes(value = 'i11 plain unscanned bytes\n'): Uint8Array {
  return text(value);
}

export interface I11FixtureObject {
  readonly blobId: string;
  readonly generationId: string;
  readonly key: string;
  readonly ownerSubject: string;
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function fixtureKey(suffix: string): string {
  return `${I11_LIVE_PREFIX}${suffix}`;
}

/** Fixture generation resolver: maps the capability claims to the exact handle. */
export function fixtureResolver(objects: readonly I11FixtureObject[]): DeliveryGenerationResolver {
  const byId = new Map(objects.map((object) => [object.generationId, object] as const));
  return async (claims) => {
    const object = byId.get(claims.generationId);
    if (!object || object.blobId !== claims.blobId) return { found: false };
    return { found: true, handle: { generationId: object.generationId, key: object.key } };
  };
}

/** Signs a capability for an object with the production I10 signer. */
export function issueCapability(
  signer: OwnerDeliveryCapabilitySigner,
  object: I11FixtureObject,
  options: { ttlSeconds?: number; now?: Date } = {},
): string {
  return signer.sign({
    blobId: object.blobId,
    generationId: object.generationId,
    ownerSubject: object.ownerSubject,
    ttlSeconds: options.ttlSeconds ?? 60,
    now: options.now,
  }).token;
}

async function* chunkedStream(
  bytes: Uint8Array,
  chunkSize: number,
  signal: AbortSignal,
  onPull?: (index: number) => void,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    onPull?.(index);
    index += 1;
    const end = Math.min(offset + chunkSize, bytes.byteLength);
    yield bytes.subarray(offset, end);
    offset = end;
  }
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
}

/**
 * Real in-memory byte store implementing the module object-store port. Bytes
 * are kept in memory and streamed back as real chunks; single ranges are
 * sliced; the ceiling and AbortSignal are honored. It is a fixture of the
 * production RO adapter (which the HTTP suite exercises over the fault
 * transport), not a mock of the delivery path.
 */
export class FixtureDeliveryObjectStore implements GenerationObjectStorePort {
  private readonly objects = new Map<string, I11FixtureObject>();

  constructor(private readonly options: { readonly onPull?: (generationId: string, index: number) => void } = {}) {}

  seed(object: I11FixtureObject): void {
    this.objects.set(object.generationId, object);
  }

  async headExact(handle: GenerationObjectHandle, options: { expectedEtag?: string } = {}): Promise<GenerationHeadOutcome> {
    const object = this.objects.get(handle.generationId);
    if (!object) return { class: 'not_found' };
    if (options.expectedEtag !== undefined && options.expectedEtag !== object.etag) return { class: 'etag_mismatch' };
    return {
      class: 'ok',
      identity: {
        generationId: object.generationId,
        size: object.bytes.byteLength,
        etag: object.etag,
        metadata: Object.freeze({ ...(object.metadata ?? {}) }),
        lastModifiedIso: '2026-08-08T00:00:00.000Z',
      },
    };
  }

  async readBounded(handle: GenerationObjectHandle, options: {
    expectedEtag: string;
    byteCeiling: number;
    signal: AbortSignal;
    range?: { start: number; end: number };
  }): Promise<GenerationReadOutcome> {
    const object = this.objects.get(handle.generationId);
    if (!object) return { class: 'not_found' };
    if (options.expectedEtag !== object.etag) return { class: 'etag_mismatch' };
    const size = object.bytes.byteLength;
    let start = 0;
    let end = size - 1;
    if (options.range !== undefined) {
      start = options.range.start;
      end = options.range.end;
    }
    if (start < 0 || start >= size || end < start) return { class: 'not_found' };
    const boundedEnd = Math.min(end, size - 1);
    const slice = object.bytes.slice(start, boundedEnd + 1);
    if (slice.byteLength > options.byteCeiling) return { class: 'overflow', byteCeiling: options.byteCeiling };
    return {
      class: 'ok',
      identity: {
        generationId: object.generationId,
        size: slice.byteLength,
        etag: object.etag,
        metadata: Object.freeze({ ...(object.metadata ?? {}) }),
        lastModifiedIso: '2026-08-08T00:00:00.000Z',
      },
      stream: chunkedStream(slice, 4 * 1024, options.signal, (index) => {
        this.options.onPull?.(object.generationId, index);
      }),
    };
  }

  async close(): Promise<void> {}
}
