import type { AdapterMessage, SiteCollection, SiteItem, SiteObservation } from '../../../../src/site-adapters/contracts.js';
import type { SiteDefinition } from '../../../../src/site-adapters/registry-types.js';
// The worked example in docs/site-adapters/adding-a-site.md, kept compiling here; not a registered site.
// Change both together. Only the host import paths differ from the guide.
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
