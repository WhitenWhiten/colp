import type { CollectionItem, ItemResolutionResult, MembershipReadQuery, MembershipReadResult, SiteCollection, SiteItem, SourceIdentityClaim, SourcePage } from '../contracts.js';
import { LIMITS as L } from '../limits.js';
import { jsonBytes } from '../schema.js';
import { aidFromItem, collection, decimal, detail, itemId, resolveAvUrl, resolveBvUrl } from './identity.js';
import { fail, record, type HttpContext, type Operation } from './http.js';
type Read = (operation: Operation, ctx: HttpContext) => Promise<unknown>;
type Resource = { id: string; type: number };
interface Buffer { token: string; collectionId: string | null; nextPage: number; offset: number; rows: (Resource | SiteCollection)[];
  seen: Set<string>; response: SourcePage<SiteCollection> | SourcePage<CollectionItem> | null; partial: boolean }
/** Bounded document-local continuations. Cache loss always requires restartAndDeduplicate. */
export class BilibiliReader {
  private buffers = new Map<string, Buffer>();
  private replays = new Map<string, SourcePage<SiteCollection> | SourcePage<CollectionItem>>();
  private remember(key: string, result: SourcePage<SiteCollection> | SourcePage<CollectionItem>) {
    this.replays.set(key, structuredClone(result));
    if (this.replays.size > 2) this.replays.delete(this.replays.keys().next().value!);
  }
  constructor(private readonly read: Read, private readonly random: () => string = () => crypto.randomUUID()) {}
  async detectSource(ctx: HttpContext): Promise<SourceIdentityClaim> {
    const data = record(await this.read({ kind: 'account' }, ctx));
    if (data.isLogin === false) return { state: 'signedOut' };
    const accountId = decimal(data.mid);
    return data.isLogin === true && accountId ? { state: 'signedIn', accountId } : { state: 'unknown' };
  }
  async verifyAccount(accountId: string, ctx: HttpContext) {
    const source = await this.detectSource(ctx);
    if (source.state !== 'signedIn' || source.accountId !== accountId) fail('signedOut');
  }
  async resolveItem(url: string, ctx: HttpContext): Promise<ItemResolutionResult> {
    const aid = resolveAvUrl(url);
    const bvid = resolveBvUrl(url);
    if (!aid && !bvid) return { status: 'unresolved', reason: 'unsupportedUrl' };
    let item: SiteItem | null;
    if (bvid) {
      const data = record(await this.read({ kind: 'video', bvid }, ctx)), resolvedAid = decimal(data.aid);
      if (data.bvid !== bvid || !resolvedAid || data.state !== 0) return { status: 'unresolved', reason: 'ambiguousIdentity' };
      const resolved = detail({ id: resolvedAid, type: 2, title: data.title, attr: 0 });
      item = resolved.status === 'ok' ? resolved.item : null;
    } else item = await this.readItem(itemId(aid!), ctx);
    return item ? { status: 'resolved', item } : { status: 'unresolved', reason: 'ambiguousIdentity' };
  }
  async readItem(id: string, ctx: HttpContext): Promise<SiteItem | null> {
    const aid = aidFromItem(id); if (!aid) fail('unsupported');
    const rows = await this.read({ kind: 'details', ids: [{ id: aid, type: 2 }] }, ctx);
    if (!Array.isArray(rows) || rows.length > L.detailsPerRequest) fail('invalidData');
    const matches = rows.filter(x => decimal(record(x).id) === aid && record(x).type === 2);
    if (matches.length > 1) fail('invalidData');
    const result = detail(matches[0]); return result.status === 'ok' ? result.item : null;
  }
  private create(collectionId: string | null): Buffer {
    if (this.buffers.size >= L.cursorBuffers) this.buffers.delete(this.buffers.keys().next().value!);
    const b: Buffer = { token: this.random(), collectionId, nextPage: 1, offset: 0, rows: [], seen: new Set(), response: null, partial: false };
    this.buffers.set(b.token, b); return b;
  }
  private cursor(value: string, collectionId: string | null): Buffer {
    const b = this.buffers.get(value);
    if (!b || b.collectionId !== collectionId) fail('staleCursor'); return b;
  }
  async readCollectionsPage(accountId: string, cursor: string | null, ctx: HttpContext): Promise<SourcePage<SiteCollection>> {
    const replay = cursor && this.replays.get(`catalog:${cursor}`); if (replay) return structuredClone(replay) as SourcePage<SiteCollection>;
    const b = cursor ? this.cursor(cursor, null) : this.create(null);
    if (b.response) return b.response as SourcePage<SiteCollection>;
    if (!cursor) {
      const data = record(await this.read({ kind: 'collections', accountId }, ctx));
      if (!Array.isArray(data.list) || data.list.length > 2000) fail('invalidData');
      const rows = data.list.map(collection);
      if (rows.some(x => !x) || new Set(rows.map(x => x!.id)).size !== rows.length) fail('invalidData');
      b.rows = rows as SiteCollection[];
    }
    const rows = b.rows.slice(b.offset) as SiteCollection[];
    const selected: SiteCollection[] = [];
    for (const row of rows.slice(0, L.entities)) {
      if (!jsonBytes({ items: [...selected, row] }, L.pageBytes - 4096)) break;
      selected.push(row);
    }
    const end = b.offset + selected.length;
    const next = end < b.rows.length ? this.random() : null;
    if (next) { this.buffers.delete(b.token); this.buffers.set(next, { ...b, token: next, offset: end, response: null }); }
    const response: SourcePage<SiteCollection> = { items: selected, nextCursor: next, coverage: 'complete', consistency: 'bestEffort' };
    b.response = response; if (cursor) this.remember(`catalog:${cursor}`, response); return response;
  }
  async readItemsPage(collectionId: string, cursor: string | null, ctx: HttpContext): Promise<SourcePage<CollectionItem>> {
    if (!decimal(collectionId)) fail('invalidData');
    const replay = cursor && this.replays.get(`${collectionId}:${cursor}`); if (replay) return structuredClone(replay) as SourcePage<CollectionItem>;
    const b = cursor ? this.cursor(cursor, collectionId) : this.create(collectionId);
    if (b.response) return b.response as SourcePage<CollectionItem>;
    if (!b.rows.length || b.offset >= b.rows.length) {
      if (b.nextPage > L.idPages) fail('capacity');
      const raw = await this.read({ kind: 'ids', collectionId, page: b.nextPage++ }, ctx);
      if (!Array.isArray(raw) || raw.length > L.idsPerApiPage) fail('invalidData');
      if (!raw.length) return { items: [], nextCursor: null, coverage: b.partial ? 'partial' : 'complete', consistency: 'bestEffort' };
      const rows: Resource[] = [];
      for (const value of raw) {
        const r = record(value), id = decimal(r.id);
        if (!id || !Number.isSafeInteger(r.type) || Number(r.type) < 0) fail('invalidData');
        const key = `${r.type}:${id}`;
        if (!b.seen.has(key)) { b.seen.add(key); rows.push({ id, type: Number(r.type) }); }
      }
      if (!rows.length) fail('invalidData'); // duplicate-only/cyclic page isn't terminal success
      if (b.seen.size > L.importItems) fail('capacity');
      b.rows = rows; b.offset = 0;
    }
    const batch = (b.rows as Resource[]).slice(b.offset, b.offset + L.detailsPerRequest);
    const supported = batch.filter(x => x.type === 2);
    const details = supported.length ? await this.read({ kind: 'details', ids: supported }, ctx) : [];
    if (!Array.isArray(details) || details.length > supported.length) fail('invalidData');
    const byKey = new Map<string, unknown>();
    for (const value of details) {
      const r = record(value), id = decimal(r.id), key = `${r.type}:${id}`;
      if (!supported.some(x => x.id === id && x.type === r.type) || byKey.has(key)) fail('invalidData'); byKey.set(key, value);
    }
    const items: CollectionItem[] = [], omissions: NonNullable<SourcePage<CollectionItem>['omissions']>[number][] = [];
    let consumed = 0;
    for (const resource of batch) {
      const id = resource.type === 2 ? itemId(resource.id) : `resource:${resource.type}:${resource.id}`;
      const result = resource.type === 2 ? detail(byKey.get(`2:${resource.id}`)) : { status: 'unsupported' as const };
      if (result.status === 'ok') {
        if (!jsonBytes({ items: [...items, { item: result.item }], omissions }, L.pageBytes - 4096)) break;
        items.push({ item: result.item });
      } else { omissions.push({ id, reason: result.status }); b.partial = true; }
      consumed++;
    }
    if (!consumed) fail('capacity');
    b.offset += consumed;
    // Keep one bounded API page, request the next only on a subsequent command.
    const next = this.random();
    this.buffers.delete(b.token); this.buffers.set(next, { ...b, token: next, response: null });
    const response: SourcePage<CollectionItem> = { items, omissions, nextCursor: next, coverage: b.partial ? 'partial' : 'complete', consistency: 'bestEffort' };
    b.response = response; if (cursor) this.remember(`${collectionId}:${cursor}`, response); return response;
  }
  async readMemberships(query: MembershipReadQuery, ctx: HttpContext): Promise<MembershipReadResult> {
    const aid = aidFromItem(query.itemId); if (!aid || !query.collectionIds.length || query.collectionIds.length > L.memberships) fail('unsupported');
    const edges: Extract<MembershipReadResult, { status: 'ok' }>['edges'][number][] = [];
    for (const collectionId of query.collectionIds) {
      // Fresh scoped first API page; positive only. No absence inference from pagination.
      const data = await this.read({ kind: 'ids', collectionId, page: 1 }, ctx);
      if (!Array.isArray(data) || data.length > L.idsPerApiPage) fail('invalidData');
      const present = data.some(x => decimal(record(x).id) === aid && record(x).type === 2);
      edges.push(present ? { collectionId, state: 'present', evidence: { kind: 'siteResponse', operation: 'ids.fresh' } }
        : { collectionId, state: 'unknown', reason: 'ambiguousState' });
    }
    return { status: 'ok', itemId: query.itemId, edges };
  }
  clear() { this.buffers.clear(); this.replays.clear(); }
}
