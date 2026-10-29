import { abortableSleep, fail } from '../../../../src/site-adapters/read-errors.js';
import { siteDisplayTitle } from '../../../../src/site-adapters/title.js';
import type { AdapterServices, CollectionItem, SiteAdapter, SourcePage } from '../../../../src/site-adapters/contracts.js';
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
