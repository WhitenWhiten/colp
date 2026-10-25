/** Portable identity of managed content. Browser IDs, paths and adapter installations are never identity. */
export interface ManagedContent {
  site: string;
  identityVersion: number;
  itemId: string;
  /** null for site-wide IDs; private/account-local content must name its account. */
  accountId: string | null;
}
export type ManagedCopy = { content: ManagedContent } & (
  | { purpose: 'sourceArchive'; sourceAccount: string; sourceCollectionId: string }
  | { purpose: 'semantic' }
);
export interface ManagedLibrary { serverOrigin: string; accountId: string; collectionId: string }
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f]/u.test(v);
export function validManagedContent(v: unknown): v is ManagedContent {
  if (!v || typeof v !== 'object') return false;
  const c = v as ManagedContent;
  return Object.keys(c).length === 4 && id(c.site) && Number.isSafeInteger(c.identityVersion) && c.identityVersion > 0
    && id(c.itemId) && (c.accountId === null || id(c.accountId));
}
export function validManagedCopy(v: unknown): v is ManagedCopy {
  if (!v || typeof v !== 'object') return false;
  const c = v as ManagedCopy;
  return validManagedContent(c.content) && (c.purpose === 'semantic' ? Object.keys(c).length === 2
    : c.purpose === 'sourceArchive' && Object.keys(c).length === 4 && id(c.sourceAccount) && id(c.sourceCollectionId)
      && (c.content.accountId === null || c.content.accountId === c.sourceAccount));
}
/** Scope by the destination library, not by the currently selected website account or device. */
export function managedCopyKey(collectionId: string, copy: ManagedCopy): string {
  if (!id(collectionId) || !validManagedCopy(copy)) throw new Error('invalidManagedCopy');
  const c = copy.content;
  return JSON.stringify(['site-copy', 1, collectionId, c.site, c.identityVersion, c.accountId, c.itemId, copy.purpose,
    ...copy.purpose === 'sourceArchive' ? [copy.sourceAccount, copy.sourceCollectionId] : []]);
}
export function managedFolderKey(collectionId: string, copy: Extract<ManagedCopy, { purpose: 'sourceArchive' }>): string {
  if (!id(collectionId) || !validManagedCopy(copy) || copy.purpose !== 'sourceArchive') throw new Error('invalidManagedCopy');
  return JSON.stringify(['site-folder', 1, collectionId, copy.content.site, copy.content.identityVersion, copy.sourceAccount, copy.sourceCollectionId]);
}
export function managedLibraryKey(library: ManagedLibrary): string {
  const origin = new URL(library.serverOrigin).origin;
  if (!id(library.accountId) || !id(library.collectionId)) throw new Error('invalidManagedLibrary');
  return JSON.stringify([origin, library.accountId, library.collectionId]);
}
