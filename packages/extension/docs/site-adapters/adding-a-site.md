# Adding a website to the site adapter

[English](adding-a-site.md) | [简体中文](adding-a-site.zh-CN.md) | [日本語](adding-a-site.ja.md)

This guide is written for coding agents and for the people who review their work. It covers adding one more website to the extension so that what a person saves on that site becomes browser bookmarks. Work through it from top to bottom. The worked example (a made-up site called **Shelf**) was built, unit-tested, bundled, run in Chromium under xvfb and passed the production release verifier on 2026-10-28. A copy lives in [`tests/fixtures/site-adapters/shelf/`](../../tests/fixtures/site-adapters/shelf), and [`tests/site-adapter-shelf-example.test.ts`](../../tests/site-adapter-shelf-example.test.ts) keeps it passing as the contracts change. Only the host import paths differ from the code below.

All paths are relative to `packages/extension/`.

## Handing this task to an agent

Fill in the angle brackets and paste:

```text
Add a bundled site adapter for <site name> (<https://exact.origin>) in packages/extension.
Follow docs/site-adapters/adding-a-site.md from top to bottom.
Site facts: <the answers to "Facts to collect", or "collect them and show me before writing code">.
Wanted: <live saving | importing the saved list | both>.
Use sanitized fixtures only; do not sign in to or test against the real site.
Finish with the "Final report" checklist from the guide.
```

## What an adapter does, and what it must not do

An adapter is page code for one site. It does three things, and the last two are optional:

1. `detectSource`: says which account is signed in on the page.
2. `start`: watches the page and reports what the person saved, through `context.emit`.
3. `readItemsPage` (and related readers): when the host asks, reads a saved list one bounded page at a time.

The host owns everything else: permissions, content-script registration, document leases, the account check before and after every read, pacing, deadlines, retries, the durable ledger, folder layout, native bookmark writes, Sync and the Settings page. Adding a site needs **no** manifest change. `optional_host_permissions` already covers HTTPS sites, and the worker registers the content script for `matches` once the person turns the site on in Settings → Site adapters.

## Facts to collect before writing code

Find each answer in the page source or the network panel, using fixtures or an authorized test account. If you cannot answer one, stop and ask. Do not guess.

| # | Question | Used by |
| --- | --- | --- |
| 1 | The exact HTTPS origin, and the paths the adapter should run on | `origin`, `matches` |
| 2 | Where the page shows the signed-in account ID, and how it looks when signed out | `detectSource`, `validateAccount` |
| 3 | The item's stable site ID and canonical URL. Is that ID the same item for every viewer? | the identity codec, `contentIdentity`, `itemUrl`, `contentIdScope` |
| 4 | How collections work: one list, several flat lists, or nested folders | `defaultCollection` or `enumerateCollections`. Nested folders are not supported. |
| 5 | What the page shows once a save has really succeeded | `start` (settled-DOM evidence) |
| 6 | The list endpoint: URL, page size, cursor, error shapes, and what rate limits and challenges look like | `readItemsPage`, failure mapping |

## Rules

**Must**

- Build every ID from site data: site IDs and canonical URLs. Titles are for display only, so pass them through `siteDisplayTitle`.
- Produce one canonical `SiteItem` shape, and make `validateItem` accept only that shape. Compare URLs exactly.
- Make `validateMessage` accept exactly the messages your capabilities produce, including `failed` page results, and return `false` for everything else.
- Use the `document`, `signal` and `deadlineAt` the host passes in, and stop when the signal aborts. Add listeners through `context.dom.*` so they are removed when the lease ends.
- Capture `interactionId` before the first `await`.
- Emit `favorite.confirmed` only after the page shows the saved state.
- Pace and bound every request with `services.readPolicy`, and report HTTP problems with `fail(code)`.
- Mark a page `coverage: 'partial'` if you skipped anything on it.
- Declare only capabilities you have implemented and tested.

**Must not**

- Write bookmarks, call `chrome.*`, or import the worker, bookmark, Sync or classification code.
- Turn a failed or partial read, a sign-out, a challenge or a rate limit into an empty list.
- Return `signedOut` when the page simply has not rendered yet. Return `unknown`.
- Emit from the body of `start()`. The host calls `start` again on every lease renewal (about once a minute per tab) and on every route change.
- Report un-saving as a deletion. The host never deletes a bookmark because the site removed it, so ignore it.
- Deduplicate by title or URL, or change `siteKey` or `identityVersion` to fix a label.
- Send cookies, tokens or request bodies anywhere.
- Edit `scripts/build.mjs`, `src/site-adapters/worker.ts`, `manifest.base.json` or the Settings code for a new site. If one of them seems to need a change, stop and report it, because that is a host change.

## Step 1: Choose capabilities

| You want | Declare | Implement | Definition |
| --- | --- | --- | --- |
| Live saving: pressing the site's Save creates a bookmark | `observeFavorites` | `start` | — |
| Importing one saved list | `enumerateItems` | `readItemsPage` | `defaultCollection` |
| Importing several flat lists | `enumerateCollections`, `enumerateItems` | `readCollectionsPage`, `readItemsPage` | no `defaultCollection` |

Start with the smallest set that does the job. `defaultCollection` requires `enumerateItems` and rules out `enumerateCollections`. With neither, the person can only pick collections the adapter has announced through `catalog.upsert` during the current source session. Nested collections, repeated entries, injected capture buttons (`mountCaptureControl`) and named host read recipes are not available, and registry validation rejects them. Hint-confirmed favorites (`resolveItem` plus `readMemberships`) are covered under "Going further".

## Step 2: Files

| Action | Path | Contents |
| --- | --- | --- |
| Create | `src/site-adapters/<site>/definition.ts` | the audited `SiteDefinition` and the identity codec |
| Create | `src/site-adapters/<site>/adapter.ts` | the `SiteAdapterFactory` |
| Create | `src/site-adapters/<site>/content.ts` | the page entry (four lines) |
| Edit | `src/site-adapters/registry.ts` | add the definition to `bundledSites` |
| Edit | `tests/site-adapter-build.test.ts` | it pins the registered sites and bundle names |
| Create | `tests/site-adapter-<site>.test.ts` | qualification and site-specific cases |
| Create | `e2e/mv3-site-adapter-<site>.spec.ts` | a browser check against a routed fake site |
| Edit | `CHANGELOG.md` | an `Added` entry under `[Unreleased]` |

## Step 3: The worked example, Shelf

Shelf is fictional (`.example` is a reserved domain). The adapter assumes the site behaves like this:

- Article pages live at `https://shelf.example/a/<slug>`, where the slug matches `[a-z0-9]{1,64}`.
- Every page has `<meta name="shelf:user" content="<decimal id>">`. The content is empty when nobody is signed in.
- An article is rendered as `<article data-shelf-id="<slug>"><h1>Title</h1><button data-shelf-save aria-pressed="false">Save</button></article>`. The site sets `aria-pressed="true"` once a save has succeeded.
- Each account has one list, called Saved. `GET /api/saved?limit=50&cursor=<c>` returns `{ "items": [{ "slug": "…", "title": "…" }], "next": "<cursor>" | null }`. It answers 401 or 403 when signed out and 429 when rate-limited.

It declares live saving and importing the one list.

### `src/site-adapters/shelf/definition.ts`

```ts
import type { AdapterMessage, SiteCollection, SiteItem, SiteObservation } from '../contracts.js';
import type { SiteDefinition } from '../registry-types.js';
export const ORIGIN = 'https://shelf.example';
/** Shelf keeps one reading list per account. Its ID comes from the site, never from a title. */
export const SAVED: SiteCollection = { id: 'saved', identity: 'siteId', title: 'Saved', parentId: null };
const slug = (value: unknown) => typeof value === 'string' && /^[a-z0-9]{1,64}$/u.test(value) ? value : null;
export const validAccount = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,19}$/u.test(id);
const articleId = (s: string) => `article:${s}`, articleUrl = (s: string) => `${ORIGIN}/a/${s}`;
const slugFromId = (id: string) => id.startsWith('article:') ? slug(id.slice(8)) : null;
function slugFromUrl(value: string): string | null {
  try { const u = new URL(value); return u.origin === ORIGIN && !u.username && !u.password ? slug(/^\/a\/([^/]+)\/?$/u.exec(u.pathname)?.[1]) : null; }
  catch { return null; }
}
/** The one canonical item shape. Validation accepts nothing else. */
export function article(s: unknown, title: string | null): SiteItem | null {
  const value = slug(s); return value && title ? { id: articleId(value), identity: 'siteId', kind: 'article', url: articleUrl(value), title } : null;
}
const validItem = (item: SiteItem) => { const s = slugFromId(item.id); return !!s && item.identity === 'siteId' && item.kind === 'article' && item.url === articleUrl(s); };
const validCollection = (id: unknown) => id === SAVED.id;
function validObservation(o: SiteObservation): boolean {
  if (o.type === 'catalog.upsert') return !o.items && !!o.collections?.every(c => validCollection(c.id) && c.parentId === null);
  if (o.type === 'favorite.uncertain') return !!slugFromId(o.itemId);
  const ids = o.memberships.mode === 'delta' ? [...o.memberships.added, ...o.memberships.removed] : o.memberships.collectionIds;
  return validItem(o.item) && ids.every(validCollection);
}
/** Semantic checks on top of the closed v1 schema, for exactly the messages these capabilities produce. */
function validMessage(m: AdapterMessage): boolean {
  if (m.operation === 'connect') return true;
  if (m.operation === 'emit') return validObservation(m.data);
  if (m.operation === 'page.result') return m.result.status === 'failed'
    || m.result.kind === 'items' && validCollection(m.result.collectionId) && m.result.page.items.every(row => validItem(row.item));
  return false;
}
export const shelfDefinition: SiteDefinition = Object.freeze<SiteDefinition>({
  adapterId: 'bundled.shelf', version: '1.0.0', siteKey: 'shelf', identityVersion: 1, label: 'Shelf',
  origin: ORIGIN, matches: [`${ORIGIN}/*`],
  capabilities: ['observeFavorites', 'enumerateItems'], defaultCollection: SAVED,
  collectionHierarchy: 'flat', membershipModel: 'set', collectionSnapshot: 'positiveOnly',
  readScope: 'document', contentIdScope: 'site', negativeReadback: false, importResume: 'restartAndDeduplicate',
  scripts: { adapter: 'site-adapter-shelf.js' }, build: { adapter: 'site-adapters/shelf/content.ts' },
  validateAccount: validAccount, validateCollection: validCollection, validateItem: validItem, validateMessage: validMessage,
  contentIdentity(url) { const s = slugFromUrl(url); return s ? { siteKey: 'shelf', identityVersion: 1, itemId: articleId(s) } : null; },
  itemUrl(id) { const s = slugFromId(id); return s ? articleUrl(s) : null; },
  sameResolutionTarget: (a, b) => { const s = slugFromUrl(a); return !!s && s === slugFromUrl(b); },
});
```

### `src/site-adapters/shelf/adapter.ts`

```ts
import { abortableSleep, fail } from '../read-errors.js';
import { siteDisplayTitle } from '../title.js';
import type { AdapterServices, CollectionItem, SiteAdapter, SourcePage } from '../contracts.js';
import { ORIGIN, SAVED, article, validAccount } from './definition.js';
const PAGE = 50;
/** Site extraction only. Leases, account fences, command retries and cleanup belong to page-runtime.ts. */
export function createShelfAdapter(services: AdapterServices): SiteAdapter {
  const policy = services.readPolicy;
  let nextAt = 0;
  /** One paced same-origin GET. HTTP failures stay visible; they never read as an empty list. */
  async function getJson(path: string, ctx: { signal: AbortSignal; deadlineAt: number }): Promise<unknown> {
    const wait = Math.max(0, nextAt - Date.now());
    if (Date.now() + wait >= ctx.deadlineAt) fail('timeout');
    if (wait) await abortableSleep(wait, ctx.signal);
    nextAt = Date.now() + policy.requestSpacingMs;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Math.min(policy.requestMs, ctx.deadlineAt - Date.now())))]);
    const response = await fetch(`${ORIGIN}${path}`, { credentials: 'include', redirect: 'error', signal })
      .catch(() => fail(ctx.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : 'network'));
    if (response.status === 401 || response.status === 403) fail('signedOut', undefined, { httpStatus: response.status });
    if (response.status === 429) fail('rateLimited', policy.backoffMs, { httpStatus: 429 });
    if (!response.ok) fail(response.status >= 500 ? 'network' : 'invalidData', undefined, { httpStatus: response.status });
    // Checked after download; stream with a running count (bilibili/http.ts boundedJson) when responses can be large.
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > policy.responseBytes) fail('capacity');
    try { return JSON.parse(text); } catch { return fail('invalidData'); }
  }
  return {
    async detectSource({ document, signal }) {
      if (document.readyState === 'loading') await new Promise<void>(resolve => {
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }); signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const meta = document.querySelector<HTMLMetaElement>('meta[name="shelf:user"]');
      if (!meta) return { state: 'unknown' }; // Not rendered: proves neither a sign-out nor an account switch.
      return validAccount(meta.content) ? { state: 'signedIn', accountId: meta.content } : { state: 'signedOut' };
    },
    async start(context) {
      return context.dom.on(context.document, 'click', 'article[data-shelf-id] [data-shelf-save]', button => {
        if (button.getAttribute('aria-pressed') === 'true') return; // Un-saving never deletes a bookmark.
        const node = button.closest<HTMLElement>('article[data-shelf-id]')!;
        const item = article(node.dataset.shelfId, siteDisplayTitle(node.querySelector('h1')?.textContent));
        if (!item) return;
        const interactionId = crypto.randomUUID(); // Fixed before any await, per the favorite.confirmed contract.
        void (async () => {
          const saved = await context.dom.waitFor(() => button.getAttribute('aria-pressed') === 'true' || null,
            { timeoutMs: 5000, signal: context.signal }).then(() => true, () => false);
          if (context.signal.aborted) return;
          if (!saved) { await context.emit({ type: 'favorite.uncertain', interactionId, itemId: item.id, reason: 'timeout' }); return; }
          await context.emit({ type: 'favorite.confirmed', interactionId, item, memberships: { mode: 'delta', added: [SAVED.id], removed: [] },
            confirmation: { kind: 'settledDom', detector: 'shelf.savePressed' } });
        })().catch(() => undefined);
      });
    },
    async readItemsPage(ctx, collectionId, cursor): Promise<SourcePage<CollectionItem>> {
      if (collectionId !== SAVED.id) fail('invalidData');
      const body = await getJson(`/api/saved?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ctx);
      const { items, next } = (body && typeof body === 'object' ? body : {}) as { items?: unknown; next?: unknown };
      if (!Array.isArray(items) || items.length > PAGE || !(next === null || typeof next === 'string' && next.length > 0 && next.length <= 512)) fail('invalidData');
      const rows: CollectionItem[] = []; let skipped = false;
      for (const raw of items as { slug?: unknown; title?: unknown }[]) {
        const item = article(raw?.slug, siteDisplayTitle(raw?.title));
        if (!item) skipped = true; else if (!rows.some(row => row.item.id === item.id)) rows.push({ item });
      }
      // A skipped row makes this page partial, so nothing can treat the list as complete.
      return { items: rows, nextCursor: next as string | null, coverage: skipped ? 'partial' : 'complete', consistency: 'bestEffort' };
    },
    importResume: 'restartAndDeduplicate',
  };
}
```

### `src/site-adapters/shelf/content.ts`

```ts
import { startAdapterRuntime } from '../page-runtime.js';
import { shelfDefinition } from './definition.js';
import { createShelfAdapter } from './adapter.js';
startAdapterRuntime(shelfDefinition, createShelfAdapter);
```

### Register it

```diff
 // src/site-adapters/registry.ts
 import { bilibiliDefinition } from './bilibili/definition.js';
+import { shelfDefinition } from './shelf/definition.js';
-export const bundledSites: readonly SiteDefinition[] = validateSiteDefinitions([bilibiliDefinition]);
+export const bundledSites: readonly SiteDefinition[] = validateSiteDefinitions([bilibiliDefinition, shelfDefinition]);
```

```diff
 // tests/site-adapter-build.test.ts
-  expect(sites.map(s => s.adapterId)).toEqual(['bundled.bilibili']);
-  expect(result.bundles).toEqual([{ adapterId: 'bundled.bilibili', adapter: 'site-adapter.js', probe: 'site-probe.js' }]);
-  expect(Object.keys(result.entries).sort()).toEqual(['site-adapter', 'site-probe']);
+  expect(sites.map(s => s.adapterId)).toEqual(['bundled.bilibili', 'bundled.shelf']);
+  expect(result.bundles).toEqual([{ adapterId: 'bundled.bilibili', adapter: 'site-adapter.js', probe: 'site-probe.js' }, { adapterId: 'bundled.shelf', adapter: 'site-adapter-shelf.js' }]);
+  expect(Object.keys(result.entries).sort()).toEqual(['site-adapter', 'site-adapter-shelf', 'site-probe']);
```

The build reads `scripts` and `build` from the registry and writes `site-adapter-shelf.js` along with `site-adapter-bundles.json`. The release verifier checks every bundle listed there. The Settings sidebar shows every registered site, and the Shelf page opens at `site-adapters.html?adapterId=bundled.shelf`.

### Why the less obvious lines are there

- **No `catalog.upsert`.** Planning a bookmark needs the collection fact in the ledger. With `defaultCollection` the host records it itself, on import and with the first live save that names it. A site with neither `defaultCollection` nor `enumerateCollections` must announce the collections it sees with `catalog.upsert`, from an event handler rather than the body of `start`. Otherwise its live saves settle as `sourceFactsUnresolved`.
- **`detectSource` waits for `DOMContentLoaded` and returns `unknown` when the meta tag is missing.** The script runs at `document_start`. A `signedOut` claim fences the connection, while `unknown` only means "try again".
- **No emit in the body of `start`.** `start` runs on every lease renewal, so an emit there would add a ledger row about once a minute per tab.
- **`importResume`** is declared on both the definition and the adapter, and the two must match. `stableCursor` is allowed only when the same cursor always returns the same page.
- **`contentIdScope: 'site'`**, because a Shelf article ID means the same article for every account. Leave it out for private or account-local IDs, so the host adds the account to the content identity.
- **Host limits**: at most 100 entries per page, cursors of at most 512 characters, IDs of at most 128 characters, titles of at most 512 UTF-16 units, 512 KiB per page result, and 256 KiB per observation. Fail with `capacity` or `invalidData` rather than truncating.

## Step 4: Tests

`qualifySiteAdapter` checks the definition against registry validation, checks that declared capabilities match implemented methods, round-trips identity, and runs every declared reader through the closed wire schemas, including continuation replay. Add site-specific cases next to it.

```ts
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { qualifySiteAdapter } from './fixtures/site-adapters/qualification.js';
import { createPageContext } from '../src/site-adapters/page-context.js';
import { readLimits } from '../src/site-adapters/read-policy.js';
import { shelfDefinition, SAVED, article } from '../src/site-adapters/shelf/definition.js';
import { createShelfAdapter } from '../src/site-adapters/shelf/adapter.js';
const item = article('alpha', 'Alpha')!;
const services = { readPolicy: readLimits({ readPolicy: { spacingMs: 1, requestSpacingMs: 1 } }) };
const signIn = () => { document.head.innerHTML = '<meta name="shelf:user" content="42">'; };
afterEach(() => { vi.unstubAllGlobals(); document.head.replaceChildren(); document.body.replaceChildren(); });
qualifySiteAdapter({ definition: shelfDefinition, accountId: '42', item, collection: SAVED, setup() {
  signIn(); vi.stubGlobal('fetch', async () => Response.json({ items: [{ slug: 'alpha', title: 'Alpha' }], next: null }));
  return createShelfAdapter(services);
} });
test('a Save click is reported only after the page shows it saved', async () => {
  signIn(); document.body.innerHTML = '<article data-shelf-id="alpha"><h1>Alpha</h1><button data-shelf-save aria-pressed="false">Save</button></article>';
  const emitted: unknown[] = [], controller = new AbortController();
  const context = createPageContext({ document, signal: controller.signal, accountId: '42', routeEpoch: 0, deadlineAt: Date.now() + 10000, routeEvent: 'shelf-route', controls: false,
    emit: async data => { emitted.push(data); return { status: 'accepted', receiptId: String(emitted.length) }; },
    hint: async () => { throw Error('unexpectedHint'); }, requestCapture: async () => { throw Error('unexpectedCapture'); } });
  const cleanup = await createShelfAdapter(services).start(context);
  const button = document.querySelector('button')!;
  button.click(); expect(emitted).toEqual([]);
  button.setAttribute('aria-pressed', 'true');
  await vi.waitFor(() => expect(emitted).toHaveLength(1));
  expect(emitted).toEqual([expect.objectContaining({ type: 'favorite.confirmed', item, memberships: { mode: 'delta', added: [SAVED.id], removed: [] } })]);
  controller.abort(); await cleanup?.();
});
test('an expired session fails visibly instead of reading as an empty list', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
  const context = { accountId: '42', document, signal: new AbortController().signal, deadlineAt: Date.now() + 5000, readSessionId: 'session' };
  await expect(createShelfAdapter(services).readItemsPage!(context, SAVED.id, null)).rejects.toMatchObject({ failure: { code: 'signedOut' } });
});
```

Also cover the following for your site, using sanitized fixtures from its real responses:

- a second page reached through the cursor, and a cursor that has gone stale (`staleCursor`)
- malformed rows (giving `coverage: 'partial'`) and duplicate rows
- sign-out partway through a read, a rate limit (`rateLimited` with `retryAfterMs`), and a challenge page (`challenge`)
- a click that un-saves, which must emit nothing, and a save that never settles, which must emit `favorite.uncertain`
- the exact page markup or response the observation depends on

## Step 5: Verify

Run these from `packages/extension`, and run only what the change touches. Run `npm run test:site-adapters` only if you changed shared host code. Browser tests must run under xvfb.

```sh
npx vitest run tests/site-adapter-<site>.test.ts tests/site-adapter-build.test.ts tests/site-adapter-qualification.test.ts
npm run typecheck
npx eslint src/site-adapters/<site> src/site-adapters/registry.ts tests/site-adapter-<site>.test.ts tests/site-adapter-build.test.ts e2e/mv3-site-adapter-<site>.spec.ts
npm run build:development
KNOWN_E2E_HEADED=0 node scripts/with-xvfb.mjs npx playwright test --project=core e2e/mv3-site-adapter-<site>.spec.ts
npm run build && node scripts/verify-release-artifact.mjs dist/production
```

### Browser check

The spec serves the fake site with `context.route` and grants permissions through the shared X11 helper. It turns the site on, confirms the account, maps the list to a folder, presses Save, and waits for the native bookmark. The import preview then has to reuse that bookmark rather than create a second one.

```ts
import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', extensionPath = resolve(import.meta.dirname, '../dist/development');
const page = `<!doctype html><meta name="shelf:user" content="42"><title>Alpha</title>
<article data-shelf-id="alpha"><h1>Alpha</h1><button data-shelf-save aria-pressed="false">Save</button></article>
<script>document.querySelector('button').onclick = e => setTimeout(() => e.target.setAttribute('aria-pressed', 'true'), 200);</script>`;
test('Shelf saves a live favorite natively and previews an import without duplicating it', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'site-shelf-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    await context.route('https://shelf.example/a/**', r => r.fulfill({ contentType: 'text/html', body: page }));
    await context.route('https://shelf.example/api/saved*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ slug: 'alpha', title: 'Alpha' }, { slug: 'beta', title: 'Beta' }], next: null }) }));
    const { page: options } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://shelf.example/*'] };
    await options.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-shelf'; b.textContent = 'Grant'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(options, options.locator('#grant-shelf'), 'Shelf source', grants);
    const site = await context.newPage(); await site.goto('https://shelf.example/a/alpha');
    await options.goto(`chrome-extension://${extensionId}/site-adapters.html?adapterId=bundled.shelf#sync`);
    await options.locator('#enable').click();
    const send = (message: Record<string, unknown>) => options.evaluate(m => chrome.runtime.sendMessage({ ...m, adapterId: 'bundled.shelf' }), message) as Promise<Record<string, any>>;
    await expect.poll(async () => (await send({ kind: 'known.siteAdapters.status' })).candidateAccount, { timeout: 20000 }).toBe('42');
    await options.locator('#refresh').click(); await options.locator('#confirm').click();
    await expect.poll(async () => (await send({ kind: 'known.siteAdapters.status' })).documents, { timeout: 20000 }).toBe(1);
    const root = await options.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Shelf archive' }));
    expect(await send({ kind: 'known.siteAdapters.archive.configure', rootNativeId: root.id, collectionIds: ['saved'], live: true })).toMatchObject({ archiveResult: { configured: true }, writes: true });
    await expect.poll(() => options.evaluate(async () => {
      const state = (await chrome.storage.local.get('known.siteAdapters.runtime.v1:bundled.shelf'))['known.siteAdapters.runtime.v1:bundled.shelf'] as { leases?: { expiresAt: number }[] } | undefined;
      return state?.leases?.some(l => l.expiresAt > Date.now() + 1000) ?? false;
    }), { timeout: 20000 }).toBe(true);
    await site.locator('[data-shelf-save]').click();
    await expect.poll(() => options.evaluate(async () => (await chrome.bookmarks.search({ url: 'https://shelf.example/a/alpha' })).map(b => b.title)), { timeout: 15000 }).toEqual(['Alpha']);
    expect(await options.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(b => b.title), root.id)).toEqual(['Saved']);
    await send({ kind: 'known.siteAdapters.import.start' });
    await expect.poll(async () => (await send({ kind: 'known.siteAdapters.status' })).archive?.import?.preview?.counts, { timeout: 30000 })
      .toEqual({ createFolders: 0, createBookmarks: 1, reuseBookmarks: 1, review: 0 });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
```

## `SiteDefinition` fields

| Field | Shelf | Change it when |
| --- | --- | --- |
| `adapterId` | `bundled.shelf` | never, once shipped. It keys storage, ports and Settings. |
| `siteKey`, `identityVersion` | `shelf`, `1` | never to fix a label. A new identity version needs a reviewed migration. |
| `label`, `icon` | `Shelf`, favicon | `icon` can be a packaged asset, an audited HTTPS image or a data URL |
| `origin`, `matches` | one origin, `/*` | narrow the paths if the site has areas the adapter must not run on. HTTPS only, no wildcard hosts. |
| `connectionKind` | `account` (default) | `page` adopts the page's identity without asking the person to confirm an account |
| `capabilities`, `defaultCollection` | live saving and one list | see Step 1 |
| `readScope` | `document` | `account` only if a read from another tab of the same account is qualified |
| `contentIdScope` | `site` | omit for private or account-local IDs |
| `collectionSnapshot` | `positiveOnly` | `pointInTime` only for qualified contiguous snapshots. It lets a recheck infer removals. |
| `negativeReadback` | `false` | `true` only with `readMemberships` and fresh, scoped evidence of absence |
| `importResume` | `restartAndDeduplicate` | `stableCursor` only when cursors replay exactly |
| `readPolicy` | defaults | to adjust spacing, timeouts and attempts within the host's bounds |
| `scripts`, `build` | `site-adapter-shelf.js`, `site-adapters/shelf/content.ts` | add `probe` only for an audited MAIN-world probe |

## Mapping site conditions to failures

Throw `fail(code, retryAfterMs?, { httpStatus, sourceCode })` from `src/site-adapters/read-errors.ts`. Diagnostics carry status numbers only, never response bodies, URLs or credentials.

| Site condition | Code |
| --- | --- |
| 401 or 403, a login page, or a different account | `signedOut` |
| 429 | `rateLimited`, with `retryAfterMs` |
| a captcha or bot challenge | `challenge` |
| a 5xx response or a network error | `network` |
| out of time (the host also enforces deadlines) | `timeout` |
| `signal` aborted | `cancelled` |
| a response or row count over budget | `capacity` |
| an unexpected shape | `invalidData` |
| a cursor that is no longer valid | `staleCursor` |
| not supported for this ID or URL | `unsupported` |
| the document or tab has gone | `pageUnavailable` |

## Known host gaps (2026-10-28)

1. **Timing in unpacked builds is unreliable.** `scheduleSourceWork` (`src/site-adapters/worker.ts`) also sets the recovery alarm for the same moment. Chrome enforces the 30-second alarm minimum only for packed extensions, so in development and e2e builds that alarm can keep source work re-running about every 60 ms. That can hide a missing wake. To prove a latency claim, wait for the worker to go quiet before acting.
2. The popup's "Save as semantic" button appears only for Bilibili video URLs (`src/capture/manual-existence.ts:45`).
3. Separately installed community packages accept Bilibili identity v1 only, so a new site is bundled-only.
4. The legacy cloud archive protocol needs a server-side identity codec (`packages/server/src/modules/source-archives/site-registry.ts`). Local-first saving and Sync do not.

## Going further

- **Several lists.** Add `enumerateCollections` and `readCollectionsPage`, returning a flat `SourcePage<SiteCollection>` with `parentId: null`. Drop `defaultCollection`. `bilibili/reader.ts` shows bounded cursor buffers and page replay.
- **The site never shows a settled state.** Use the hint path instead: an audited MAIN-world probe (`scripts.probe`/`build.probe`) dispatches a page event, `start` forwards it with `deliverMembershipHint`, and the host confirms it through paced `readMemberships` and `resolveItem`. This needs all three of `observeFavorites`, `readMemberships` and `resolveItem`. See `bilibili/probe.ts`, `bilibili/adapter.ts` and `hint-delivery.ts`. The probe may send bounded IDs and codes only.
- **Large responses.** Count bytes while streaming (`boundedJson` in `bilibili/http.ts`). Move it into a shared module rather than importing from another site's directory.
- **Background reading**: [authoring.md](authoring.md) covers responsibilities and evidence, [runtime-foundation.md](runtime-foundation.md) covers identity, isolation and recovery, [reconciliation.md](reconciliation.md) covers rechecking, and the authoritative types are in `src/site-adapters/contracts.ts` and `registry-types.ts`.

## Final report

Copy this checklist into your final message and fill it in:

```text
- Facts 1–6 answered, each with its source (page, endpoint, fixture):
- Capabilities declared = methods implemented = tests written:
- validateItem / validateMessage reject everything else:
- Unit tests (files, pass counts):
- typecheck / eslint:
- Browser check under xvfb:
- Production build + verify-release-artifact:
- Files changed outside Step 2, each with a reason (expected: none):
- Real-site testing (none, or authorized test account + browser version):
- Known host gaps that affect this site:
```
