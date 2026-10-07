/**
 * BF-01 Product OpenAPI contract for bookmark favicon (1.22.0).
 *
 * Encodes plan §5.1–§5.2 and the OpenAPI-applicable §10 anti-false-positive
 * rules. Reads the authored source (`openapi/product-v1.yaml`) and the real
 * breaking-diff script — not a parallel YAML grep.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const sourcePath = join(backendRoot, 'openapi/product-v1.yaml');
const baseline121 = join(backendRoot, 'openapi/baselines/product-v1.1.21.0.yaml');
const generatedBundle = join(backendRoot, 'generated/openapi/product-v1.bundle.yaml');

const GET_PATH = '/api/v1/favicon/{faviconId}';
const MUTATION_PATH = '/api/v1/collections/{collectionId}/nodes/{nodeId}/favicon';
const COLP_HELPER_PATH = '/colp/v0.1/sync/collections/{collectionId}/nodes/{nodeId}/favicon';
const FAVICON_URL_PATTERN = '^https://.+/api/v1/favicon/[a-fA-F0-9-]{36}$';
const ACCEPTED_UPLOAD_MEDIA = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/octet-stream',
] as const;
const GET_IMAGE_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/x-icon'] as const;
const SESSION_CSRF_COMMAND = [
  '#/components/parameters/Origin',
  '#/components/parameters/CsrfToken',
  '#/components/parameters/CommandId',
] as const;
const MUTATION_ERROR_STATUSES = [
  '400', '401', '403', '404', '409', '410', '413', '415', '429', '500', '503',
] as const;

type UnknownRecord = Record<string, unknown>;
type Operation = UnknownRecord & {
  operationId?: string;
  tags?: string[];
  description?: string;
  parameters?: Array<{ $ref?: string; name?: string; schema?: UnknownRecord; in?: string }>;
  responses?: Record<string, UnknownRecord>;
  security?: Array<Record<string, unknown>>;
  requestBody?: UnknownRecord;
};
type OpenApiDocument = UnknownRecord & {
  info: { version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components: {
    headers: Record<string, UnknownRecord>;
    parameters: Record<string, UnknownRecord>;
    responses: Record<string, UnknownRecord>;
    schemas: Record<string, UnknownRecord>;
  };
};

function readDocument(path = sourcePath): OpenApiDocument {
  return parse(readFileSync(path, 'utf8')) as OpenApiDocument;
}

function resolveLocalRef(document: UnknownRecord, ref: string): unknown {
  assert.match(ref, /^#\//, `external reference is not allowed: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      assert.ok(current && typeof current === 'object' && segment in current, `unresolved reference: ${ref}`);
      return (current as UnknownRecord)[segment];
    }, document);
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') refs.push(child);
      else collectRefs(child, refs);
    }
  }
  return refs;
}

function parameterRefs(operation: Operation): Set<string> {
  return new Set((operation.parameters ?? []).map((parameter) => parameter.$ref).filter(Boolean) as string[]);
}

function resolveResponse(document: OpenApiDocument, response: UnknownRecord | undefined): UnknownRecord {
  assert.ok(response, 'missing response');
  if (typeof response.$ref === 'string') {
    return resolveLocalRef(document, response.$ref) as UnknownRecord;
  }
  return response;
}

function jsonSchemaRef(response: UnknownRecord): string | undefined {
  const content = response.content as UnknownRecord | undefined;
  const media = content?.['application/json'] as UnknownRecord | undefined;
  const schema = media?.schema as UnknownRecord | undefined;
  return typeof schema?.$ref === 'string' ? schema.$ref : undefined;
}

function cacheControlRef(response: UnknownRecord): string | undefined {
  const headers = response.headers as UnknownRecord | undefined;
  const cache = headers?.['Cache-Control'] as UnknownRecord | undefined;
  return typeof cache?.$ref === 'string' ? cache.$ref : undefined;
}

function runBreakingDiff(candidate: string, baseline = baseline121) {
  return spawnSync(process.execPath, [
    join(backendRoot, 'scripts/check-openapi-breaking.mjs'),
    '--baseline', baseline,
    '--candidate', candidate,
  ], {
    cwd: backendRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function objectProperties(schema: UnknownRecord | undefined): UnknownRecord {
  assert.ok(schema, 'missing schema');
  return (schema.properties ?? {}) as UnknownRecord;
}

function requiredList(schema: UnknownRecord | undefined): string[] {
  assert.ok(schema, 'missing schema');
  return Array.isArray(schema.required) ? [...(schema.required as string[])] : [];
}

function stripCacheControlConsts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControlConsts);
  if (value === null || typeof value !== 'object') return value;
  const record = value as UnknownRecord;
  if (typeof record.const === 'string' && /^public,/u.test(record.const)) {
    const { const: _ignored, ...rest } = record;
    return Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, stripCacheControlConsts(child)]));
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, stripCacheControlConsts(child)]));
}

test('Product OpenAPI description keeps the 1.31–1.33 additive history after readable replica POST', () => {
  const document = readDocument();
  assert.match(String(document.info.description), /1\.33\.0/);
  assert.match(String(document.info.description), /1\.32\.0/);
  assert.match(String(document.info.description), /1\.31\.0/);
});

test('generated Product bundle stays additive against the frozen 1.21.0 baseline', () => {
  const result = runBreakingDiff(generatedBundle);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('iconUrl is optional on BookmarkNodeView and PublicCollectionNode and absent from folder/root', () => {
  const document = readDocument();
  const bookmark = document.components.schemas.BookmarkNodeView;
  const publicNode = document.components.schemas.PublicCollectionNode;
  const folder = document.components.schemas.FolderNodeView;
  const root = document.components.schemas.RootNodeView;

  assert.equal(Object.hasOwn(objectProperties(bookmark), 'iconUrl'), true);
  assert.equal(requiredList(bookmark).includes('iconUrl'), false);
  assert.equal(Object.hasOwn(objectProperties(publicNode), 'iconUrl'), true);
  assert.equal(requiredList(publicNode).includes('iconUrl'), false);
  assert.equal(Object.hasOwn(objectProperties(folder), 'iconUrl'), false);
  assert.equal(Object.hasOwn(objectProperties(root), 'iconUrl'), false);
});

test('faviconCdnAllowed is optional on PublicCollectionSummary and owner stays off required[]', () => {
  const document = readDocument();
  const summary = document.components.schemas.PublicCollectionSummary;
  assert.equal(Object.hasOwn(objectProperties(summary), 'faviconCdnAllowed'), true);
  assert.equal((objectProperties(summary).faviconCdnAllowed as UnknownRecord)?.type, 'boolean');
  assert.equal(requiredList(summary).includes('faviconCdnAllowed'), false);
  assert.deepEqual(
    requiredList(summary),
    ['id', 'slug', 'title', 'summary', 'kind', 'rootNodeId', 'updatedAt', 'access'],
  );
  assert.equal(requiredList(summary).includes('owner'), false);
});

test('requiring iconUrl or faviconCdnAllowed breaks the 1.21.0 client contract', () => {
  const document = readDocument();
  const bookmark = document.components.schemas.BookmarkNodeView as UnknownRecord;
  const summary = document.components.schemas.PublicCollectionSummary as UnknownRecord;
  assert.equal(Object.hasOwn(bookmark.properties as UnknownRecord, 'iconUrl'), true);
  assert.equal(Object.hasOwn(summary.properties as UnknownRecord, 'faviconCdnAllowed'), true);

  const breaking = structuredClone(document) as OpenApiDocument;
  const breakingBookmark = breaking.components.schemas.BookmarkNodeView as UnknownRecord;
  const breakingSummary = breaking.components.schemas.PublicCollectionSummary as UnknownRecord;
  breakingBookmark.required = [...(breakingBookmark.required as string[]), 'iconUrl'];
  breakingSummary.required = [...(breakingSummary.required as string[]), 'faviconCdnAllowed'];

  const tempRoot = mkdtempSync(join(tmpdir(), 'known-favicon-required-'));
  const candidate = join(tempRoot, 'candidate.yaml');
  try {
    writeFileSync(candidate, stringify(breaking), 'utf8');
    const result = runBreakingDiff(candidate);
    assert.notEqual(
      result.status,
      0,
      'iconUrl / faviconCdnAllowed in required[] must fail the 1.21.0 additive check',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('GET favicon is anonymous; POST/DELETE require Session CSRF Command-Id and omit If-Match', () => {
  const document = readDocument();
  const get = document.paths[GET_PATH]?.get;
  const post = document.paths[MUTATION_PATH]?.post;
  const del = document.paths[MUTATION_PATH]?.delete;
  assert.ok(get, `missing GET ${GET_PATH}`);
  assert.ok(post, `missing POST ${MUTATION_PATH}`);
  assert.ok(del, `missing DELETE ${MUTATION_PATH}`);

  assert.equal(get.operationId, 'getBookmarkFavicon');
  assert.equal(post.operationId, 'uploadBookmarkFavicon');
  assert.equal(del.operationId, 'deleteBookmarkFavicon');
  assert.deepEqual(get.tags, ['Collections']);
  assert.equal((get.tags ?? []).includes('Account'), false);
  assert.deepEqual(post.tags, ['Nodes']);
  assert.deepEqual(del.tags, ['Nodes']);

  assert.ok(Array.isArray(get.security));
  assert.equal(get.security!.length, 0);
  assert.deepEqual(post.security, [{ cookieAuth: [] }, { productBearer: [] }]);
  assert.deepEqual(del.security, [{ cookieAuth: [] }, { productBearer: [] }]);

  for (const operation of [post, del]) {
    const refs = parameterRefs(operation);
    for (const ref of SESSION_CSRF_COMMAND) {
      assert.equal(refs.has(ref), true, `${operation.operationId} missing ${ref}`);
    }
    assert.equal(refs.has('#/components/parameters/IfMatch'), false, `${operation.operationId} must not take If-Match`);
    assert.equal(refs.has('#/components/parameters/CollectionId'), true);
    assert.equal(refs.has('#/components/parameters/NodeId'), true);
  }
  assert.equal(parameterRefs(get).has('#/components/parameters/IfMatch'), false);
});

test('GET 200 pins PublicImmutableImageCache and GET 404 uses FaviconNotFound short cache', () => {
  const document = readDocument();
  const get = document.paths[GET_PATH]?.get;
  assert.ok(get);
  const ok = get.responses?.['200'];
  assert.ok(ok);
  assert.equal(typeof ok.$ref, 'undefined', 'GET 200 must be inline so Cache-Control is pinned on the operation');
  assert.equal(cacheControlRef(ok), '#/components/headers/PublicImmutableImageCache');
  assert.notEqual(cacheControlRef(ok), '#/components/headers/PublicOrPrivateCache');
  assert.equal(
    ((ok.headers as UnknownRecord)['X-Content-Type-Options'] as UnknownRecord)?.$ref,
    '#/components/headers/XContentTypeOptions',
  );
  assert.equal(
    ((ok.headers as UnknownRecord)['X-Request-Id'] as UnknownRecord)?.$ref,
    '#/components/headers/XRequestId',
  );
  assert.equal((ok.headers as UnknownRecord)['Set-Cookie'], undefined);

  const notFound = get.responses?.['404'];
  assert.ok(notFound);
  assert.notEqual(notFound.$ref, '#/components/responses/NotFound');
  assert.equal(notFound.$ref, '#/components/responses/FaviconNotFound');

  const faviconNotFound = document.components.responses.FaviconNotFound;
  assert.ok(faviconNotFound, 'missing FaviconNotFound response component');
  assert.equal(jsonSchemaRef(faviconNotFound), '#/components/schemas/ProductErrorEnvelope');
  assert.equal(cacheControlRef(faviconNotFound), '#/components/headers/PublicShortCache');
  assert.equal(
    ((faviconNotFound.headers as UnknownRecord)['X-Request-Id'] as UnknownRecord)?.$ref,
    '#/components/headers/XRequestId',
  );

  const immutable = document.components.headers.PublicImmutableImageCache;
  const short = document.components.headers.PublicShortCache;
  assert.ok(immutable);
  assert.ok(short);
  assert.equal((immutable.schema as UnknownRecord).const, 'public, max-age=31536000, immutable');
  assert.equal((short.schema as UnknownRecord).const, 'public, max-age=60');
});

test('iconUrl uses BookmarkFaviconUrl path pattern rather than a generic HTTPS URL schema', () => {
  const document = readDocument();
  const urlSchema = document.components.schemas.BookmarkFaviconUrl;
  assert.ok(urlSchema, 'missing BookmarkFaviconUrl');
  assert.equal(urlSchema.type, 'string');
  assert.equal(urlSchema.format, 'uri');
  assert.equal(urlSchema.maxLength, 2048);
  assert.equal(urlSchema.pattern, FAVICON_URL_PATTERN);
  assert.match(String(urlSchema.description), /PRODUCT_ORIGIN/);
  assert.match(String(urlSchema.description), /never persist or return a CDN URL/i);

  for (const name of ['BookmarkNodeView', 'PublicCollectionNode'] as const) {
    const iconUrl = objectProperties(document.components.schemas[name]).iconUrl as UnknownRecord;
    assert.ok(iconUrl, `${name}.iconUrl missing`);
    assert.notEqual(iconUrl.$ref, '#/components/schemas/HttpsUrl');
    assert.notEqual(iconUrl.$ref, '#/components/schemas/HttpUrlNoUserInfo');
    const oneOf = iconUrl.oneOf as Array<UnknownRecord> | undefined;
    assert.ok(Array.isArray(oneOf), `${name}.iconUrl must be oneOf URL | null`);
    const refs = oneOf.map((entry) => entry.$ref).filter(Boolean);
    assert.equal(refs.includes('#/components/schemas/BookmarkFaviconUrl'), true);
    assert.equal(refs.includes('#/components/schemas/HttpsUrl'), false);
    assert.equal(refs.includes('#/components/schemas/HttpUrlNoUserInfo'), false);
    assert.equal(oneOf.some((entry) => entry.type === 'null'), true);
  }
});

test('favicon operations and new components carry no 4A attachment delivery vocabulary', () => {
  const document = readDocument();
  const get = document.paths[GET_PATH]?.get;
  const post = document.paths[MUTATION_PATH]?.post;
  const del = document.paths[MUTATION_PATH]?.delete;
  assert.ok(get && post && del);

  const okContent = ((get.responses?.['200'] as UnknownRecord).content ?? {}) as UnknownRecord;
  const okTypes = Object.keys(okContent);
  assert.equal(okTypes.includes('application/octet-stream') && okTypes.length === 1, false);
  assert.equal(okTypes.includes('application/octet-stream'), false);
  for (const media of GET_IMAGE_MEDIA) {
    assert.equal(okTypes.includes(media), true, `GET 200 missing ${media}`);
  }

  const scoped = {
    get, post, del,
    BookmarkFaviconUrl: document.components.schemas.BookmarkFaviconUrl,
    PublicImmutableImageCache: document.components.headers.PublicImmutableImageCache,
    PublicShortCache: document.components.headers.PublicShortCache,
    FaviconNotFound: document.components.responses.FaviconNotFound,
  };
  for (const ref of collectRefs(scoped)) {
    assert.equal(/Attachment/u.test(ref), false, `favicon contract must not $ref ${ref}`);
  }

  const scanned = JSON.stringify(stripCacheControlConsts(scoped));
  assert.doesNotMatch(scanned, /attachment/iu);
  assert.doesNotMatch(scanned, /\b(?:shared|inline)\b/iu);
  assert.doesNotMatch(scanned, /content-disposition/iu);
});

test('extension COLP favicon helper is absent from Product OpenAPI', () => {
  const document = readDocument();
  assert.equal(document.paths[COLP_HELPER_PATH], undefined);
  assert.equal(
    Object.keys(document.paths).some((path) => path.includes('/colp/') && path.endsWith('/favicon')),
    false,
  );
});

test('POST documents 64 KiB, six accepted media types, 413/415, and 429 in-progress not 409 command_in_progress', () => {
  const document = readDocument();
  const post = document.paths[MUTATION_PATH]?.post;
  const del = document.paths[MUTATION_PATH]?.delete;
  assert.ok(post && del);
  const description = String(post.description);
  assert.match(description, /Product Session/u);
  assert.match(description, /CSRF/u);
  assert.match(description, /update_node/u);
  assert.match(description, /65536/u);
  assert.match(description, /64 KiB/u);
  assert.match(description, /429/u);
  assert.match(description, /rate_limited/u);
  assert.match(description, /Retry-After/u);
  assert.match(description, /never[\s\S]{0,40}409 command_in_progress/u);
  assert.match(description, /does not bump Node revision/iu);
  assert.match(description, /last-upload-wins/iu);

  assert.equal(post.requestBody?.required, true);
  const content = (post.requestBody?.content ?? {}) as UnknownRecord;
  for (const media of ACCEPTED_UPLOAD_MEDIA) {
    assert.equal(Object.hasOwn(content, media), true, `POST requestBody missing ${media}`);
  }

  for (const status of MUTATION_ERROR_STATUSES) {
    assert.ok(post.responses?.[status], `POST missing ${status}`);
    assert.ok(del.responses?.[status], `DELETE missing ${status}`);
  }
  assert.equal(post.responses?.['409']?.$ref, undefined);
  assert.notEqual(post.responses?.['409']?.$ref, '#/components/responses/MutationConflict');
  assert.match(String(post.responses?.['409']?.description), /command_id_reused/u);
  assert.doesNotMatch(String(post.responses?.['409']?.description), /command_in_progress/u);
  assert.equal(post.responses?.['410']?.$ref, '#/components/responses/Gone');
  assert.equal(post.responses?.['413']?.$ref, '#/components/responses/PayloadTooLarge');
  assert.equal(post.responses?.['415']?.$ref, '#/components/responses/UnsupportedMediaType');
  assert.equal(post.responses?.['429']?.$ref, '#/components/responses/RateLimited');

  const deleteDescription = String(del.description);
  assert.match(deleteDescription, /update_node/u);
  assert.match(deleteDescription, /iconUrl/u);
  assert.match(deleteDescription, /null/u);
  assert.match(deleteDescription, /429/u);
  assert.match(deleteDescription, /never[\s\S]{0,40}409 command_in_progress/u);
  assert.notEqual(del.responses?.['409']?.$ref, '#/components/responses/MutationConflict');
});

test('POST/DELETE 200 return BookmarkNodeView with PrivateNoStore; GET 200 includes image/x-icon', () => {
  const document = readDocument();
  const get = document.paths[GET_PATH]?.get;
  const post = document.paths[MUTATION_PATH]?.post;
  const del = document.paths[MUTATION_PATH]?.delete;
  assert.ok(get && post && del);

  for (const operation of [post, del]) {
    const ok = operation.responses?.['200'];
    assert.ok(ok);
    assert.equal(cacheControlRef(ok!), '#/components/headers/PrivateNoStore');
    assert.equal(jsonSchemaRef(ok!), '#/components/schemas/BookmarkNodeView');
  }

  const getOk = (get.responses?.['200']?.content ?? {}) as UnknownRecord;
  assert.equal(Object.hasOwn(getOk, 'image/x-icon'), true);

  const faviconId = get.parameters?.find((parameter) =>
    parameter.name === 'faviconId'
    || parameter.$ref === '#/components/parameters/FaviconId');
  assert.ok(faviconId, 'GET missing faviconId path parameter');
  const schema = typeof faviconId.$ref === 'string'
    ? ((resolveLocalRef(document, faviconId.$ref) as UnknownRecord).schema as UnknownRecord)
    : faviconId.schema as UnknownRecord;
  assert.equal(schema.minLength, 36);
  assert.equal(schema.maxLength, 36);
  assert.match(String(schema.pattern), /\[a-fA-F0-9-\]\{36\}|\[a-f0-9-\]\{36\}/u);
});
