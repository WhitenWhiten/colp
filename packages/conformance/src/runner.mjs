/**
 * Black-box conformance runner for the COLP `core + publication` profiles.
 *
 * Starting from the Manifest, it follows only the endpoints and links the
 * server declares (PUB-0002, PUB-0013), sends anonymous read-only requests,
 * and validates every response with the reference package's schema and
 * semantic validators.
 */
import { randomUUID } from 'node:crypto';

import { createValidatorRegistry, parseIJson } from '@know-n/colp/schema';
import {
  assembleSnapshotPages,
  expandPublicationEndpointTemplate,
  validateManifestSemantics,
} from '@know-n/colp/semantic';

import {
  createHttpClient,
  headerTokens,
  MEDIA_TYPES,
  parseLinkHeader,
  RequestBudgetError,
} from './http.mjs';
import { Report } from './report.mjs';

export const WELL_KNOWN_PATH = '/.well-known/collection-protocol';
const SNAPSHOT_RELATION = 'https://know-n.com/colp/rels/snapshot';
const UNKNOWN_PARAMETER = 'colpConformanceUnknown';
const DEFAULT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_SNAPSHOT_MEMBERS = 100_000;
const DEFAULT_SNAPSHOT_OBJECTS = 100_000;

/** Accepts a server origin or a Manifest URL and returns the Manifest URL to probe. */
export function resolveManifestUrl(target) {
  const url = new URL(target);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`Target must be an http(s) URL, got ${url.protocol}`);
  }
  return url.pathname === WELL_KNOWN_PATH ? url.href : new URL(WELL_KNOWN_PATH, url.origin).href;
}

/**
 * Probes one server and returns a report.
 *
 * @param {string} target Server origin or Manifest URL.
 * @param {{ maxCollections?: number, maxPages?: number, timeoutMs?: number,
 *   maxBytes?: number, maxRequests?: number, maxSnapshotBytes?: number,
 *   maxSnapshotMembers?: number, maxSnapshotObjects?: number,
 *   fetch?: typeof fetch }} [options]
 */
export async function runConformance(target, options = {}) {
  const manifestUrl = resolveManifestUrl(target);
  const report = new Report(manifestUrl);
  // Bind every request in this run to the operator-selected Manifest origin
  // and let the HTTP transport re-check each server-controlled destination.
  // `initialOrigin` is derived here rather than accepted from options so a
  // caller cannot widen the run's egress boundary accidentally.
  const http = createHttpClient({
    ...options,
    initialOrigin: new URL(manifestUrl).origin,
  });
  const probe = new Probe(report, http, options);
  try {
    await probe.run(manifestUrl);
  } catch (error) {
    if (!(error instanceof RequestBudgetError)) throw error;
    report.note(`Stopped early: ${error.message}`);
    report.skipRemaining('not reached before the request budget ran out');
  }
  return report.finish(http.requestCount);
}

class Probe {
  #report;
  #http;
  #validators = createValidatorRegistry();
  #maxCollections;
  #maxPages;
  #maxSnapshotBytes;
  #maxSnapshotMembers;
  #maxSnapshotObjects;

  constructor(report, http, options) {
    this.#report = report;
    this.#http = http;
    this.#maxCollections = options.maxCollections ?? 3;
    this.#maxPages = options.maxPages ?? 50;
    this.#maxSnapshotBytes = positiveSafeInteger(
      options.maxSnapshotBytes ?? DEFAULT_SNAPSHOT_BYTES,
      'maxSnapshotBytes',
    );
    this.#maxSnapshotMembers = positiveSafeInteger(
      options.maxSnapshotMembers ?? DEFAULT_SNAPSHOT_MEMBERS,
      'maxSnapshotMembers',
    );
    this.#maxSnapshotObjects = positiveSafeInteger(
      options.maxSnapshotObjects ?? DEFAULT_SNAPSHOT_OBJECTS,
      'maxSnapshotObjects',
    );
  }

  async run(manifestUrl) {
    const manifest = await this.#manifest(manifestUrl);
    if (manifest === undefined) {
      this.#report.skipRemaining('no valid Manifest to start from');
      return;
    }
    const mounts = manifest.mounts.filter((mount) => mount.profiles.includes('publication'));
    if (mounts.length === 0) {
      this.#report.skipRemaining('no mount declares the publication profile');
      return;
    }
    for (const mount of mounts) await this.#publicationMount(mount);
    this.#report.skip('PUB-0033', 'no paginated Snapshot observed');
    this.#report.skip('PUB-0034', 'no paginated Snapshot observed');
    this.#report.skip('PUB-0040', 'no publication Bookmark observed');
    this.#report.skip('PUB-0024', 'no versioned COLP media type was returned');
    this.#report.skipRemaining('not observed');
  }

  // ---------------------------------------------------------------- Manifest

  async #manifest(url) {
    const exchange = await this.#get(url, MEDIA_TYPES.manifest, 'PUB-0011');
    if (exchange === undefined) return undefined;
    if (!this.#record('PUB-0011', exchange.status === 200, `GET ${url} returned ${exchange.status}`)) {
      return undefined;
    }
    const manifest = this.#document(exchange, 'manifest', MEDIA_TYPES.manifest);
    const cacheControl = exchange.headers.get('cache-control');
    const tokens = headerTokens(cacheControl);
    this.#record(
      'PUB-0027',
      tokens.includes('public') && tokens.some((token) => token.startsWith('max-age=')) && exchange.headers.has('etag'),
      `GET ${url}: Cache-Control "${cacheControl ?? ''}", ETag ${exchange.headers.has('etag') ? 'present' : 'missing'} `
        + '(recommended: public, max-age=300 with an ETag)',
    );
    await this.#conditional(exchange, MEDIA_TYPES.manifest);
    if (manifest === undefined) return undefined;

    const semantics = validateManifestSemantics(manifest);
    this.#record('PUB-0003', semantics.valid, `Manifest: ${formatIssues(semantics.issues)}`);
    for (const mount of manifest.mounts) {
      const missing = ['profiles', 'endpoints', 'auth', 'limits'].filter((key) => mount[key] === undefined);
      this.#record('PUB-0012', missing.length === 0, `mount ${mount.id}: missing ${missing.join(', ')}`);
      this.#record('PUB-0028', mount.baseUrl.endsWith('/'), `mount ${mount.id}: baseUrl ${mount.baseUrl} does not end with "/"`);
    }
    return manifest;
  }

  // ------------------------------------------------------------- Publication

  async #publicationMount(mount) {
    const endpoints = mount.endpoints;
    const missing = ['directory', 'collection', 'snapshot'].filter((key) => typeof endpoints[key] !== 'string');
    if (!this.#record('PUB-0001', missing.length === 0, `mount ${mount.id}: missing endpoints ${missing.join(', ')}`)) {
      return;
    }
    const directoryUrl = this.#expand('directory', endpoints.directory, {});
    if (directoryUrl === undefined) return;

    const directory = await this.#read(directoryUrl, 'collectionDirectory', MEDIA_TYPES.directory);
    await this.#expectInvalidQuery(withQuery(directoryUrl, [[UNKNOWN_PARAMETER, '1']]), MEDIA_TYPES.directory);
    await this.#expectInvalidQuery(withQuery(directoryUrl, [['limit', '1'], ['limit', '2']]), MEDIA_TYPES.directory);
    await this.#missingCollection(endpoints.collection);
    if (directory === undefined) return;

    this.#record('PUB-0009', true);
    for (const entry of directory.collections) {
      this.#record('PUB-0009', entry.visibility === 'public',
        `Directory lists ${entry.id} with visibility "${entry.visibility}" to an anonymous client`);
    }
    const collectionIds = directory.collections.slice(0, this.#maxCollections).map((entry) => entry.id);
    if (collectionIds.length === 0) {
      this.#report.skipRemaining('the anonymous Directory lists no Collections');
    }
    for (const collectionId of collectionIds) await this.#collection(endpoints, collectionId);
  }

  async #collection(endpoints, collectionId) {
    const metadataUrl = this.#expand('collection', endpoints.collection, { collectionId });
    if (metadataUrl !== undefined) {
      const exchange = await this.#readExchange(metadataUrl, MEDIA_TYPES.collection);
      if (exchange !== undefined) {
        this.#document(exchange, 'collectionMetadata', MEDIA_TYPES.collection);
        const relations = new Set(parseLinkHeader(exchange.headers.get('link')).map((link) => link.rel));
        const absent = ['self', 'canonical', SNAPSHOT_RELATION].filter((relation) => !relations.has(relation));
        this.#record('PUB-0032', absent.length === 0, `GET ${metadataUrl}: Link header lacks rel ${absent.join(', ')}`);
        await this.#conditional(exchange, MEDIA_TYPES.collection);
      }
    }
    const snapshotUrl = this.#expand('snapshot', endpoints.snapshot, { collectionId });
    if (snapshotUrl === undefined) return;
    await this.#snapshot(snapshotUrl);
    await this.#expectInvalidQuery(withQuery(snapshotUrl, [[UNKNOWN_PARAMETER, '1']]), MEDIA_TYPES.snapshot);
  }

  async #snapshot(url) {
    const pages = [];
    const visited = new Set();
    let totalBytes = 0;
    let totalMembers = 0;
    let totalObjects = 1; // The Collection is shared by every assembled page.
    let first;
    let next = url;
    while (next !== undefined) {
      if (pages.length >= this.#maxPages) {
        this.#report.note(`Stopped following ${url} after ${this.#maxPages} pages.`);
        return;
      }
      if (visited.has(next)) {
        this.#record('PUB-0034', false, `Link rel="next" from ${url} loops back to ${next}`);
        return;
      }
      visited.add(next);
      const remainingBytes = this.#maxSnapshotBytes - totalBytes;
      if (remainingBytes < 1) {
        this.#report.note(`Stopped assembling ${url}: Snapshot byte budget of ${this.#maxSnapshotBytes} exhausted.`);
        return;
      }
      const exchange = await this.#readExchange(next, MEDIA_TYPES.snapshot, { maxBytes: remainingBytes });
      if (exchange === undefined) return;
      const page = this.#document(exchange, 'snapshot', MEDIA_TYPES.snapshot);
      if (page === undefined) return;
      totalBytes += exchange.bytes.byteLength;
      const pageMembers = snapshotMemberCount(page);
      totalMembers += pageMembers;
      totalObjects += pageMembers;
      if (totalMembers > this.#maxSnapshotMembers) {
        this.#report.note(
          `Stopped assembling ${url}: Snapshot member budget of ${this.#maxSnapshotMembers} exhausted.`,
        );
        return;
      }
      if (totalObjects > this.#maxSnapshotObjects) {
        this.#report.note(
          `Stopped assembling ${url}: Snapshot object budget of ${this.#maxSnapshotObjects} exhausted.`,
        );
        return;
      }
      first ??= exchange;
      pages.push(page);
      if (page.page.hasMore !== true) break;
      const link = parseLinkHeader(exchange.headers.get('link')).find((candidate) => candidate.rel === 'next');
      if (!this.#record('PUB-0034', link !== undefined, `GET ${exchange.url}: hasMore is true but there is no Link rel="next"`)) {
        return;
      }
      const nextUrl = new URL(link.href, exchange.finalUrl);
      if (new URL(exchange.finalUrl).protocol === 'https:' && nextUrl.protocol === 'http:') {
        this.#record('PUB-0034', false,
          `GET ${exchange.finalUrl}: rel="next" must not downgrade HTTPS to HTTP`);
        return;
      }
      next = nextUrl.href;
    }

    if (pages.length > 1) {
      for (const page of pages.slice(1)) {
        const drift = ['snapshotId', 'revision', 'mode'].filter((key) => page[key] !== pages[0][key]);
        this.#record('PUB-0033', drift.length === 0, `${url}: page ${page.page.sequence} differs in ${drift.join(', ')}`);
      }
    }
    await this.#conditional(first, MEDIA_TYPES.snapshot);

    let assembled;
    try {
      assembled = assembleSnapshotPages(pages, {
        maxMembers: this.#maxSnapshotMembers,
        maxObjects: this.#maxSnapshotObjects,
      });
    } catch (error) {
      assembled = { valid: false, issues: [{ code: 'assembly_error', message: describe(error) }] };
    }
    this.#record('CORE-0001', assembled.valid, `${url}: ${formatIssues(assembled.issues)}`);

    for (const page of pages) {
      if (page.mode !== 'publication') continue;
      for (const node of page.nodes) {
        if (node.kind !== 'bookmark' || node.redacted === true) continue;
        this.#record('PUB-0040', isPlainHttpUrl(node.url), `${url}: Bookmark ${node.id} has url ${JSON.stringify(node.url)}`);
      }
    }
  }

  async #missingCollection(template) {
    const url = this.#expand('collection', template, { collectionId: `colp-conformance-missing-${randomUUID()}` });
    if (url === undefined) return;
    const exchange = await this.#get(url, MEDIA_TYPES.collection, 'PUB-0008');
    if (exchange === undefined) return;
    if (this.#record('PUB-0008', exchange.status >= 400, `GET ${url} for a Collection that does not exist returned ${exchange.status}`)) {
      this.#problem(exchange);
    }
  }

  async #expectInvalidQuery(url, accept) {
    const exchange = await this.#get(url, accept, 'PUB-0010');
    if (exchange === undefined) return;
    const problem = this.#problem(exchange);
    this.#record('PUB-0010', exchange.status === 400 && problem?.code === 'invalid_query',
      `GET ${url} returned ${exchange.status}${problem === undefined ? '' : ` ${problem.code}`}, expected 400 invalid_query`);
  }

  // ------------------------------------------------------- Response helpers

  /** GETs a document and returns its validated value, or undefined. */
  async #read(url, definition, mediaType) {
    const exchange = await this.#readExchange(url, mediaType);
    if (exchange === undefined) return undefined;
    const value = this.#document(exchange, definition, mediaType);
    await this.#conditional(exchange, mediaType);
    return value;
  }

  /** GETs a URL that must answer 200; records why it did not. */
  async #readExchange(url, mediaType, requestOptions) {
    const exchange = await this.#get(url, mediaType, 'PUB-0018', undefined, requestOptions);
    if (exchange === undefined) return undefined;
    if (exchange.status === 200) return exchange;
    this.#record('PUB-0018', false, `GET ${url} returned ${exchange.status}, expected 200`);
    this.#problem(exchange);
    return undefined;
  }

  async #get(url, accept, checkId, headers, requestOptions) {
    try {
      return await this.#http.request(url, {
        accept,
        ...(headers === undefined ? {} : { headers }),
        ...(requestOptions === undefined ? {} : requestOptions),
      });
    } catch (error) {
      if (error instanceof RequestBudgetError) throw error;
      this.#record(checkId, false, `GET ${url} failed: ${describe(error)}`);
      return undefined;
    }
  }

  /** Decodes and validates a 200 body against its $def; returns the value only when valid. */
  #document(exchange, definition, mediaType) {
    const label = `GET ${exchange.url}`;
    this.#mediaType(exchange, mediaType, label);
    this.#record('PUB-0021', exchange.headers.has('etag') && exchange.headers.has('last-modified'),
      `${label}: ETag ${exchange.headers.has('etag') ? 'present' : 'missing'}, `
        + `Last-Modified ${exchange.headers.has('last-modified') ? 'present' : 'missing'}`);
    const value = this.#decode(exchange, label);
    if (value === undefined) return undefined;
    const result = this.#validators.validate(definition, value);
    return this.#record('PUB-0018', result.valid, `${label}: not a valid ${definition}: ${formatErrors(result.errors)}`)
      ? value
      : undefined;
  }

  /** Checks an error response is a Problem Details document; returns it when valid. */
  #problem(exchange) {
    if (exchange.status < 400) return undefined;
    const label = `GET ${exchange.url} (${exchange.status})`;
    const contentType = exchange.headers.get('content-type') ?? '';
    if (!this.#record('PUB-0008', mediaEssence(contentType) === 'application/problem+json',
      `${label}: Content-Type is "${contentType}", expected application/problem+json`)) {
      return undefined;
    }
    const value = this.#decode(exchange, label);
    if (value === undefined) return undefined;
    const result = this.#validators.validate('problem', value);
    const detail = result.valid
      ? `${label}: Problem status ${value.status} differs from the HTTP status`
      : `${label}: not a valid problem: ${formatErrors(result.errors)}`;
    return this.#record('PUB-0008', result.valid && value.status === exchange.status, detail) ? value : undefined;
  }

  #decode(exchange, label) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(exchange.bytes);
    } catch {
      this.#record('PUB-0016', false, `${label}: body is not valid UTF-8`);
      return undefined;
    }
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/iu.exec(exchange.headers.get('content-type') ?? '')?.[1];
    this.#record('PUB-0016', charset === undefined || charset.toLowerCase() === 'utf-8', `${label}: declares charset=${charset}`);
    try {
      const value = parseIJson(text);
      this.#record('PUB-0017', true);
      return value;
    } catch (error) {
      this.#record('PUB-0017', false, `${label}: ${describe(error)}`);
      return undefined;
    }
  }

  #mediaType(exchange, expected, label) {
    const contentType = exchange.headers.get('content-type') ?? '';
    const essence = mediaEssence(contentType);
    this.#record('PUB-0020', essence === expected, `${label}: Content-Type is "${contentType}", expected ${expected}`);
    if (!essence.startsWith('application/vnd.collection-protocol.')) return;
    const vary = headerTokens(exchange.headers.get('vary'));
    this.#record('PUB-0024',
      vary.includes('*') || (vary.includes('accept') && vary.includes('collection-protocol-version')),
      `${label}: Vary is "${exchange.headers.get('vary') ?? ''}", expected Accept and Collection-Protocol-Version`);
  }

  /** Revalidates a 200 response with its ETag and expects an empty 304. */
  async #conditional(exchange, accept) {
    const etag = exchange?.headers.get('etag');
    if (etag === null || etag === undefined) {
      this.#report.skip('PUB-0022', 'no ETag to revalidate');
      return;
    }
    let revalidated;
    try {
      revalidated = await this.#http.request(exchange.url, { accept, headers: { 'If-None-Match': etag } });
    } catch (error) {
      if (error instanceof RequestBudgetError) throw error;
      this.#record('PUB-0022', false, `GET ${exchange.url} with If-None-Match failed: ${describe(error)}`);
      return;
    }
    const sameTag = !revalidated.headers.has('etag') || revalidated.headers.get('etag') === etag;
    this.#record('PUB-0022', revalidated.status === 304 && revalidated.bytes.byteLength === 0 && sameTag,
      `GET ${exchange.url} with If-None-Match: ${etag} returned ${revalidated.status}`
        + `${revalidated.bytes.byteLength > 0 ? ' with a body' : ''}${sameTag ? '' : ' and a different ETag'}`);
  }

  #expand(endpoint, template, values) {
    try {
      return expandPublicationEndpointTemplate(endpoint, template, values, this.#validators).href;
    } catch (error) {
      this.#record('PUB-0003', false, `cannot expand ${endpoint} template ${template}: ${describe(error)}`);
      return undefined;
    }
  }

  #record(id, ok, detail) {
    return this.#report.record(id, ok, detail);
  }
}

function withQuery(url, pairs) {
  const result = new URL(url);
  for (const [name, value] of pairs) result.searchParams.append(name, value);
  return result.href;
}

function mediaEssence(contentType) {
  return contentType.split(';')[0].trim().toLowerCase();
}

function snapshotMemberCount(snapshot) {
  return snapshot.nodes.length
    + snapshot.annotations.length
    + snapshot.attachments.length
    + snapshot.relations.length
    + snapshot.tombstones.length;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isPlainHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function formatErrors(errors) {
  return (errors ?? []).slice(0, 3)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

function formatIssues(issues) {
  return (issues ?? []).slice(0, 3)
    .map((issue) => [issue.path, issue.code, issue.message].filter(Boolean).join(' '))
    .join('; ');
}

function describe(error) {
  if (error instanceof Error) {
    return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
  }
  return String(error);
}
