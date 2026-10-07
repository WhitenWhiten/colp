/**
 * BF-07 source-bound Implemented (not Deployment-proven).
 *
 * Pins the bookmark-favicon checklist to covering-test source tokens
 * (readFile + assert.match), not “filename exists”. This is the acceptance
 * contract itself: no evidence runner, CI job, Playwright real-stack spec,
 * or artifact schema.
 *
 * Non-gaps (not required for Implemented): Web upload UI, COLP Attachment /
 * Sync attachments projection, inventory backfill. Cross-origin favicon
 * capture skip is contract.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

function readBackend(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function readFrontend(relativePath: string): string {
  return readFileSync(resolve(backendRoot, '../Known-Frontend', relativePath), 'utf8');
}

function readExtension(relativePath: string): string {
  return readFileSync(resolve(backendRoot, '../Known-Extension', relativePath), 'utf8');
}

function pin(source: string, token: string, label: string): void {
  assert.match(source, new RegExp(escapeRegExp(token), 'u'), label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const prefixOverlap = readBackend('tests/unit/collections/favicon-prefix-overlap.test.ts');
const faviconHttp = [
  readBackend('tests/unit/collections/bookmark-favicon-http.test.ts'),
  readBackend('tests/unit/collections/bookmark-favicon-http-helper.test.ts'),
].join('\n');
const publicGet = readBackend('tests/unit/collections/public-favicon-get-r2.test.ts');
const helperCors = readBackend('tests/unit/collections/bookmark-favicon-helper-cors.test.ts');
const publicQuery = readBackend('tests/unit/product/product-public-collection-query.test.ts');
const publicHttp = readBackend('tests/unit/product/product-public-collection-http.test.ts');
const createNode = readBackend('tests/unit/collections/create-collection-node.test.ts');
const updateNode = readBackend('tests/unit/collections/update-collection-node.test.ts');
const moveNode = readBackend('tests/unit/collections/move-collection-node.test.ts');
const iconsPostgres = readBackend('tests/integration/collections/bookmark-icons-postgres.integration.test.ts');
const publicIconPostgres = readBackend(
  'tests/integration/product/product-public-bookmark-icon-postgres.integration.test.ts',
);
const library = [
  readFrontend('web/src/pages/library-desk/LibraryDesk.test.tsx'),
  readFrontend('web/src/pages/library-desk/LibraryDesk.bookmark-icon.test.tsx'),
].join('\n');
// eee419d2d folded the /library/:id/edit workbench into the LibraryDesk sheet
// and deleted CollectionEditor.bookmark-icon.test.tsx. The editor surface —
// tree rows plus the bookmark detail drawer — is now covered by the desk's
// bookmark-icon spec and the NodeEditDrawer spec, so the editor pin reads the
// surviving sources.
const editor = [
  readFrontend('web/src/pages/CollectionEditor.test.tsx'),
  readFrontend('web/src/pages/library-desk/LibraryDesk.bookmark-icon.test.tsx'),
  readFrontend('web/src/pages/library-desk/NodeEditDrawer.test.tsx'),
].join('\n');
const landing = readFrontend('web/src/pages/Landing.test.tsx');
const collection = [
  readFrontend('web/src/pages/Collection.test.tsx'),
  readFrontend('web/src/pages/Collection.bookmark-icon.test.tsx'),
].join('\n');
const bookmarkIcon = readFrontend('web/src/lib/bookmarkIcon.test.ts');
const pipeline = readExtension('tests/favicon-pipeline.test.ts');
const extensionSchema = readExtension('src/sync-state/schema.ts');
const capture = readExtension('tests/favicon-capture.test.ts');

test('BF-07 five-way prefix overlap includes favicon vs avatar vs export', () => {
  pin(prefixOverlap, 'assertPublicObjectPrefixesDoNotOverlap', 'five-way helper');
  pin(prefixOverlap, 'rejects favicon exact equality with avatar, live, or probe', 'exact equality');
  pin(prefixOverlap, 'rejects avatar vs favicon string-prefix relations in either direction', 'string prefix');
  pin(prefixOverlap, 'expectOverlapRejected(AVATAR_PREFIX, AVATAR_PREFIX, LIVE_PREFIX, PROBE_PREFIX)', 'avatar===favicon');
  pin(prefixOverlap, "FAVICON_R2_PREFIX: 'avatar/'", 'loadConfig avatar/favicon overlap');
  pin(prefixOverlap, 'rejects export overlap with avatar, favicon, live, or probe', 'export overlap');
});

test('BF-07 64 KiB hard cap is 413 with no bookmark_icons row', () => {
  pin(faviconHttp, '64KiB+1 is 413 payload_too_large with no bookmark_icons row and no bound PUT', 'cap test');
  pin(faviconHttp, 'BOOKMARK_FAVICON_MAX_BYTES + 1', 'max+1');
  pin(faviconHttp, "assertProductErrorEnvelope(response, 413, 'payload_too_large')", '413 envelope');
  pin(faviconHttp, 'assert.equal(harness.collectionsState.bookmarkIcons.size, 0)', 'no row');
  pin(faviconHttp, 'assert.equal(harness.faviconStore.puts.length, 0)', 'no PUT');
});

test('BF-07 public GET is anonymous without session and never Set-Cookie', () => {
  pin(publicGet, 'anonymous valid PNG GetObject is served on GET /api/v1/favicon/:id with immutable cache', 'anonymous GET');
  pin(publicGet, "assert.equal(headers['set-cookie'], undefined, 'favicon GET must not Set-Cookie')", 'no Set-Cookie');
  pin(publicGet, 'assertNoSetCookie(response.headers)', 'assertNoSetCookie');
  pin(publicGet, 'app.inject({ method: \'GET\', url: `/api/v1/favicon/${FAVICON_ID}` })', 'inject without cookie');
  pin(publicGet, 'createR2FaviconStore', 'R2 adapter');
  pin(publicGet, 'startFaultServer', 'R2 fault harness');
  pin(publicGet, 'buildApiApp', 'Fastify');
  assert.doesNotMatch(
    publicGet,
    /anonymous valid PNG[\s\S]{0,900}cookie:/iu,
    'anonymous PNG GET must not send a session cookie',
  );
});

test('BF-07 private Library / Editor / shared / Landing have zero third-party favicon CDN', () => {
  for (const [label, source] of [
    ['LibraryCollection.test.tsx', library],
    ['editor surface (LibraryDesk fold)', editor],
    ['Landing.test.tsx', landing],
  ] as const) {
    pin(source, 'favicon.im', `${label} favicon.im`);
    pin(source, 'a.favicon.im', `${label} a.favicon.im`);
    pin(source, 'icons.duckduckgo.com', `${label} DuckDuckGo`);
  }
  pin(library, 'does not hotlink favicon.im or DuckDuckGo for intranet or github bookmarks', 'owned library');
  pin(library, 'does not hotlink third-party favicons on a shared collection with public github URLs', 'shared library');
  pin(library, 'https://intranet.example.test', 'library intranet fixture');
  pin(library, 'https://github.com', 'library github fixture');
  pin(library, "expect(thirdPartyFaviconSrcs()).toEqual([])", 'library zero CDN img');
  pin(library, "expect(document.querySelector('[data-testid=\"library-host-letter\"]')).not.toBeNull()", 'library letter not img-src-only');
  pin(editor, 'does not hotlink favicon.im or DuckDuckGo for intranet or github bookmarks', 'editor');
  pin(editor, 'https://intranet.example.test', 'editor intranet fixture');
  pin(editor, "expect(thirdPartyFaviconSrcs()).toEqual([])", 'editor zero CDN img');
  pin(editor, "expect(document.querySelector('img[src*=\"/api/v1/favicon/\"]')).toBeNull()", 'editor letter');
  pin(landing, 'renders the dither-field hero and no third-party favicon URLs', 'landing');
  pin(landing, "expect(srcs.some((src) => src.includes('a.favicon.im'))).toBe(false)", 'landing zero CDN img');
});

test('BF-07 public Collection CDN is only a.favicon.im+throw-error-on-404 when flag true and iconUrl missing', () => {
  pin(collection, "const GITHUB_CDN = 'https://a.favicon.im/github.com?throw-error-on-404=true'", 'exact CDN');
  pin(collection, 'hotlinks the exact CDN src when faviconCdnAllowed is true and iconUrl is missing', 'CDN gate');
  pin(collection, 'expect(imgSrcs()).toContain(GITHUB_CDN)', 'CDN src');
  pin(collection, "expect(imgSrcs()).not.toContain('https://favicon.im/github.com')", 'no queryless favicon.im');
  pin(collection, 'renders a same-origin object iconUrl and not the CDN', 'object wins');
  pin(collection, 'expect(imgSrcs()).toContain(OBJECT_ICON)', 'object URL');
  pin(collection, "{ name: 'object', iconUrl: OBJECT_ICON, faviconCdnAllowed: true, expectObject: true }", 'compact object');
  pin(collection, "{ name: 'cdn', faviconCdnAllowed: true, expectCdn: true }", 'compact CDN');
  pin(collection, "{ name: 'letter', faviconCdnAllowed: false, expectLetter: true }", 'compact letter');
  pin(bookmarkIcon, "const GITHUB_CDN = 'https://a.favicon.im/github.com?throw-error-on-404=true'", 'helper exact CDN');
  pin(bookmarkIcon, 'hotlinks the exact a.favicon.im URL with throw-error-on-404 when allowed', 'helper CDN test');
  pin(bookmarkIcon, "{ kind: 'cdn', src: GITHUB_CDN }", 'kind cdn');
  pin(bookmarkIcon, "{ kind: 'object', src: HTTPS_OBJECT }", 'kind object');
  pin(bookmarkIcon, "{ kind: 'letter' }", 'kind letter');
  pin(bookmarkIcon, "expect(src).not.toEqual({ kind: 'cdn', src: 'https://favicon.im/github.com' })", 'no queryless CDN');
  pin(bookmarkIcon, "expect(src).not.toEqual({ kind: 'cdn', src: 'https://a.favicon.im/github.com' })", 'query required');
});

test('BF-07 member projection and flag false never allow CDN', () => {
  pin(collection, 'does not hotlink CDN when faviconCdnAllowed is absent', 'flag absent');
  pin(collection, 'does not hotlink CDN when faviconCdnAllowed is false', 'flag false');
  pin(collection, 'does not hotlink CDN on a member projection even with public github.com URLs', 'member UI');
  pin(collection, "{ faviconCdnAllowed: false }", 'member fixture flag');
  pin(collection, "'member'", 'member access');
  pin(publicQuery, 'directory-public anonymous page sets faviconCdnAllowed true', 'anonymous true');
  pin(publicQuery, 'unlisted anonymous page sets faviconCdnAllowed false even when access is public', 'unlisted query');
  pin(publicQuery, 'owner Session on a public Collection uses member projection and forbids CDN', 'member query');
  pin(publicQuery, 'assert.equal(page.collection.faviconCdnAllowed, false)', 'query false');
  pin(publicHttp, 'HTTP unlisted anonymous page sets faviconCdnAllowed false', 'unlisted HTTP');
  pin(publicHttp, 'HTTP member Session on a public Collection sets faviconCdnAllowed false', 'member HTTP');
  pin(publicHttp, "assert.equal(response.json().collection.faviconCdnAllowed, false)", 'HTTP false');
});

test('BF-07 PNG-as-ICO is retagged to image/png and GET 200', () => {
  pin(faviconHttp, 'PNG bytes declared as image/x-icon persist and GET as image/png; revision unchanged', 'png-as-ico');
  pin(faviconHttp, "'content-type': 'image/x-icon'", 'declared ico');
  pin(faviconHttp, "assert.equal(bound.contentType, 'image/png')", 'stored png');
  pin(faviconHttp, "assert.equal(get.statusCode, 200, get.body)", 'GET 200');
  pin(faviconHttp, "assert.equal(get.headers['content-type'], 'image/png')", 'GET png');
});

test('BF-07 extension Bearer + Known-Command-Id is isolated from Session CSRF', () => {
  pin(faviconHttp, 'helper capture POST uploads with Bearer + etag + policy revision and the helper-route fingerprint', 'helper POST');
  pin(faviconHttp, 'credential isolation: extension Origin cannot call Product POST; Web Origin cannot call helper', 'isolation');
  pin(faviconHttp, "authorization: `Bearer ${OWNER_BEARER}`", 'Bearer');
  pin(faviconHttp, "'known-command-id'", 'command id header');
  pin(faviconHttp, "assertProductErrorEnvelope(extensionOnProduct, 403, 'csrf_failed')", 'extension Origin CSRF');
  pin(faviconHttp, 'helperCookieNoBearer', 'helper rejects session cookie');
  pin(pipeline, "assert.equal(post.headers.get('Authorization'), `Bearer ${TOKEN}`)", 'pipeline Bearer');
  pin(pipeline, "assert.equal(post.headers.get('Known-Command-Id'), COMMAND_ID)", 'pipeline Command-Id');
  pin(pipeline, 'product csrf favicon must not be called', 'no Product CSRF mix');
  pin(pipeline, 'product csrf favicon must not be called', 'no Product CSRF helper mix');
  const schemaVersion = /export const DATABASE_VERSION = (\d+);/u.exec(extensionSchema);
  assert.ok(schemaVersion && Number(schemaVersion[1]) >= 17,
    'favicon capture retains the first-run and parked-diagnostic schema migrations');
  assert.doesNotMatch(extensionSchema, /DATABASE_VERSION = 9/u, 'v9 pin is retired after first-run mounts');
  pin(helperCors, 'helper OPTIONS 204 allows Known-Command-Id and does not use sync Allow-Headers', 'CORS branch');
  pin(helperCors, 'assert.match(allowed, /Known-Command-Id/i)', 'preflight Command-Id');
  pin(helperCors, 'assert.notEqual(allowed, SYNC_COLLECTIONS_ALLOW_HEADERS)', 'not syncOrigin headers');
});

test('BF-07 favicon in-progress is 429 rate_limited, never 409 command_in_progress', () => {
  pin(faviconHttp, 'in-progress is 429 rate_limited and never 409 command_in_progress', 'session in-progress');
  pin(faviconHttp, "assert.equal(response.statusCode, 429, response.body)", '429');
  pin(faviconHttp, "assert.equal(envelope.error.code, 'rate_limited')", 'rate_limited');
  pin(faviconHttp, 'assert.notEqual(response.statusCode, 409)', 'not 409 status');
  pin(faviconHttp, "assert.notEqual(envelope.error.code, 'command_in_progress')", 'not command_in_progress');
  pin(faviconHttp, 'helper in-progress uses the helper route fingerprint and returns 429 rate_limited', 'helper 429');
});

test('BF-07 GET 404 uses public, max-age=60 and not immutable / no-store / public-revalidate', () => {
  pin(publicGet, "const SHORT_PUBLIC_CACHE = 'public, max-age=60'", 'short cache const');
  pin(publicGet, "const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'", 'immutable const');
  pin(publicGet, "const PUBLIC_REVALIDATE = 'public, no-cache, must-revalidate'", 'revalidate const');
  pin(publicGet, 'assertShortPublicMissingCache', '404 cache helper');
  pin(publicGet, 'assert.equal(cacheControl, SHORT_PUBLIC_CACHE)', '404 equals short');
  pin(publicGet, "assert.notEqual(cacheControl, 'private, no-store')", 'not private no-store');
  pin(publicGet, "assert.notEqual(cacheControl, 'no-store')", 'not no-store');
  pin(publicGet, 'assert.notEqual(cacheControl, IMMUTABLE_CACHE)', 'not immutable');
  pin(publicGet, 'assert.notEqual(cacheControl, PUBLIC_REVALIDATE)', 'not public-revalidate');
});

test('BF-07 create / update / move responses include iconUrl and PATCH title keeps it', () => {
  pin(createNode, "assert.equal(Object.hasOwn(created.node, 'iconUrl'), true)", 'create has iconUrl');
  pin(createNode, 'assert.equal(created.node.iconUrl, null)', 'create null iconUrl');
  pin(createNode, 'create must project iconUrl via the icon lookup helper', 'create JOIN');
  pin(updateNode, 'PATCH title keeps a seeded iconUrl (same-origin, not null, not CDN)', 'patch keeps');
  pin(updateNode, 'assert.equal(updated.node.iconUrl, `https://known.example/api/v1/favicon/${objectId}`)', 'patch URL');
  pin(moveNode, 'move keeps a seeded bookmark iconUrl', 'move keeps');
  pin(moveNode, 'assert.equal(moved.node.iconUrl, `https://known.example/api/v1/favicon/${objectId}`)', 'move URL');
});

test('BF-07 binds real PostgreSQL bookmark_icons integrations', () => {
  pin(iconsPostgres, 'describeWithPostgres', 'icons postgres gate');
  pin(iconsPostgres, 'createIsolatedPostgresRuntime', 'isolated postgres');
  pin(iconsPostgres, 'bookmark_icons', 'table');
  pin(iconsPostgres, 'Product recursive folder delete removes descendant bookmark icon rows', 'recursive tombstone');
  pin(iconsPostgres, 'Sync canonical delete_node path removes the icon row without deleteCollectionNode', 'sync tombstone');
  pin(publicIconPostgres, 'describeWithPostgres', 'public icon postgres gate');
  pin(publicIconPostgres, 'anonymous directory-public page JOINs icons once, drops private icons, and allows CDN', 'live JOIN');
  pin(publicIconPostgres, 'unlisted anonymous page forbids CDN even when access is public', 'unlisted postgres');
  pin(publicIconPostgres, 'owner Session on the public Collection uses member projection and forbids CDN', 'member postgres');
  pin(publicIconPostgres, 'assert.equal(body.collection.faviconCdnAllowed, true)', 'postgres CDN true');
  pin(publicIconPostgres, 'assert.equal(body.collection.faviconCdnAllowed, false)', 'postgres CDN false');
});

test('BF-07 non-gaps: no Web upload UI, COLP Attachment, or backfill; cross-origin skip is contract', () => {
  for (const [label, source] of [
    ['LibraryCollection.test.tsx', library],
    ['CollectionEditor.test.tsx', editor],
    ['Landing.test.tsx', landing],
    ['Collection.test.tsx', collection],
  ] as const) {
    assert.doesNotMatch(source, /uploadFavicon|deleteFavicon/u, `${label} has no Web favicon upload API`);
    assert.doesNotMatch(source, /type=["']file["']/u, `${label} has no favicon file input`);
  }
  assert.doesNotMatch(faviconHttp, /create_attachment|rel=['"]favicon['"]/u, 'HTTP contract is not COLP Attachment');
  assert.doesNotMatch(iconsPostgres, /create_attachment/u, 'postgres icons are not COLP attachments');
  assert.doesNotMatch(
    faviconHttp,
    /inventory backfill|backfillFavicon|favicon backfill/iu,
    'no inventory backfill in HTTP contract',
  );
  assert.doesNotMatch(
    iconsPostgres,
    /inventory backfill|backfillFavicon|favicon backfill/iu,
    'no inventory backfill in postgres icons',
  );
  pin(pipeline, 'cross-origin favIconUrl does not POST', 'pipeline skip POST');
  pin(pipeline, "forbiddenFetch: ['https://cdn.other.test/favicon.png']", 'pipeline skip fetch');
  pin(capture, 'skips cross-origin favIconUrl without fetching it', 'capture skip');
  pin(capture, "favIconUrl: 'https://cdn.other.test/favicon.png'", 'capture cross-origin URL');
  pin(capture, 'assert.deepEqual(fetched, [])', 'capture zero fetch');
  pin(pipeline, 'assert.doesNotMatch(source, /<all_urls>/)', 'no all_urls');
});

test('BF-07 does not add a Deployment-proven evidence runner or workflow', () => {
  const packageJson = JSON.parse(readBackend('package.json')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts['evidence:bookmark-favicon-acceptance'], undefined);
  assert.doesNotMatch(
    Object.keys(packageJson.scripts).join('\n'),
    /evidence:bookmark-favicon/u,
    'no bookmark-favicon evidence script',
  );
  const workflow = readFileSync(resolve(backendRoot, '../.github/workflows/known-backend-ci.yml'), 'utf8');
  assert.doesNotMatch(workflow, /bookmark-favicon-acceptance/u);
});
