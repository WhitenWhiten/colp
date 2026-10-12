/**
 * LP fixtures: decodable PNGs of any size, an in-memory object store, and a
 * URL-routed fake egress (resolve + connect) so no test opens a socket.
 */
import { deflateSync } from 'node:zlib';
import type { HardenedEgressConnector, HardenedEgressResolver } from '../../src/infrastructure/egress/index.js';
import { faviconCrc32 } from '../../src/modules/collections/application/favicon-image-decode.js';
import type { BookmarkFaviconObjectStore } from '../../src/modules/collections/index.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(faviconCrc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** 8-bit grayscale PNG; different `shade` values give different bytes (digests). */
export function makePng(width: number, height: number, shade = 128): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, shade);
  for (let row = 0; row < height; row++) raw[row * (width + 1)] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface MemoryObjectStore extends BookmarkFaviconObjectStore {
  readonly objects: Map<string, { readonly body: Buffer; readonly contentType: string }>;
  readonly puts: string[];
  readonly deletes: string[];
}

export function createMemoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    objects,
    puts,
    deletes,
    async put(id, body, contentType) {
      puts.push(id);
      objects.set(id, { body, contentType });
    },
    async get(id) {
      return objects.get(id) ?? null;
    },
    async delete(id) {
      deletes.push(id);
      objects.delete(id);
    },
  };
}

export type FakeRoute = () => Response;

/**
 * Every host resolves to a public address unless listed in `privateHosts`
 * (then 10.0.0.5, which hardened egress must refuse). Unrouted URLs 404.
 */
export function createFakeEgress(routes: Map<string, FakeRoute>, privateHosts: ReadonlySet<string> = new Set()): {
  readonly resolve: HardenedEgressResolver;
  readonly connect: HardenedEgressConnector;
  readonly requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    resolve: async (hostname) => (privateHosts.has(hostname) ? ['10.0.0.5'] : ['93.184.216.34']),
    connect: async (target) => {
      requested.push(target.url.href);
      const route = routes.get(target.url.href);
      return route ? route() : new Response('missing', { status: 404 });
    },
  };
}

export function htmlResponse(head: string): Response {
  return new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export function imageResponse(body: Buffer, contentType = 'image/png'): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentType } });
}
