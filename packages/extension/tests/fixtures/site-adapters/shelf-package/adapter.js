// The body of a function that receives `sdk` and returns the adapter: the same contract as a bundled
// adapter (docs/site-adapters/adding-a-site.md), with the host helpers on `sdk` instead of imports.
const ORIGIN = 'https://shelf.example', SAVED = 'saved', PAGE = 50;
const { readPolicy: policy, fail, abortableSleep, siteDisplayTitle } = sdk;
const slug = value => typeof value === 'string' && /^[a-z0-9]{1,64}$/u.test(value) ? value : null;
const validAccount = id => typeof id === 'string' && /^[1-9]\d{0,19}$/u.test(id);
// The manifest's itemUrl is https://shelf.example/a/{id}, so an item's ID is its slug and its URL is fixed by it.
function article(value, title) {
  const s = slug(value); return s && title ? { id: s, identity: 'siteId', kind: 'article', url: `${ORIGIN}/a/${s}`, title } : null;
}
let nextAt = 0;
/** One paced same-origin GET. HTTP failures stay visible; they never read as an empty list. */
async function getJson(path, ctx) {
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
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > policy.responseBytes) fail('capacity');
  try { return JSON.parse(text); } catch { return fail('invalidData'); }
}
return {
  async detectSource({ document, signal }) {
    if (document.readyState === 'loading') await new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }); signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const meta = document.querySelector('meta[name="shelf:user"]');
    if (!meta) return { state: 'unknown' }; // Not rendered: proves neither a sign-out nor an account switch.
    return validAccount(meta.content) ? { state: 'signedIn', accountId: meta.content } : { state: 'signedOut' };
  },
  async start(context) {
    return context.dom.on(context.document, 'click', 'article[data-shelf-id] [data-shelf-save]', button => {
      if (button.getAttribute('aria-pressed') === 'true') return; // Un-saving never deletes a bookmark.
      const node = button.closest('article[data-shelf-id]');
      const item = article(node.dataset.shelfId, siteDisplayTitle(node.querySelector('h1')?.textContent));
      if (!item) return;
      const interactionId = crypto.randomUUID(); // Fixed before any await, per the favorite.confirmed contract.
      void (async () => {
        const saved = await context.dom.waitFor(() => button.getAttribute('aria-pressed') === 'true' || null,
          { timeoutMs: 5000, signal: context.signal }).then(() => true, () => false);
        if (context.signal.aborted) return;
        if (!saved) { await context.emit({ type: 'favorite.uncertain', interactionId, itemId: item.id, reason: 'timeout' }); return; }
        await context.emit({ type: 'favorite.confirmed', interactionId, item, memberships: { mode: 'delta', added: [SAVED], removed: [] },
          confirmation: { kind: 'settledDom', detector: 'shelf.savePressed' } });
      })().catch(() => undefined);
    });
  },
  async readItemsPage(ctx, collectionId, cursor) {
    if (collectionId !== SAVED) fail('invalidData');
    const body = await getJson(`/api/saved?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ctx);
    const { items, next } = body && typeof body === 'object' ? body : {};
    if (!Array.isArray(items) || items.length > PAGE || !(next === null || typeof next === 'string' && next.length > 0 && next.length <= 512)) fail('invalidData');
    const rows = []; let skipped = false;
    for (const raw of items) {
      const item = article(raw?.slug, siteDisplayTitle(raw?.title));
      if (!item) skipped = true; else if (!rows.some(row => row.item.id === item.id)) rows.push({ item });
    }
    // A skipped row makes this page partial, so nothing can treat the list as complete.
    return { items: rows, nextCursor: next, coverage: skipped ? 'partial' : 'complete', consistency: 'bestEffort' };
  },
  importResume: 'restartAndDeduplicate',
};
