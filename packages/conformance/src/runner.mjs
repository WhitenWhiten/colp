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
import { assertAnonymousPublicationPrimaryVisibility } from '@know-n/colp/server';

import {
  createHttpClient,
  headerTokens,
  MEDIA_TYPES,
  parseLinkHeader,
  RequestBudgetError,
  ResponseTooLargeError,
} from './http.mjs';
import { Report } from './report.mjs';

export const WELL_KNOWN_PATH = '/.well-known/collection-protocol';
const SNAPSHOT_RELATION = 'https://know-n.com/colp/rels/snapshot';
const UNKNOWN_PARAMETER = 'colpConformanceUnknown';
/** A protocol version no server implements, used to provoke 406 unsupported_version. */
const UNSUPPORTED_VERSION = '999.0';
const DEFAULT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_SNAPSHOT_MEMBERS = 100_000;
const DEFAULT_SNAPSHOT_OBJECTS = 100_000;
/**
 * Publication projections may carry only extension namespaces the server has
 * explicitly declared safe. The portable default is empty, matching
 * protocol/scripts/validate_examples.py.
 */
const DEFAULT_PUBLIC_EXTENSIONS = Object.freeze([]);

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
 *   maxBytes?: number, maxRequests?: number, maxRedirects?: number,
 *   maxSnapshotBytes?: number, maxSnapshotMembers?: number,
 *   maxSnapshotObjects?: number, publicExtensions?: readonly string[],
 *   allowEmpty?: boolean, fetch?: typeof fetch }} [options]
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
    // A run that could not reach a check is not a skipped check: the server
    // has not demonstrated the requirement, and reporting it as skipped would
    // let a redirect loop or an undersized budget turn into a green run.
    report.failRemaining(`not verified: the run stopped because ${error.message}`);
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
  #publicExtensions;
  #allowEmpty;

  constructor(report, http, options) {
    this.#report = report;
    this.#http = http;
    this.#maxCollections = options.maxCollections ?? 3;
    this.#maxPages = options.maxPages ?? 50;
    this.#publicExtensions = publicExtensionNamespaces(options.publicExtensions);
    if (options.allowEmpty !== undefined && typeof options.allowEmpty !== 'boolean') {
      throw new TypeError('allowEmpty must be a boolean.');
    }
    this.#allowEmpty = options.allowEmpty ?? false;
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
      this.#stopWithoutPublication('no mount declares the publication profile');
      return;
    }
    for (const mount of mounts) await this.#publicationMount(mount);
    this.#report.skip('PUB-0033', 'no paginated Snapshot observed');
    this.#report.skip('PUB-0034', 'no paginated Snapshot observed');
    this.#report.skip('PUB-0040', 'no publication Bookmark observed');
    this.#report.skip('PUB-0024', 'no versioned COLP media type was returned');
    this.#report.skipRemaining('not observed');
  }

  /**
   * A publication run that cannot observe any Collection must fail closed: a
   * valid Manifest and empty Directory demonstrate only the schema, not the
   * MUST requirements for public projections, Snapshots, or metadata. Operators
   * testing an intentionally empty deployment can opt in to a schema-only run.
   */
  #stopWithoutPublication(reason) {
    if (this.#allowEmpty) {
      this.#report.note(`Publication checks skipped because ${reason} (--allow-empty).`);
      this.#report.skipRemaining(reason);
      return;
    }
    this.#report.note(`Publication checks failed because ${reason}; pass --allow-empty for a schema-only run.`);
    this.#report.failRemaining(`not verified: ${reason}`);
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
    await this.#expectUnsupportedVersion(directoryUrl, MEDIA_TYPES.directory);
    await this.#expectInvalidQuery(withQuery(directoryUrl, [[UNKNOWN_PARAMETER, '1']]), MEDIA_TYPES.directory);
    await this.#expectInvalidQuery(withQuery(directoryUrl, [['limit', '1'], ['limit', '2']]), MEDIA_TYPES.directory);
    await this.#missingCollection(endpoints.collection);
    if (directory === undefined) return;

    this.#record('PUB-0009', true);
    for (const entry of directory.collections) {
      this.#record('PUB-0009', entry.visibility === 'public',
        `Directory lists ${entry.id} with visibility "${entry.visibility}" to an anonymous client`);
    }
    // Directory entries are public documents too: restricted visibility or an
    // extension namespace the operator has not declared safe must fail here,
    // not only when the same Collection eventually appears in a Snapshot.
    if (directory.collections.length > 0) {
      this.#publicProjection(`GET ${directoryUrl}`, directoryProjectionResources(directory));
    }
    const collectionIds = directory.collections.slice(0, this.#maxCollections).map((entry) => entry.id);
    if (collectionIds.length === 0) {
      this.#stopWithoutPublication('the anonymous Directory lists no Collections');
      return;
    }
    for (const collectionId of collectionIds) await this.#collection(endpoints, collectionId);
  }

  async #collection(endpoints, collectionId) {
    const metadataUrl = this.#expand('collection', endpoints.collection, { collectionId });
    if (metadataUrl !== undefined) {
      const exchange = await this.#readExchange(metadataUrl, MEDIA_TYPES.collection);
      if (exchange !== undefined) {
        const metadata = this.#document(exchange, 'collectionMetadata', MEDIA_TYPES.collection);
        if (metadata !== undefined) {
          this.#publicProjection(`GET ${metadataUrl}`, [['CollectionMetadata.collection', metadata.collection]]);
        }
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
    // Why the chain stopped before its terminal page. An exhausted budget and a
    // Link rel="next" that loops both leave the Snapshot incomplete: the checks
    // below then record a failure instead of being reported as skipped.
    let chainIncomplete;
    let paginationObserved = false;
    while (next !== undefined) {
      if (pages.length >= this.#maxPages) {
        chainIncomplete = `the page budget of ${this.#maxPages} was exhausted before the final page`;
        break;
      }
      if (visited.has(next)) {
        paginationObserved = true;
        this.#record('PUB-0034', false, `Link rel="next" from ${url} loops back to ${next}`);
        chainIncomplete = `Link rel="next" loops back to ${next} instead of reaching a final page`;
        break;
      }
      visited.add(next);
      const remainingBytes = this.#maxSnapshotBytes - totalBytes;
      if (remainingBytes < 1) {
        chainIncomplete = `the Snapshot byte budget of ${this.#maxSnapshotBytes} was exhausted before the final page`;
        break;
      }
      let exchange;
      try {
        exchange = await this.#readExchange(next, MEDIA_TYPES.snapshot, { maxBytes: remainingBytes });
      } catch (error) {
        if (!(error instanceof ResponseTooLargeError)) throw error;
        // The per-response cap is the remaining cumulative Snapshot budget:
        // stop fetching, but still evaluate the pages already collected below.
        this.#record('PUB-0018', false, `GET ${next}: ${describe(error)}`);
        chainIncomplete = `the Snapshot byte budget of ${this.#maxSnapshotBytes} was exhausted before the final page`;
        break;
      }
      if (exchange === undefined) {
        chainIncomplete = `the Snapshot page ${next} could not be read`;
        break;
      }
      const page = this.#document(exchange, 'snapshot', MEDIA_TYPES.snapshot);
      if (page === undefined) {
        chainIncomplete = `the Snapshot page ${next} is not a valid Snapshot`;
        break;
      }
      this.#publicProjection(exchange.url, snapshotProjectionResources(page), page);
      totalBytes += exchange.bytes.byteLength;
      const pageMembers = snapshotMemberCount(page);
      totalMembers += pageMembers;
      totalObjects += pageMembers;
      if (totalMembers > this.#maxSnapshotMembers) {
        chainIncomplete = `the Snapshot member budget of ${this.#maxSnapshotMembers} was exhausted before the final page`;
        break;
      }
      if (totalObjects > this.#maxSnapshotObjects) {
        chainIncomplete = `the Snapshot object budget of ${this.#maxSnapshotObjects} was exhausted before the final page`;
        break;
      }
      first ??= exchange;
      pages.push(page);
      if (page.page.hasMore !== true) break;
      const link = parseLinkHeader(exchange.headers.get('link')).find((candidate) => candidate.rel === 'next');
      paginationObserved = true;
      if (!this.#record('PUB-0034', link !== undefined, `GET ${exchange.url}: hasMore is true but there is no Link rel="next"`)) {
        chainIncomplete = 'hasMore is true but there is no Link rel="next" for the page collected so far';
        break;
      }
      const nextUrl = new URL(link.href, exchange.finalUrl);
      if (new URL(exchange.finalUrl).protocol === 'https:' && nextUrl.protocol === 'http:') {
        this.#record('PUB-0034', false,
          `GET ${exchange.finalUrl}: rel="next" must not downgrade HTTPS to HTTP`);
        chainIncomplete = 'Link rel="next" downgrades HTTPS to HTTP before the final page';
        break;
      }
      next = nextUrl.href;
    }

    if (chainIncomplete !== undefined) {
      this.#report.note(`Stopped assembling ${url}: ${chainIncomplete}.`);
    }

    if (pages.length > 1) {
      for (const page of pages.slice(1)) {
        const drift = ['snapshotId', 'revision', 'mode'].filter((key) => page[key] !== pages[0][key]);
        this.#record('PUB-0033', drift.length === 0, `${url}: page ${page.page.sequence} differs in ${drift.join(', ')}`);
      }
    }
    if (chainIncomplete !== undefined) {
      // The chain never reached its terminal page, so the checks below cannot
      // be claimed for the whole Snapshot. Record the reason as the failure of
      // each check it prevents instead of leaving them unobserved.
      this.#record('PUB-0033', false,
        `${url}: ${chainIncomplete}, so page metadata could not be verified across the Snapshot`);
      if (!paginationObserved) {
        // A budget can stop the run before any page, or before a page's
        // hasMore/Link metadata is inspected. Do not report the SHOULD as a
        // clean skip when the failure is the reason it was never observed.
        this.#record('PUB-0034', false,
          `${url}: ${chainIncomplete}, so Link rel="next" could not be inspected`);
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
    if (chainIncomplete !== undefined) {
      this.#record('CORE-0001', false,
        `${url}: ${chainIncomplete}, so the complete Snapshot could not be assembled`);
    }

    for (const page of pages) {
      if (page.mode !== 'publication') continue;
      for (const node of page.nodes) {
        if (node.kind !== 'bookmark' || node.redacted === true) continue;
        this.#record('PUB-0040', isPlainHttpUrl(node.url), `${url}: Bookmark ${node.id} has url ${JSON.stringify(node.url)}`);
      }
    }
    if (chainIncomplete !== undefined && !this.#report.hasObservations('PUB-0040')) {
      // No page was retained, so no Bookmark URL could be inspected either.
      this.#record('PUB-0040', false,
        `${url}: ${chainIncomplete}, so publication Bookmark URLs could not be verified`);
    }
  }

  async #missingCollection(template) {
    const url = this.#expand('collection', template, { collectionId: `colp-conformance-missing-${randomUUID()}` });
    if (url === undefined) return;
    const exchange = await this.#get(url, MEDIA_TYPES.collection, 'PUB-0008');
    if (exchange === undefined) return;
    this.#record('PUB-0008', exchange.status === 404,
      `GET ${url} for a Collection that does not exist returned ${exchange.status}, expected 404 resource_not_found`);
    const problem = this.#problem(exchange);
    this.#record('PUB-0008', problem?.code === 'resource_not_found',
      `GET ${url}: expected problem code resource_not_found, got ${
        problem === undefined ? 'an invalid Problem' : JSON.stringify(problem.code)
      }`);
  }

  /**
   * SPECIFICATION §12: a version the server does not support, asserted either
   * through the exact Collection-Protocol-Version header or through the
   * Accept version parameter, must be answered with 406 unsupported_version
   * listing supportedVersions. The regular probes already assert the
   * supported version on every request and expect 200.
   */
  async #expectUnsupportedVersion(url, mediaType) {
    const probes = [
      ['Collection-Protocol-Version', { accept: mediaType, protocolVersion: UNSUPPORTED_VERSION }],
      ['Accept version', { acceptRaw: `${mediaType};version=${UNSUPPORTED_VERSION}` }],
    ];
    for (const [label, requestOptions] of probes) {
      const exchange = await this.#get(url, undefined, 'PUB-0041', undefined, requestOptions);
      if (exchange === undefined) continue;
      if (!this.#record('PUB-0041', exchange.status === 406,
        `GET ${url} with ${label} ${UNSUPPORTED_VERSION} returned ${exchange.status}, expected 406`)) {
        continue;
      }
      const problem = this.#problem(exchange);
      const versions = problem?.supportedVersions;
      this.#record('PUB-0041',
        problem?.code === 'unsupported_version' && Array.isArray(versions) && versions.length > 0
          && versions.every((version) => typeof version === 'string'),
        `GET ${url} with ${label} ${UNSUPPORTED_VERSION}: expected an unsupported_version Problem with supportedVersions, `
          + `got ${problem === undefined ? 'an invalid Problem' : `${problem.code} ${JSON.stringify(versions)}`}`);
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
      if (error instanceof RequestBudgetError) {
        this.#record(checkId, false, `GET ${url}: ${describe(error)}`);
        throw error;
      }
      if (error instanceof ResponseTooLargeError && requestOptions?.maxBytes !== undefined) throw error;
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
      if (error instanceof RequestBudgetError) {
        this.#record('PUB-0022', false, `GET ${exchange.url} with If-None-Match: ${describe(error)}`);
        throw error;
      }
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

  #publicProjection(subject, resources, snapshot) {
    const failures = snapshot === undefined
      ? publicProjectionFailures(resources, this.#publicExtensions)
      : snapshotPublicProjectionFailures(snapshot, resources, this.#publicExtensions);
    this.#record('PUB-0025', failures.length === 0,
      failures.length === 0
        ? `${subject}: public projection passed privacy checks`
        : `${subject}: public projection ${failures.join('; ')}`);
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

/**
 * The privacy and extension checks shared by every public document. A
 * Directory entry or a Collection Metadata Collection is as publicly readable
 * as a Snapshot resource, so the same allowlist and visibility checks apply.
 */
function publicProjectionFailures(resources, allowlist = DEFAULT_PUBLIC_EXTENSIONS) {
  const failures = [];
  for (const [label, resource] of resources) {
    if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) continue;
    try {
      assertAnonymousPublicationPrimaryVisibility(resource);
    } catch (error) {
      failures.push(`${label} failed privacy checks: ${describe(error)}`);
    }
    failures.push(...publicResourceExtensionViolations(label, resource, allowlist)
      .map(violation => `leaked extension ${violation}`));
  }
  return failures;
}

/**
 * Snapshot pages are checked as a graph first: inherited node visibility and
 * sidecar subjects can only be resolved with the whole page. Their individual
 * resources then receive the same extension allowlist projection check.
 */
function snapshotPublicProjectionFailures(snapshot, resources, allowlist = DEFAULT_PUBLIC_EXTENSIONS) {
  const failures = [];
  try {
    assertAnonymousPublicationPrimaryVisibility(snapshot);
  } catch (error) {
    failures.push(`failed privacy checks: ${describe(error)}`);
  }
  for (const [label, resource] of resources) {
    failures.push(...publicResourceExtensionViolations(label, resource, allowlist)
      .map(violation => `leaked extension ${violation}`));
  }
  return failures;
}

/** Enumerates extension namespaces a public resource carries outside the allowlist. */
function publicResourceExtensionViolations(label, resource, allowlist = DEFAULT_PUBLIC_EXTENSIONS) {
  if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) return [];
  const extensions = resource.extensions;
  if (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions)) return [];
  const unsafe = Object.keys(extensions).filter((namespace) => !allowlist.includes(namespace));
  return unsafe.length === 0 ? [] : [`${label} ${resource.id}: ${unsafe.join(', ')}`];
}

function directoryProjectionResources(directory) {
  return directory.collections.map((entry, index) => [`Directory.collections[${index}]`, entry]);
}

function snapshotProjectionResources(snapshot) {
  return [
    ['Collection', snapshot.collection],
    ...snapshot.nodes.map((resource, index) => [`Nodes[${index}]`, resource]),
    ...snapshot.annotations.map((resource, index) => [`Annotations[${index}]`, resource]),
    ...snapshot.attachments.map((resource, index) => [`Attachments[${index}]`, resource]),
    ...snapshot.relations.map((resource, index) => [`Relations[${index}]`, resource]),
    ...snapshot.tombstones.map((resource, index) => [`Tombstones[${index}]`, resource]),
  ];
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function publicExtensionNamespaces(value) {
  if (value === undefined) return DEFAULT_PUBLIC_EXTENSIONS;
  if (!Array.isArray(value) || value.some((namespace) => typeof namespace !== 'string' || namespace.length === 0)) {
    throw new TypeError('publicExtensions must be an array of non-empty extension namespace strings.');
  }
  return Object.freeze([...value]);
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
