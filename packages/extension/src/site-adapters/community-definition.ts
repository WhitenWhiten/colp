import type { AdapterIcon, AdapterMessage, SiteCollection, SiteItem, SiteObservation } from './contracts.js';
import type { SiteDefinition } from './registry-types.js';
import type { SiteReadPolicy } from './read-policy.js';
import { LIMITS } from './limits.js';
/** The host-built page runtime every installed package runs on, in the package's own USER_SCRIPT world. */
export const COMMUNITY_RUNTIME_SCRIPT = 'site-adapter-community.js';
export type CommunityCapability = 'observeFavorites' | 'resolveItem' | 'readMemberships' | 'enumerateCollections' | 'enumerateItems';
/** What a package declares about its site. The host derives the whole SiteDefinition from it; no package code runs here. */
export interface CommunityManifest {
  apiVersion: 'known.site-adapter/v1';
  adapterId: string;
  version: string;
  label: string;
  siteKey: string;
  identityVersion: number;
  matches: readonly string[];
  execution: { mode: 'userScript'; entry: 'adapter.js'; runAt: 'document_start' | 'document_idle' };
  capabilities: readonly CommunityCapability[];
  icon?: AdapterIcon;
  /** One list per account, like Shelf's Saved. Requires enumerateItems; rules out enumerateCollections. */
  defaultCollection?: { id: string; title: string };
  /** One HTTPS URL with a single {id}, in the path or as one query value. Gives items a canonical URL. */
  itemUrl?: string;
  /** HTTPS origins the package's code may fetch from, besides the page's own. */
  connectOrigins?: readonly string[];
  connectionKind?: 'account' | 'page';
  readScope?: 'document' | 'account';
  contentIdScope?: 'site' | 'account';
  collectionSnapshot?: 'positiveOnly' | 'pointInTime';
  negativeReadback?: boolean;
  importResume?: 'stableCursor' | 'restartAndDeduplicate';
  readPolicy?: Partial<SiteReadPolicy>;
}
/** Item IDs inside an itemUrl stay within URL-unreserved characters, so the URL needs no encoding. */
export const URL_ID = /^(?!\.+$)[A-Za-z0-9._~-]{1,128}$/u;
const MARK = 'KNOWNITEMID';
const plainId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.id && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);
/** Parses an itemUrl template, or returns null when it is not one canonical HTTPS URL with exactly one {id}. */
export function itemUrlCodec(template: string) {
  if (template.length > 2048 || template.split('{id}').length !== 2 || template.includes(MARK)) return null;
  let sample: URL;
  try { sample = new URL(template.replace('{id}', MARK)); } catch { return null; }
  if (sample.protocol !== 'https:' || sample.username || sample.password || sample.hash || sample.host.includes(MARK) || sample.href !== template.replace('{id}', MARK)) return null;
  const [prefix, suffix] = sample.pathname.split(MARK) as [string, string?];
  const key = [...sample.searchParams].filter(([, value]) => value === MARK).map(([name]) => name);
  if (suffix === undefined && key.length !== 1) return null;
  const url = (id: string) => { const value = template.replace('{id}', id); return URL_ID.test(id) && new URL(value).href === value ? value : null; };
  function id(value: string): string | null {
    let u: URL; try { u = new URL(value); } catch { return null; }
    if (u.origin !== sample.origin || u.username || u.password) return null;
    let found: string | null = null;
    if (suffix !== undefined) {
      const path = !suffix && u.pathname.endsWith('/') && u.pathname.length > prefix.length + 1 ? u.pathname.slice(0, -1) : u.pathname;
      if (path.startsWith(prefix) && path.endsWith(suffix)) found = path.slice(prefix.length, path.length - suffix.length);
    } else if (u.pathname === sample.pathname) found = u.searchParams.get(key[0]!);
    return found && URL_ID.test(found) ? found : null;
  }
  return { url, id };
}
/** The SiteDefinition of an installed package. Validators are generic and host-authored; the manifest only parameterizes them. */
export function communitySiteDefinition(m: CommunityManifest): SiteDefinition {
  const codec = m.itemUrl ? itemUrlCodec(m.itemUrl) : null;
  // An item page is claimed only on the package's own sites.
  if (m.itemUrl && (!codec || !m.matches.some(p => new URL(p).origin === new URL(m.itemUrl!.replace('{id}', 'x')).origin))) throw new Error('invalidItemUrl');
  const itemId = (v: unknown): v is string => plainId(v) && (!codec || URL_ID.test(v));
  const validateCollection = (v: unknown) => m.defaultCollection ? v === m.defaultCollection.id : plainId(v);
  const root = (c: SiteCollection) => validateCollection(c.id) && c.parentId === null;
  const validateItem = (item: SiteItem) => itemId(item.id) && (!codec || item.identity === 'siteId' && item.url === codec.url(item.id));
  function validObservation(o: SiteObservation): boolean {
    if (o.type === 'catalog.upsert') return (o.collections ?? []).every(root) && (o.items ?? []).every(validateItem);
    if (o.type === 'favorite.uncertain') return itemId(o.itemId);
    const ids = o.memberships.mode === 'delta' ? [...o.memberships.added, ...o.memberships.removed] : o.memberships.collectionIds;
    return validateItem(o.item) && ids.every(validateCollection);
  }
  function validateMessage(message: AdapterMessage): boolean {
    switch (message.operation) {
      case 'connect': return true;
      case 'emit': return validObservation(message.data);
      // Hint confirmation resolves the item through its canonical URL.
      case 'membership.hint': return !!codec && itemId(message.hint.itemId) && [...message.hint.added, ...message.hint.removed].every(validateCollection);
      case 'page.result': return message.result.status === 'failed' || (message.result.kind === 'collections' ? message.result.page.items.every(root)
        : validateCollection(message.result.collectionId) && message.result.page.items.every(row => validateItem(row.item)));
      case 'item.result': return message.result.status !== 'resolved' || validateItem(message.result.item);
      case 'membership.result': return message.result.status === 'failed' || itemId(message.result.itemId) && message.result.edges.every(e => validateCollection(e.collectionId));
      default: return false;
    }
  }
  const withoutHash = (value: string) => { try { const u = new URL(value); u.hash = ''; return u.href; } catch { return null; } };
  return Object.freeze<SiteDefinition>({
    adapterId: m.adapterId, version: m.version, siteKey: m.siteKey, identityVersion: m.identityVersion, label: m.label,
    origin: new URL(m.matches[0]!).origin, matches: [...m.matches], runtime: 'userScript',
    ...(m.icon ? { icon: m.icon } : {}),
    ...(m.connectionKind ? { connectionKind: m.connectionKind } : {}),
    ...(m.defaultCollection ? { defaultCollection: { id: m.defaultCollection.id, identity: 'siteId', title: m.defaultCollection.title, parentId: null } } : {}),
    capabilities: [...m.capabilities], negativeReadback: m.negativeReadback ?? false,
    ...(m.readScope ? { readScope: m.readScope } : {}), ...(m.contentIdScope ? { contentIdScope: m.contentIdScope } : {}),
    ...(m.collectionSnapshot ? { collectionSnapshot: m.collectionSnapshot } : {}), membershipModel: 'set', collectionHierarchy: 'flat',
    ...(m.readPolicy ? { readPolicy: m.readPolicy } : {}), importResume: m.importResume ?? 'restartAndDeduplicate',
    scripts: { adapter: COMMUNITY_RUNTIME_SCRIPT },
    validateAccount: plainId, validateCollection, validateItem, validateMessage,
    contentIdentity(url) { const id = codec?.id(url); return id ? { siteKey: m.siteKey, identityVersion: m.identityVersion, itemId: id } : null; },
    itemUrl: id => codec?.url(id) ?? null,
    sameResolutionTarget: (a, b) => codec ? !!codec.id(a) && codec.id(a) === codec.id(b) : !!withoutHash(a) && withoutHash(a) === withoutHash(b),
  });
}
/** What enabling a site asks the browser for. */
export function siteGrants(definition: Pick<SiteDefinition, 'matches' | 'runtime'>) {
  return { permissions: [definition.runtime === 'userScript' ? 'userScripts' : 'scripting', 'webNavigation'], origins: [...definition.matches] };
}
