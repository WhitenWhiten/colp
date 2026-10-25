import type { AdapterMessage, SiteAdapter, SiteCollection, SiteItem, SourcePage } from '../../../src/site-adapters/contracts.js';
import type { SiteDefinition } from '../../../src/site-adapters/registry-types.js';
export const post: SiteItem = { id: 'post:alpha', identity: 'siteId', kind: 'post', url: 'https://posts.example/posts/alpha', title: 'Alpha' };
export const saved: SiteCollection = { id: 'list:saved', identity: 'siteId', title: 'Saved', parentId: null };
const item = (value: SiteItem) => /^post:[a-z]+$/.test(value.id) && value.kind === 'post' && value.url === `https://posts.example/posts/${value.id.slice(5)}`;
const collection = (id: unknown) => typeof id === 'string' && /^list:[a-z]+$/.test(id);
function message(m: AdapterMessage): boolean {
  if (m.operation === 'emit') {
    const o = m.data;
    if (o.type === 'catalog.upsert') return (!o.items || o.items.every(item)) && (!o.collections || o.collections.every(c => collection(c.id)));
    if (o.type === 'favorite.uncertain') return /^post:[a-z]+$/.test(o.itemId);
    return item(o.item) && (o.memberships.mode === 'delta' ? [...o.memberships.added, ...o.memberships.removed] : o.memberships.collectionIds).every(collection);
  }
  if (m.operation === 'page.result' && m.result.status === 'ok') return m.result.kind === 'collections' ? m.result.page.items.every(c => collection(c.id)) : collection(m.result.collectionId) && m.result.page.items.every(i => item(i.item));
  if (m.operation === 'item.result' && m.result.status === 'resolved') return item(m.result.item);
  return true;
}
/** A test-only DOM/post adapter, not another Bilibili metadata version or a real-site capability claim. */
export const postsDefinition: SiteDefinition = {
  adapterId: 'fixture.posts', version: '1.0.0', siteKey: 'posts', identityVersion: 1, label: 'Posts', origin: 'https://posts.example', matches: ['https://posts.example/*'],
  capabilities: ['observeFavorites', 'resolveItem', 'readMemberships', 'enumerateCollections', 'enumerateItems'], negativeReadback: true,
  importResume: 'stableCursor', scripts: { adapter: 'fixture-posts.js' }, validateAccount: id => typeof id === 'string' && /^acct:[a-z]+$/.test(id),
  validateCollection: collection, validateItem: item, validateMessage: message,
  contentIdentity: url => url === post.url ? { siteKey: 'posts', identityVersion: 1, itemId: post.id } : null,
  itemUrl: id => /^post:[a-z]+$/.test(id) ? `https://posts.example/posts/${id.slice(5)}` : null, sameResolutionTarget: (a, b) => a === b,
};
export function createPostsAdapter(page: SourcePage<SiteCollection> = { items: [saved], nextCursor: null, coverage: 'complete', consistency: 'bestEffort' }): SiteAdapter {
  return {
    detectSource: async () => ({ state: 'signedIn', accountId: 'acct:reader' }),
    async start(ctx) { return ctx.dom.on(ctx.document, 'click', '[data-favorite]', () => { void ctx.emit({ type: 'favorite.confirmed', interactionId: crypto.randomUUID(), item: post,
      memberships: { mode: 'delta', added: [saved.id], removed: [] }, confirmation: { kind: 'settledDom', detector: 'fixture-button' } }); }); },
    resolveItem: async () => ({ status: 'resolved', item: post }),
    readMemberships: async (_, query) => ({ status: 'ok', itemId: query.itemId, edges: query.collectionIds.map(collectionId => ({ collectionId, state: 'absent', evidence: { kind: 'refreshedDom', detector: 'fixture-membership' } })) }),
    readCollectionsPage: async () => page,
    readItemsPage: async (_, _collection, cursor) => ({ items: cursor ? [] : [{ item: post }], nextCursor: cursor ? null : 'stable:next', coverage: 'complete', consistency: 'bestEffort' }),
    importResume: 'stableCursor',
  };
}
