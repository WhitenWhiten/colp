import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { test } from 'vitest';
import { ABOUT_MAX } from '../../../src/modules/identity/index.js';
// Task E4: the single auth-route manifest (A4) drives composition
// registration, rate-limit families and OpenAPI — the legacy OIDC surface
// must stay declared as deprecated legacy-oidc entries and nothing else.
import { AUTH_ROUTE_MANIFEST } from '../../../src/transport/auth/auth-route-manifest.js';
import {
  backendRoot,
  collectRefs,
  operations,
  parameterRefs,
  readDocument,
  resolveLocalRef,
  runNodeScript,
  sourcePath,
  type OpenApiDocument,
  type UnknownRecord,
} from './openapi-contract-support.js';

test('public Profile GET and HEAD share the closed page schema and conditional public headers', () => {
  const document = readDocument();
  const path = document.paths['/api/v1/profiles/{handle}'];
  assert.ok(path);
  assert.equal(path.get.operationId, 'getPublicProfile');
  assert.equal(path.head.operationId, 'headPublicProfile');
  assert.deepEqual(path.get.security, [{ cookieAuth: [] }, {}]);
  assert.deepEqual(path.head.security, [{ cookieAuth: [] }, {}]);

  for (const operation of [path.get, path.head]) {
    assert.deepEqual(parameterRefs(operation), new Set([
      '#/components/parameters/PublicProfileHandlePath',
      '#/components/parameters/PublicProfileLimit',
      '#/components/parameters/PublicProfileCursor',
      '#/components/parameters/IfNoneMatch',
    ]));
    assert.deepEqual(Object.keys(operation.responses ?? {}).sort(), ['200', '304', '400', '404', '406', '429', '500', '503']);
    const ok = operation.responses?.['200'] as UnknownRecord;
    const headers = ok.headers as UnknownRecord;
    for (const name of ['Cache-Control', 'Content-Length', 'ETag', 'Vary', 'X-Content-Type-Options', 'X-Request-Id']) {
      assert.ok(headers[name], `${operation.operationId} is missing ${name}`);
    }
    const content = ok.content as UnknownRecord | undefined;
    if (operation === path.get) {
      assert.equal(
        ((((content?.['application/json'] as UnknownRecord).schema as UnknownRecord).$ref)),
        '#/components/schemas/PublicProfilePage',
      );
    } else {
      assert.equal(content, undefined, 'HEAD must not declare a response body');
    }
  }

  for (const schema of ['PublicProfileCollectionSummary', 'PublicProfilePageState', 'PublicProfilePage']) {
    const value = document.components.schemas[schema] as UnknownRecord;
    assert.equal(value.type, 'object');
    assert.equal(value.additionalProperties, false);
    assert.deepEqual(new Set(value.required as string[]), new Set(Object.keys(value.properties as UnknownRecord)));
  }
  const profile = document.components.schemas.PublicProfileView as { properties: UnknownRecord };
  assert.deepEqual(Object.keys(profile.properties).sort(), ['about', 'avatarUrl', 'displayName', 'handle', 'profileId']);
  assert.equal((profile.properties.profileId as UnknownRecord).$ref, '#/components/schemas/ProfileStableId');
  // Server always returns about (empty string when unset). It stays off required[]
  // so 1.16.0 clients remain additive-compatible — ADR-0015 treats optional→required
  // as breaking. MeView.profile uses ProfileView with the same additive shape.
  assert.deepEqual(
    new Set((document.components.schemas.PublicProfileView as UnknownRecord).required as string[]),
    new Set(['handle', 'displayName', 'avatarUrl']),
  );
  assert.deepEqual(
    new Set((document.components.schemas.ProfileView as UnknownRecord).required as string[]),
    new Set(['id', 'handle', 'displayName', 'avatarUrl']),
  );
  assert.equal((profile.properties.about as UnknownRecord).type, 'string');
  assert.equal((profile.properties.about as UnknownRecord).maxLength, ABOUT_MAX);
  const meProfile = document.components.schemas.ProfileView as { properties: UnknownRecord };
  assert.equal((meProfile.properties.about as UnknownRecord).type, 'string');
  assert.equal((meProfile.properties.about as UnknownRecord).maxLength, ABOUT_MAX);
  const updateMe = document.components.schemas.UpdateMeRequest as { properties: UnknownRecord };
  const updateAbout = updateMe.properties.about as { oneOf: UnknownRecord[] };
  assert.equal(updateAbout.oneOf[0]?.type, 'string');
  assert.equal(updateAbout.oneOf[0]?.maxLength, ABOUT_MAX);
  assert.equal(updateAbout.oneOf[1]?.type, 'null');
  const profileHandlePattern = String((profile.properties.handle as UnknownRecord).pattern);
  const pathHandle = document.components.parameters.PublicProfileHandlePath as {
    schema: UnknownRecord;
  };
  const pathHandlePattern = String(pathHandle.schema.pattern);
  for (const pattern of [profileHandlePattern, pathHandlePattern]) {
    const matcher = new RegExp(pattern, 'u');
    for (const valid of ['alice', '.alice', 'alice.', 'a~b', 'a_b', 'a-b']) {
      assert.equal(matcher.test(valid), true, `${valid} must remain a contract-valid identity handle`);
    }
    for (const invalid of ['.', '..', 'bad handle', 'alice/bob']) {
      assert.equal(matcher.test(invalid), false, `${invalid} must remain outside the identity handle contract`);
    }
  }
  const collection = document.components.schemas.PublicProfileCollectionSummary as { properties: UnknownRecord };
  assert.deepEqual(Object.keys(collection.properties).sort(), ['id', 'kind', 'slug', 'summary', 'title', 'updatedAt']);
});

test('every operationId is present and globally unique', () => {
  const ids = operations(readDocument()).map(({ operation }) => operation.operationId);
  assert.equal(ids.every((id) => typeof id === 'string' && id.length > 0), true);
  assert.equal(new Set(ids).size, ids.length);

  const catalog = runNodeScript('scripts/check-openapi-catalog.mjs', [sourcePath]);
  assert.equal(catalog.status, 0, catalog.stderr || catalog.stdout);
});

test('all references are local and structurally resolvable', () => {
  const document = readDocument();
  const refs = collectRefs(document);
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.notEqual(resolveLocalRef(document, ref), undefined);
});

test('security, command, CSRF, and precondition parameters are shared component references', () => {
  const document = readDocument();
  assert.deepEqual(document.components.securitySchemes.cookieAuth, {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-known_session',
    description: (document.components.securitySchemes.cookieAuth as UnknownRecord).description,
  });
  for (const [component, name, required] of [
    ['Origin', 'Origin', true],
    ['CsrfToken', 'X-CSRF-Token', true],
    ['CommandId', 'Known-Command-Id', true],
    ['IfMatch', 'If-Match', true],
    ['IfContentMatch', 'If-Content-Match', false],
  ] as const) {
    const parameter = document.components.parameters[component] as UnknownRecord;
    assert.equal(parameter.in, 'header');
    assert.equal(parameter.name, name);
    assert.equal(parameter.required, required);
  }

  const byId = new Map(operations(document).map(({ operation }) => [operation.operationId, operation]));
  for (const operationId of ['startOidcAuthorization', 'completeOidcAuthorization']) {
    assert.deepEqual(byId.get(operationId)?.security, []);
  }
  assert.deepEqual(byId.get('getSession')?.security, [{ cookieAuth: [] }, {}]);

  const commandOperations = [
    'createCollection',
    'updateCollection',
    'createCollectionNode',
    'updateCollectionNode',
    'deleteCollectionNode',
    'moveCollectionNode',
    'createAnnotation',
    'updateAnnotation',
    'deleteAnnotation',
  ];
  for (const operationId of commandOperations) {
    const operation = byId.get(operationId);
    assert.ok(operation, operationId);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    const refs = parameterRefs(operation);
    for (const ref of ['#/components/parameters/Origin', '#/components/parameters/CsrfToken', '#/components/parameters/CommandId']) {
      assert.ok(refs.has(ref), `${operationId} is missing ${ref}`);
    }
  }

  for (const operationId of ['updateCollection', 'updateCollectionNode', 'deleteCollectionNode', 'moveCollectionNode']) {
    assert.ok(parameterRefs(byId.get(operationId)!).has('#/components/parameters/IfMatch'), `${operationId} needs If-Match`);
  }
  assert.ok(parameterRefs(byId.get('deleteCollectionNode')!).has('#/components/parameters/IfContentMatch'));
  const updateHeaders = ((byId.get('updateCollection')!.responses as UnknownRecord)['200'] as UnknownRecord).headers as UnknownRecord;
  assert.equal(((updateHeaders.Location as UnknownRecord).schema as UnknownRecord).format, 'uri');
  assert.match(String((updateHeaders.Location as UnknownRecord).description), /canonical public page URL/u);
});

test('cache, request ID, errors, and stable response headers remain reusable references', () => {
  const document = readDocument();
  for (const name of ['XRequestId', 'PrivateNoStore', 'NoStore', 'ETag', 'Location', 'RetryAfter', 'SetCookie']) {
    assert.ok(document.components.headers[name], `missing header component ${name}`);
  }
  for (const name of [
    'BadRequest',
    'AuthenticationRequired',
    'Forbidden',
    'NotFound',
    'MutationConflict',
    'EditorSnapshotConflict',
    'Gone',
    'PreconditionFailed',
    'PayloadTooLarge',
    'UnsupportedMediaType',
    'InvalidDocument',
    'PreconditionRequired',
    'RateLimited',
    'InternalError',
    'ServiceUnavailable',
  ]) {
    const response = document.components.responses[name];
    assert.ok(response, `missing response component ${name}`);
    assert.equal(
      (response.content as UnknownRecord)?.['application/json'] &&
        (((response.content as UnknownRecord)['application/json'] as UnknownRecord).schema as UnknownRecord).$ref,
      '#/components/schemas/ProductErrorEnvelope',
    );
    assert.equal(((response.headers as UnknownRecord)['Cache-Control'] as UnknownRecord).$ref, '#/components/headers/PrivateNoStore');
    assert.equal(((response.headers as UnknownRecord)['X-Request-Id'] as UnknownRecord).$ref, '#/components/headers/XRequestId');
  }

  for (const { path, method, operation } of operations(document)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (typeof response.$ref === 'string') continue;
      const headers = response.headers as UnknownRecord;
      assert.equal(
        (headers['X-Request-Id'] as UnknownRecord)?.$ref,
        '#/components/headers/XRequestId',
        `${method.toUpperCase()} ${path} ${status} must reference X-Request-Id`,
      );
      assert.match(
        String((headers['Cache-Control'] as UnknownRecord)?.$ref),
        /^#\/components\/headers\/(?:PrivateNoStore|NoStore|PublicRevalidate|PublicOrPrivateCache|PublicProfileCache|PublicImmutableImageCache|PublicRevocableImageCache|PublicShortCache)$/,
        `${method.toUpperCase()} ${path} ${status} must reference a cache policy`,
      );
    }
  }
});

test('publication reads accept retained legacy locators without widening new slug writes', () => {
  const document = readDocument();
  const writeSlug = document.components.schemas.PublicationSlug as UnknownRecord;
  const locatorSlug = document.components.schemas.PublicationLocatorSlug as UnknownRecord;
  assert.equal(writeSlug.maxLength, 63);
  assert.equal(locatorSlug.maxLength, 263);

  const pathParameter = document.components.parameters.PublicCollectionSlugPath as UnknownRecord;
  assert.equal((pathParameter.schema as UnknownRecord).$ref, '#/components/schemas/PublicationLocatorSlug');
  assert.match(String(pathParameter.description), /canonical publication slug/i);
  assert.match(String(pathParameter.description), /findCollectionIdBySlug/);
  assert.match(String(pathParameter.description), /updateCollection/);
  assert.match(String(pathParameter.description), /OpaqueId/);
  assert.match(String(pathParameter.description), /does not load by collection id/i);

  const collectionFollow = document.paths['/api/v1/collections/{collectionId}/follow'];
  assert.equal(collectionFollow.put.operationId, 'followCollection');
  assert.equal(collectionFollow.delete.operationId, 'unfollowCollection');
  assert.equal(collectionFollow.get.operationId, 'getCollectionFollowState');
  assert.equal(collectionFollow.head, undefined);
  assert.equal(collectionFollow.put['x-known-route-manifest'], undefined);
  assert.deepEqual(collectionFollow.put.security, [{ cookieAuth: [] }]);
  assert.deepEqual(collectionFollow.get.security, [{ cookieAuth: [] }]);
  assert.equal(parameterRefs(collectionFollow.put).has('#/components/parameters/CollectionId'), true);
  assert.equal(parameterRefs(collectionFollow.get).has('#/components/parameters/CollectionId'), true);
  assert.equal(parameterRefs(collectionFollow.get).has('#/components/parameters/CommandId'), false);
  const followState = document.components.schemas.CollectionFollowState as {
    additionalProperties?: boolean;
    required?: readonly string[];
  };
  assert.equal(followState.additionalProperties, false);
  assert.deepEqual(followState.required, ['following', 'followerCount', 'followedAt']);

  const followedCollections = document.paths['/api/v1/me/followed-collections'];
  assert.equal(followedCollections.get.operationId, 'listFollowedCollections');
  assert.equal(followedCollections.head, undefined);
  assert.equal(followedCollections.get['x-known-route-manifest'], undefined);
  assert.deepEqual(followedCollections.get.security, [{ cookieAuth: [] }]);
  assert.equal(parameterRefs(followedCollections.get).has('#/components/parameters/FollowedCollectionsLimit'), true);
  assert.equal(parameterRefs(followedCollections.get).has('#/components/parameters/FollowedCollectionsCursor'), true);
  const followedPage = document.components.schemas.FollowedCollectionPage as {
    additionalProperties?: boolean;
    required?: readonly string[];
  };
  const followedItem = document.components.schemas.FollowedCollectionItem as {
    additionalProperties?: boolean;
    required?: readonly string[];
    properties?: Record<string, unknown>;
  };
  assert.equal(followedPage.additionalProperties, false);
  assert.deepEqual(followedPage.required, ['items', 'nextCursor']);
  assert.equal(followedItem.additionalProperties, false);
  assert.deepEqual(followedItem.required, [
    'collectionId', 'slug', 'title', 'summary', 'kind', 'owner', 'updatedAt', 'followedAt',
  ]);
  assert.equal(Object.hasOwn(followedItem.properties ?? {}, 'followerCount'), false);
  // Optional so 1.46.0 clients stay valid; the server always emits it and a
  // missing value must be read as available (see the schema description).
  assert.deepEqual(
    (followedItem.properties?.availability as { enum?: readonly string[] } | undefined)?.enum,
    ['available', 'unavailable'],
  );

  const libraryOrder = document.paths['/api/v1/me/library-order'];
  assert.equal(libraryOrder.get.operationId, 'getMyLibraryOrder');
  assert.equal(libraryOrder.head, undefined);
  assert.equal(libraryOrder.get['x-known-route-manifest'], undefined);
  assert.deepEqual(libraryOrder.get.security, [{ cookieAuth: [] }]);
  const libraryOrderUpdate = document.paths['/api/v1/me/library-order/{section}'];
  assert.equal(libraryOrderUpdate.put.operationId, 'updateMyLibraryOrder');
  assert.equal(libraryOrderUpdate.get, undefined);
  assert.deepEqual(libraryOrderUpdate.put.security, [{ cookieAuth: [] }]);
  assert.equal(parameterRefs(libraryOrderUpdate.put).has('#/components/parameters/LibraryOrderSection'), true);
  assert.equal(parameterRefs(libraryOrderUpdate.put).has('#/components/parameters/Origin'), true);
  assert.equal(parameterRefs(libraryOrderUpdate.put).has('#/components/parameters/CommandId'), true);
  assert.equal(parameterRefs(libraryOrderUpdate.put).has('#/components/parameters/CsrfToken'), true);
  const libraryOrderSection = document.components.schemas.LibraryOrderSection as {
    enum?: readonly string[];
  };
  assert.deepEqual(libraryOrderSection.enum, ['mine', 'shared', 'following']);
  const libraryOrderView = document.components.schemas.LibraryOrderView as {
    additionalProperties?: boolean;
    required?: readonly string[];
    properties?: Record<string, { required?: readonly string[] }>;
  };
  assert.equal(libraryOrderView.additionalProperties, false);
  assert.deepEqual(libraryOrderView.required, ['sections']);
  assert.deepEqual(libraryOrderView.properties?.sections?.required, ['mine', 'shared', 'following']);
  const libraryOrderIds = document.components.schemas.LibraryOrderSectionIds as {
    maxItems?: number;
    uniqueItems?: boolean;
  };
  assert.equal(libraryOrderIds.maxItems, 200);
  assert.equal(libraryOrderIds.uniqueItems, true);
  const libraryOrderRequest = document.components.schemas.LibraryOrderUpdateRequest as {
    additionalProperties?: boolean;
    required?: readonly string[];
  };
  assert.equal(libraryOrderRequest.additionalProperties, false);
  assert.deepEqual(libraryOrderRequest.required, ['collectionIds']);
  const libraryOrderSectionView = document.components.schemas.LibraryOrderSectionView as {
    additionalProperties?: boolean;
    required?: readonly string[];
  };
  assert.equal(libraryOrderSectionView.additionalProperties, false);
  assert.deepEqual(libraryOrderSectionView.required, ['section', 'collectionIds']);

  const collectionPath = document.paths['/api/v1/collections/{collectionId}'];
  const publicGet = collectionPath.get;
  const update = collectionPath.patch;
  assert.equal(publicGet.operationId, 'getPublicCollectionPage');
  assert.equal(update.operationId, 'updateCollection');
  assert.equal(parameterRefs(publicGet).has('#/components/parameters/PublicCollectionSlugPath'), true);
  assert.equal(parameterRefs(publicGet).has('#/components/parameters/CollectionId'), false);
  assert.equal(parameterRefs(update).has('#/components/parameters/CollectionId'), true);
  assert.equal(parameterRefs(update).has('#/components/parameters/PublicCollectionSlugPath'), false);
  assert.match(String(publicGet.description), /findCollectionIdBySlug/);
  assert.match(String(publicGet.description), /not the Collection OpaqueId/);
  assert.equal(
    ((document.components.parameters.CollectionId as UnknownRecord).schema as UnknownRecord).$ref,
    '#/components/schemas/OpaqueId',
  );
  const mergePatch = document.components.schemas.CollectionMergePatch as {
    properties: Record<string, UnknownRecord>;
  };
  assert.equal(mergePatch.properties.publicationSlug?.$ref, '#/components/schemas/PublicationSlug');
  assert.equal(mergePatch.properties.allowSearchIndexing?.type, 'boolean');
  const collectionView = document.components.schemas.CollectionView as {
    properties: Record<string, UnknownRecord>;
  };
  assert.equal(collectionView.properties.allowSearchIndexing?.default, false);
  const publicSummary = document.components.schemas.PublicCollectionSummary as {
    properties: Record<string, UnknownRecord>;
    required?: string[];
  };
  assert.equal(publicSummary.properties.slug?.$ref, '#/components/schemas/PublicationLocatorSlug');
  assert.equal(publicSummary.properties.owner?.$ref, '#/components/schemas/ProfileSummaryDto');
  assert.equal(publicSummary.properties.viewCount?.type, 'integer');
  assert.equal(publicSummary.properties.viewCount?.minimum, 0);
  assert.match(String(publicSummary.properties.viewCount?.description), /collection_view/);
  assert.match(String(publicSummary.properties.viewCount?.description), /30 UTC calendar days including/);
  assert.equal((publicSummary.required ?? []).includes('viewCount'), false);
  assert.deepEqual(publicSummary.required, ['id', 'slug', 'title', 'summary', 'kind', 'rootNodeId', 'updatedAt', 'access']);
});

test('warning exceptions preserve the deliberate contract surface', () => {
  const document = readDocument();
  const redocly = parse(readFileSync(join(backendRoot, 'redocly.yaml'), 'utf8')) as {
    rules?: Record<string, unknown>;
  };
  assert.equal(redocly.rules?.['operation-2xx-response'], 'off');
  assert.equal(redocly.rules?.['operation-4xx-response'], 'off');
  assert.equal(redocly.rules?.['info-license'], 'off');
  assert.equal(redocly.rules?.['no-unused-components'], 'off');

  assert.ok(document.components.schemas.NodeView, 'NodeView must not be deleted to silence an unused-component warning');
  const pathRefs = collectRefs(document.paths);
  assert.equal(pathRefs.includes('#/components/schemas/NodeView'), false, 'Phase 1 operations intentionally use narrower node views');

  const callback = document.paths['/api/v1/auth/oidc/callback'].get;
  assert.deepEqual(Object.keys(callback.responses ?? {}), ['303'], 'OIDC callback is intentionally 3xx-only');
});

test('requiring bookmarkCount on OwnedCollectionListItem breaks the 1.19.0 client contract', () => {
  const document = readDocument();
  const item = document.components.schemas.OwnedCollectionListItem as UnknownRecord;
  assert.equal(Object.hasOwn(item.properties as UnknownRecord, 'bookmarkCount'), true);
  assert.equal((item.required as string[]).includes('bookmarkCount'), false);

  const breaking = structuredClone(document) as OpenApiDocument;
  const breakingItem = breaking.components.schemas.OwnedCollectionListItem as UnknownRecord;
  breakingItem.required = [...(breakingItem.required as string[]), 'bookmarkCount'];

  const tempRoot = mkdtempSync(join(tmpdir(), 'known-bookmarkcount-required-'));
  const candidate = join(tempRoot, 'candidate.yaml');
  try {
    writeFileSync(candidate, stringify(breaking), 'utf8');
    const result = runNodeScript('scripts/check-openapi-breaking.mjs', [
      '--baseline', join(backendRoot, 'openapi/baselines/product-v1.1.19.0.yaml'),
      '--candidate', candidate,
    ]);
    assert.notEqual(result.status, 0, 'bookmarkCount in required[] must fail the 1.19.0 additive check');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const source = readDocument();
  assert.deepEqual(
    (source.components.schemas.OwnedCollectionListItem as UnknownRecord).required,
    ['collection', 'capabilities'],
  );
});

test('legacy OIDC auth surface stays declared-but-deprecated and legacy-oidc scoped (Task E4)', () => {
  const document = readDocument();
  const legacyPaths = Object.keys(document.paths)
    .filter((path) => path.startsWith('/api/v1/auth/oidc/'))
    .sort();
  assert.deepEqual(
    legacyPaths,
    ['/api/v1/auth/oidc/callback', '/api/v1/auth/oidc/start'],
    'no legacy OIDC auth path may be added back to the product OpenAPI',
  );

  for (const path of legacyPaths) {
    const operation = document.paths[path].get;
    assert.ok(operation, `${path} must keep its GET operation`);
    assert.match(String(operation.summary ?? ''), /deprecated/i, `${path} summary must stay marked deprecated`);
    assert.match(String(operation.description ?? ''), /DEPRECATED/i, `${path} description must stay marked deprecated`);
  }

  // The auth-route manifest scopes the legacy surface so composition gates it:
  // exactly the two legacy OIDC routes, status registered (legacy mode only),
  // each carrying the frozen OpenAPI operationId. F3 route evidence proves the
  // Better Auth composition registers none of them.
  const legacyEntries = AUTH_ROUTE_MANIFEST.filter((entry) => entry.scope === 'legacy-oidc');
  assert.deepEqual(
    legacyEntries.map((entry) => entry.path).sort(),
    ['/api/v1/auth/oidc/callback', '/api/v1/auth/oidc/start'],
    'the auth-route manifest must declare exactly the two legacy OIDC entries',
  );
  for (const entry of legacyEntries) {
    assert.equal(entry.status, 'registered', `${entry.path} stays registered in legacy mode only`);
    const operation = document.paths[entry.path].get;
    assert.equal(
      operation.operationId,
      entry.operationId,
      `${entry.path} manifest operationId must match the frozen OpenAPI operationId`,
    );
    assert.equal(
      ['oidc-start', 'oidc-callback'].includes(entry.rateLimitFamily ?? ''),
      true,
      `${entry.path} keeps its sealed rate-limit family`,
    );
  }
  assert.deepEqual(
    legacyEntries.map((entry) => entry.operationId).sort(),
    ['completeOidcAuthorization', 'startOidcAuthorization'],
  );
});
