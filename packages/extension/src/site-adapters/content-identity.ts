import { cursorPage } from '../sync-state/idb.js';
import type { ContentIdentity } from './contracts.js';
import type { SourceConnection } from './ledger-types.js';
import { sourceKey, sourcePrefixRange, type SourceDatabase } from './source-db.js';
export const contentBindingKey = (content: ContentIdentity, id: string) => sourceKey(content.siteKey, content.identityVersion, content.itemId, id);
export const sameContentIdentity = (a: ContentIdentity, b: ContentIdentity) => a.siteKey === b.siteKey && a.identityVersion === b.identityVersion
  && a.itemId === b.itemId && (a.accountId ?? null) === (b.accountId ?? null);
export async function readSourceConnection(db: SourceDatabase, connectionId: string): Promise<SourceConnection> {
  const value = await db.transaction(['connections'], 'readonly', tx => new Promise<SourceConnection | undefined>((resolve, reject) => {
    const r = tx.objectStore('connections').index('id').get(connectionId); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }));
  if (!value) throw new Error('sourceIdentityNeedsReview'); return value;
}

export function listContentBindings(db: SourceDatabase, identity: Pick<ContentIdentity, 'siteKey' | 'identityVersion'>, limit = 1001) {
  return db.transaction(['contentBindings'], 'readonly', tx => cursorPage<import('./content-bindings.js').ContentBindingRow>(
    tx.objectStore('contentBindings'), sourcePrefixRange(identity.siteKey, identity.identityVersion), limit));
}

/** Page live bindings by primary key; superseded history never consumes a page. */
export function pageContentBindings(db: SourceDatabase, identity: Pick<ContentIdentity, 'siteKey' | 'identityVersion'>, after?: string) {
  const range = sourcePrefixRange(identity.siteKey, identity.identityVersion);
  const lower = range.lower as string, upper = range.upper as string;
  if (after !== undefined && (after < lower || after >= upper)) throw new Error('invalid');
  return db.transaction(['contentBindings'], 'readonly', tx => new Promise<{ rows: import('./content-bindings.js').ContentBindingRow[]; nextCursor: string | null }>((resolve, reject) => {
    const items: { key: string; value: import('./content-bindings.js').ContentBindingRow }[] = [];
    const cursor = tx.objectStore('contentBindings').openCursor(after === undefined ? range : IDBKeyRange.bound(after, upper, true));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row || items.length === 51) return resolve({ rows: items.slice(0, 50).map(item => item.value), nextCursor: items.length > 50 ? items[49]!.key : null });
      const value = row.value as import('./content-bindings.js').ContentBindingRow;
      if (!value.supersededBy && value.content.siteKey === identity.siteKey && value.content.identityVersion === identity.identityVersion)
        items.push({ key: row.key as string, value });
      row.continue();
    };
  }));
}
