import { cursorPage } from '../sync-state/idb.js';
import type { ContentIdentity } from './contracts.js';
import type { SourceConnection } from './ledger-types.js';
import { sourceKey, sourcePrefixRange, type SourceDatabase } from './source-db.js';
export const contentBindingKey = (content: ContentIdentity, id: string) => sourceKey(content.siteKey, content.identityVersion, content.itemId, id);
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
