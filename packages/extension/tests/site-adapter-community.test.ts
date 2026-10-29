// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { resolve } from 'node:path';
import { Script, runInThisContext } from 'node:vm';
import { packSiteAdapter } from '../scripts/pack-site-adapter.mjs';
import { MemoryStorageArea } from '../src/credential-store.js';
import { inspectCommunityPackage, installedSites } from '../src/site-adapters/community-package.js';
import { communitySiteDefinition, itemUrlCodec, siteGrants, type CommunityManifest } from '../src/site-adapters/community-definition.js';
import type { CommunitySdk } from '../src/site-adapters/community-page.js';
import { communityWrapper } from '../src/site-adapters/community-wrapper.js';
import { communityStore, communityWorldId, COMMUNITY_STATE } from '../src/site-adapters/community-state.js';
import { communityRegistration, communityRegistrationMatches } from '../src/site-adapters/community-registration.js';
import { createCommunityRuntime, communityWorld } from '../src/site-adapters/community-runtime.js';
import { createPageContext } from '../src/site-adapters/page-context.js';
import { abortableSleep, fail } from '../src/site-adapters/read-errors.js';
import { siteDisplayTitle } from '../src/site-adapters/title.js';
import { readLimits } from '../src/site-adapters/read-policy.js';
import { validAdapterMessage } from '../src/site-adapters/schemas.js';
import { bilibiliDefinition } from '../src/site-adapters/bilibili/definition.js';
import { identityDefinition, resolveContentIdentity, setCommunitySites } from '../src/site-adapters/registry.js';
import type { AdapterMessage, SiteAdapter, SiteItem } from '../src/site-adapters/contracts.js';
import { qualifySiteAdapter } from './fixtures/site-adapters/qualification.js';
import { video } from './fixtures/site-adapters/bilibili.js';

const shelfText = await packSiteAdapter(resolve(import.meta.dirname, 'fixtures/site-adapters/shelf-package'));
const shelf = inspectCommunityPackage(shelfText).package, definition = communitySiteDefinition(shelf.manifest);
const author = runInThisContext(`(function (sdk) {\n${shelf.script}\n})`) as (sdk: CommunitySdk) => SiteAdapter;
const sdk: CommunitySdk = { readPolicy: readLimits({ readPolicy: { spacingMs: 1, requestSpacingMs: 1 } }), fail, abortableSleep, siteDisplayTitle };
const alpha: SiteItem = { id: 'alpha', identity: 'siteId', kind: 'article', url: 'https://shelf.example/a/alpha', title: 'Alpha' };
const signIn = () => { document.head.innerHTML = '<meta name="shelf:user" content="42">'; };
const withManifest = (changes: Record<string, unknown>, text = shelfText) => { const value = JSON.parse(text); return JSON.stringify({ ...value, manifest: { ...value.manifest, ...changes } }); };
afterEach(() => { vi.unstubAllGlobals(); setCommunitySites([]); document.head.replaceChildren(); document.body.replaceChildren(); });

// The same qualification a bundled adapter passes, against the definition the host derives from the manifest.
qualifySiteAdapter({ definition, accountId: '42', item: alpha, collection: definition.defaultCollection!, setup() {
  signIn(); vi.stubGlobal('fetch', async () => Response.json({ items: [{ slug: 'alpha', title: 'Alpha' }], next: null }));
  return author(sdk);
} });

test('package inspection is inert, hashes exact bytes and fails closed on unknown or unsupported fields', () => {
  const marked = withManifest({}).replace(/"script": "/u, '"script": "globalThis.mustNotExecute = true;\\n'), p = inspectCommunityPackage(marked);
  expect((globalThis as Record<string, unknown>).mustNotExecute).toBeUndefined(); expect(p.digest).not.toBe(inspectCommunityPackage(marked + '\n').digest);
  expect(() => inspectCommunityPackage('﻿' + shelfText)).toThrow('packageInvalid');
  expect(() => inspectCommunityPackage(shelfText.replace('Shelf fixture', '\ud800'))).toThrow('packageInvalidEncoding');
  expect(() => inspectCommunityPackage(' '.repeat(512 * 1024 + 1))).toThrow('packageTooLarge');
  for (const changes of [{ official: true }, { bundledProbeIds: ['probe'] }, { readRecipeIds: ['recipe'] }, { capabilities: ['mountCaptureControl'] }, { identityVersion: 0 },
    { matches: ['https://*/*'] }, { matches: ['http://shelf.example/*'] }, { execution: { ...shelf.manifest.execution, mode: 'bundled' } }, { label: undefined }, { label: ' ' },
    { siteKey: 'Shelf Key' }, { adapterId: 'bundled.shelf' }, { itemUrl: 'https://shelf.example/a/{id}/{id}' }, { itemUrl: 'http://shelf.example/a/{id}' },
    { connectOrigins: ['https://api.example/path'] }, { defaultCollection: { id: 'saved' } }, { readPolicy: { spacingMs: -1 } },
    { icon: { kind: 'asset', path: 'icons/icon-32.png' } }, { icon: { kind: 'url', url: 'https://icons.example/b.svg' } }, { icon: { kind: 'data', dataUrl: 'data:image/svg+xml;base64,AAAA' } }])
    expect(() => inspectCommunityPackage(withManifest(changes))).toThrow('packageUnsupported');
  // The same registry rules as a bundled site, including a site identity no bundled site uses.
  expect(() => inspectCommunityPackage(withManifest({ siteKey: bilibiliDefinition.siteKey, identityVersion: bilibiliDefinition.identityVersion }))).toThrow('invalidSiteRegistry');
  expect(() => inspectCommunityPackage(withManifest({ capabilities: ['enumerateCollections', 'enumerateItems'] }))).toThrow('invalidDefaultCollection');
  expect(() => inspectCommunityPackage(withManifest({ negativeReadback: true }))).toThrow('unsupportedHostCapability');
  expect(() => inspectCommunityPackage(withManifest({ readPolicy: { requestMs: 60001 } }))).toThrow('invalidReadPolicy');
  // A package names item pages only on its own sites.
  expect(() => inspectCommunityPackage(withManifest({ itemUrl: 'https://www.bilibili.com/video/{id}' }))).toThrow('invalidItemUrl');
  const value = JSON.parse(shelfText);
  expect(() => inspectCommunityPackage(JSON.stringify({ ...value, provenance: { ...value.provenance, revision: 'main' } }))).toThrow('packageUnsupported');
  expect(() => inspectCommunityPackage(JSON.stringify({ ...value, provenance: { ...value.provenance, sourceUrl: 'https://x.test/?secret=bad' } }))).toThrow('packageUnsupported');
  // Any HTTPS site, with its own collections, readers and fetch origins.
  const other = inspectCommunityPackage(withManifest({ adapterId: 'community.notes', siteKey: 'notes', matches: ['https://notes.example/*', 'https://m.notes.example/*'],
    capabilities: ['observeFavorites', 'enumerateCollections', 'enumerateItems', 'resolveItem', 'readMemberships'], defaultCollection: undefined, itemUrl: undefined,
    connectOrigins: ['https://api.notes.example'], readScope: 'account', collectionSnapshot: 'pointInTime', negativeReadback: true }));
  expect(communitySiteDefinition(other.package.manifest)).toMatchObject({ origin: 'https://notes.example', runtime: 'userScript', readScope: 'account', negativeReadback: true });
  const wrapper = communityWrapper({ manifest: shelf.manifest, credential: 'private-world-credential', script: shelf.script }); new Script(wrapper);
  expect(wrapper).not.toMatch(/window\.postMessage|chrome\.(storage|bookmarks)|new Function|eval\(/u);
});

test('an itemUrl template gives each item one canonical URL, in the path or as a query value', () => {
  const path = itemUrlCodec('https://shelf.example/a/{id}')!, query = itemUrlCodec('https://video.example/watch?v={id}')!;
  expect(path.url('alpha')).toBe('https://shelf.example/a/alpha'); expect(path.url('al pha')).toBeNull();
  // Dot-only IDs would be path segments the URL parser removes, leaving a bookmark that maps back to nothing.
  for (const id of ['.', '..']) expect(path.url(id)).toBeNull(); expect(path.id('https://shelf.example/a/..')).toBeNull(); expect(path.url('v1.2')).toBe('https://shelf.example/a/v1.2');
  for (const url of ['https://shelf.example/a/alpha', 'https://shelf.example/a/alpha/', 'https://shelf.example/a/alpha?ref=x#top']) expect(path.id(url)).toBe('alpha');
  for (const url of ['https://other.example/a/alpha', 'https://shelf.example/b/alpha', 'https://shelf.example/a/al%20pha', 'https://u:p@shelf.example/a/alpha', 'not a url']) expect(path.id(url)).toBeNull();
  expect(query.id('https://video.example/watch?t=3&v=Ab_9-x')).toBe('Ab_9-x'); expect(query.id('https://video.example/other?v=abc')).toBeNull();
  expect(query.url('abc')).toBe('https://video.example/watch?v=abc');
  for (const template of ['https://shelf.example/a/', 'https://{id}.example/', 'https://shelf.example/a#{id}', 'https://Shelf.example/a/{id}', 'http://shelf.example/a/{id}', 'https://shelf.example/a?v=x{id}'])
    expect(itemUrlCodec(template)).toBeNull();
  expect(definition.contentIdentity('https://shelf.example/a/alpha/')).toEqual({ siteKey: 'shelf', identityVersion: 1, itemId: 'alpha' });
  expect(definition.itemUrl('alpha')).toBe(alpha.url); expect(definition.sameResolutionTarget('https://shelf.example/a/alpha#x', 'https://shelf.example/a/alpha')).toBe(true);
  expect(definition.validateItem(alpha)).toBe(true);
  expect(definition.validateItem({ ...alpha, url: 'https://shelf.example/a/beta' })).toBe(false);
  expect(definition.validateItem({ ...alpha, identity: 'canonicalUrl' })).toBe(false);
  expect(definition.validateCollection('saved')).toBe(true); expect(definition.validateCollection('other')).toBe(false);
  // Without a template, IDs are the site's and the item URL is whatever HTTPS link the site gives.
  const loose = communitySiteDefinition({ ...shelf.manifest, itemUrl: undefined, defaultCollection: undefined, capabilities: ['observeFavorites', 'enumerateCollections', 'enumerateItems'] } as CommunityManifest);
  expect(loose.validateItem({ ...alpha, id: 'item:7 x', url: 'https://elsewhere.example/post?id=7' })).toBe(true);
  expect(loose.itemUrl('alpha')).toBeNull(); expect(loose.contentIdentity(alpha.url)).toBeNull();
  const envelope = { protocolVersion: 1 as const, requestId: 'r', leaseId: 'l', capability: 'c' };
  expect(loose.validateMessage({ ...envelope, operation: 'membership.hint', hint: { interactionId: 'i', itemId: 'alpha', added: ['a'], removed: [], code: 0 } })).toBe(false);
  expect(definition.validateMessage({ ...envelope, operation: 'membership.hint', hint: { interactionId: 'i', itemId: 'alpha', added: ['saved'], removed: [], code: 0 } })).toBe(true);
  expect(loose.validateMessage({ ...envelope, operation: 'emit', data: { type: 'catalog.upsert', collections: [{ id: 'reading', identity: 'siteId', title: 'Reading', parentId: null }] } })).toBe(true);
  expect(loose.validateMessage({ ...envelope, operation: 'emit', data: { type: 'catalog.upsert', collections: [{ id: 'reading', identity: 'siteId', title: 'Reading', parentId: 'root' }] } })).toBe(false);
  expect(loose.validateMessage({ ...envelope, operation: 'capture', data: { type: 'capture.requested', item: alpha, requestedPurpose: 'semantic' } })).toBe(false);
  expect(siteGrants(definition)).toEqual({ permissions: ['userScripts', 'webNavigation'], origins: ['https://shelf.example/*'] });
  expect(siteGrants(bilibiliDefinition).permissions).toEqual(['scripting', 'webNavigation']);
  setCommunitySites([definition]);
  expect(identityDefinition('shelf', 1)).toBe(definition); expect(resolveContentIdentity('https://shelf.example/a/alpha')).toMatchObject({ siteKey: 'shelf', itemId: 'alpha' });
  // A package that also matches a bundled site's pages cannot make that site's own items ambiguous.
  const overlap = communitySiteDefinition({ ...shelf.manifest, adapterId: 'community.videos', siteKey: 'videos', matches: ['https://www.bilibili.com/*'], itemUrl: 'https://www.bilibili.com/video/{id}' });
  setCommunitySites([definition, overlap]);
  expect(overlap.contentIdentity(video.url)).not.toBeNull(); expect(resolveContentIdentity(video.url)).toEqual(bilibiliDefinition.contentIdentity(video.url));
});

test('a Save click becomes a favorite the derived definition accepts, only after the page shows it saved', async () => {
  signIn(); document.body.innerHTML = '<article data-shelf-id="alpha"><h1>Alpha</h1><button data-shelf-save aria-pressed="false">Save</button></article>';
  const emitted: unknown[] = [], controller = new AbortController();
  const context = createPageContext({ document, signal: controller.signal, accountId: '42', routeEpoch: 0, deadlineAt: Date.now() + 10000, routeEvent: 'shelf-route', controls: false,
    emit: async data => { emitted.push(data); return { status: 'accepted', receiptId: String(emitted.length) }; },
    hint: async () => { throw Error('unexpectedHint'); }, requestCapture: async () => { throw Error('unexpectedCapture'); } });
  const cleanup = await author(sdk).start(context), button = document.querySelector('button')!;
  button.click(); expect(emitted).toEqual([]);
  button.setAttribute('aria-pressed', 'true');
  await vi.waitFor(() => expect(emitted).toHaveLength(1));
  const message = { protocolVersion: 1, requestId: 'r', leaseId: 'l', capability: 'c', operation: 'emit', data: emitted[0] } as AdapterMessage;
  expect(validAdapterMessage(message) && definition.validateMessage(message)).toBe(true);
  expect(emitted[0]).toMatchObject({ type: 'favorite.confirmed', item: alpha, memberships: { mode: 'delta', added: ['saved'], removed: [] } });
  controller.abort(); await cleanup?.();
});

test('the generated wrapper starts the host runtime with the manifest and credential, and hands it the package body', () => {
  let captured: { input: { manifest: CommunityManifest; credential: string }; author: (sdk: CommunitySdk) => SiteAdapter } | undefined;
  const world: Record<string, unknown> = { __knownCommunityAdapter: (input: never, body: never) => { captured = { input, author: body }; } };
  new Script(communityWrapper({ manifest: shelf.manifest, credential: 'world-credential', script: shelf.script })).runInNewContext(world);
  expect(world.__knownCommunityAdapter).toBeUndefined(); // The package body cannot restart the runtime with another manifest.
  expect(captured!.input).toEqual({ manifest: shelf.manifest, credential: 'world-credential' });
  const adapter = captured!.author(sdk);
  expect(typeof adapter.detectSource).toBe('function'); expect(typeof adapter.readItemsPage).toBe('function'); expect(adapter.importResume).toBe('restartAndDeduplicate');
});

async function fixture() {
  const local = new MemoryStorageArea(), session = new MemoryStorageArea(), scripts = new Map<string, chrome.userScripts.Script>(), worlds = new Map<string, { worldId: string; csp?: string; messaging: boolean }>();
  let version = '0.1.2';
  vi.stubGlobal('navigator', { userAgent: 'Chrome/149.0.7827.0' });
  const userScripts = {
    getScripts: vi.fn(async (filter?: { ids: string[] }) => [...scripts.values()].filter(s => !filter || filter.ids.includes(s.id)).map(v => structuredClone(v))),
    register: vi.fn(async (values: chrome.userScripts.Script[]) => { for (const value of values) { if (scripts.has(value.id)) throw Error('duplicate'); scripts.set(value.id, structuredClone(value)); } }),
    unregister: vi.fn(async (filter: { ids: string[] }) => { for (const id of filter.ids) scripts.delete(id); }),
    configureWorld: vi.fn(async (value: { worldId: string; csp?: string; messaging: boolean }) => { worlds.set(value.worldId, value); }),
    resetWorldConfiguration: vi.fn(async (id: string) => { worlds.delete(id); }), getWorldConfigurations: async () => [...worlds.values()],
    execute: vi.fn(async () => []),
  };
  vi.stubGlobal('chrome', { storage: { local, session }, runtime: { id: 'extension', getManifest: () => ({ version }) }, permissions: { contains: async () => true }, userScripts });
  const changed = vi.fn(async () => {});
  const runtime = createCommunityRuntime({ ready: async () => {}, changed });
  const call = (r: unknown): Promise<any> => runtime.management(r);
  const install = async (text = shelfText) => { const preview = await call({ kind: 'known.community.preview', text });
    return call({ kind: 'known.community.install', digest: preview.preview.digest, acknowledgeRisk: true }); };
  const rows = () => communityStore.read();
  return { local, scripts, worlds, userScripts, runtime, call, install, rows, changed, upgrade: (next: string) => { version = next; } };
}
const version = (v: string, text = shelfText) => withManifest({ version: v }, text);

test('installing, updating, rolling back and removing a package each give the worker a new set of sites', async () => {
  const f = await fixture();
  expect((await f.install()).installations).toEqual([expect.objectContaining({ manifest: shelf.manifest, error: null })]);
  const first = (await f.rows())[0]!; expect(first.generation).toBe(1); expect(f.changed).toHaveBeenCalledTimes(1);
  expect(installedSites(await f.rows()).map(s => s.definition.adapterId)).toEqual(['community.shelf']);
  await f.install(version('1.0.1'));
  const updated = (await f.rows())[0]!;
  expect(updated).toMatchObject({ id: first.id, generation: 2, previous: [expect.objectContaining({ digest: first.approved.digest })] });
  expect(updated.credential).not.toBe(first.credential);
  await expect(f.install(version('1.0.1', shelfText.replace('Shelf fixture', 'Changed')))).rejects.toThrow('communityVersionConflict');
  // One site identity per installed package: a second package cannot take over Shelf's namespace.
  await expect(f.call({ kind: 'known.community.preview', text: withManifest({ adapterId: 'community.shelf2' }) })).rejects.toThrow('communitySiteKeyTaken');
  const review = await f.call({ kind: 'known.community.reviewVersion', installationId: first.id, digest: first.approved.digest });
  await f.call({ kind: 'known.community.rollback', installationId: first.id, digest: review.preview.digest, acknowledgeRisk: true });
  expect((await f.rows())[0]).toMatchObject({ generation: 3, approved: { digest: first.approved.digest } });
  // Rolling back cannot take back a site identity another package has meanwhile installed with.
  await f.install(withManifest({ version: '1.1.0', siteKey: 'bar' }));
  await f.install(withManifest({ adapterId: 'community.shelf2', version: '1.0.0' }));
  await expect(f.call({ kind: 'known.community.reviewVersion', installationId: first.id, digest: first.approved.digest })).rejects.toThrow('communitySiteKeyTaken');
  await f.call({ kind: 'known.community.remove', installationId: (await f.rows())[1]!.id });
  await f.call({ kind: 'known.community.remove', installationId: first.id });
  expect(await f.rows()).toEqual([]); expect(f.changed).toHaveBeenCalledTimes(7);
});

test('a hint-only package from the earlier format stays listed but runs nowhere until it is updated', async () => {
  const f = await fixture(), legacy = JSON.stringify({ manifest: { apiVersion: 'known.site-adapter/v1', adapterId: 'community.hints', version: '1.0.0', siteKey: 'bilibili', identityVersion: 1,
    matches: ['https://www.bilibili.com/*'], execution: { mode: 'userScript', entry: 'adapter.js', runAt: 'document_start' }, capabilities: ['observeFavorites'] },
  provenance: { maintainer: 'Old author', sourceUrl: 'https://example.test/source', revision: 'local' }, script: 'return () => {};' });
  await f.local.set({ [COMMUNITY_STATE]: { version: 1, installations: [{ id: 'old', generation: 4, credential: 'c', hostVersion: '0.1.2', enabled: true,
    approved: { digest: 'sha256:legacy', text: legacy, package: JSON.parse(legacy), bytes: legacy.length }, previous: [], archive: null, leases: [], routes: {},
    rate: { at: 0, count: 0 }, lastReport: null, error: null }] } });
  expect(await f.rows()).toEqual([expect.not.objectContaining({ enabled: expect.anything() })]);
  expect(installedSites(await f.rows())).toEqual([]);
  expect((await f.call({ kind: 'known.community.status' })).installations).toEqual([expect.objectContaining({ id: 'old', error: 'communityPackageOutdated' })]);
});

test('each generation registers the host runtime and the reviewed body in its own world; extension updates rotate it', async () => {
  const f = await fixture(); await f.install(withManifest({ connectOrigins: ['https://api.shelf.example'] }));
  const row = (await f.rows())[0]!, registration = communityRegistration(row);
  expect(registration).toMatchObject({ id: `colp-user-${row.id}`, world: 'USER_SCRIPT', worldId: communityWorldId(row), matches: ['https://shelf.example/*'], runAt: 'document_start', allFrames: false });
  expect(registration.js![0]).toEqual({ file: 'site-adapter-community.js' });
  expect((registration.js![1] as { code: string }).code).toContain(JSON.stringify(row.credential));
  await communityWorld.register(row); await communityWorld.register(row);
  expect(f.userScripts.register).toHaveBeenCalledTimes(1); expect(communityRegistrationMatches(row, [...f.scripts.values()])).toBe(true);
  expect(f.worlds.get(communityWorldId(row))).toMatchObject({ messaging: true, csp: "script-src 'self'; object-src 'none'; connect-src 'self' https://shelf.example https://api.shelf.example" });
  f.upgrade('0.1.3'); const [rotated] = await f.runtime.prepare();
  expect(rotated).toMatchObject({ generation: row.generation + 1, hostVersion: '0.1.3' }); expect(rotated!.credential).not.toBe(row.credential);
  expect(communityRegistrationMatches(rotated!, [...f.scripts.values()])).toBe(false);
  await communityWorld.register(rotated!); await f.runtime.prune([rotated!]);
  expect([...f.scripts.values()].map(s => s.worldId)).toEqual([communityWorldId(rotated!)]); expect([...f.worlds.keys()]).toEqual([communityWorldId(rotated!)]);
  await communityWorld.unregister(rotated!); expect(f.scripts.size).toBe(0); expect(f.worlds.size).toBe(0);
});
