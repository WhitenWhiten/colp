import { sourceHash, SourceArchiveError, type ManagedBinding, type ManagedNode, type ManagedSlot } from '../../modules/source-archives/index.js';
export const recordHash = (value: unknown) => sourceHash(value).slice(7);
export type RecordKind = 'bindings' | 'receipts' | 'semanticClaims' | 'edits' | 'legacyFolders' | 'legacyCopies';
export interface ManagedRecord {
  kind: RecordKind; record_key: string; record_hash: string; payload_json: unknown;
  collection_id: string | null; node_id: string | null; content_hash: string | null; identity_hash: string | null; identity_version: number | null;
}
export function slotIdentity(collectionId: string, slot: ManagedSlot) {
  const c = slot.kind === 'folder' ? { site: slot.source.site, identityVersion: slot.source.identityVersion, accountId: slot.source.sourceAccount }
    : { ...slot.copy.content, accountId: slot.copy.purpose === 'sourceArchive' ? slot.copy.sourceAccount : slot.copy.content.accountId };
  return { hash: recordHash([collectionId, c.site, c.accountId]), version: c.identityVersion };
}
export function bindingContent(collectionId: string, slot: ManagedSlot) {
  return slot.kind === 'bookmark' ? recordHash([collectionId, slot.copy.content]) : null;
}
export function managedRecord(kind: RecordKind, key: string, payload: unknown): ManagedRecord {
  const row: ManagedRecord = { kind, record_key: key, record_hash: recordHash(key), payload_json: payload,
    collection_id: null, node_id: null, content_hash: null, identity_hash: null, identity_version: null };
  if (kind === 'bindings') {
    const b = payload as ManagedBinding, identity = slotIdentity(b.collectionId, b.slot);
    Object.assign(row, { collection_id: b.collectionId, node_id: b.node.nodeId, content_hash: bindingContent(b.collectionId, b.slot), identity_hash: identity.hash, identity_version: identity.version });
  } else if (kind === 'legacyFolders' || kind === 'legacyCopies') {
    let parts: unknown; try { parts = JSON.parse(key); } catch { throw new SourceArchiveError('source_legacy_association_review_required'); }
    if (!Array.isArray(parts)) throw new SourceArchiveError('source_legacy_association_review_required');
    row.node_id = (payload as ManagedNode).nodeId;
    row.collection_id = kind === 'legacyFolders' ? parts[1] : parts[2] === 'single' ? null : parts[2];
    if (kind === 'legacyFolders') row.identity_hash = recordHash([parts[0], 'folder', parts[1], parts[3]]);
    else row.content_hash = recordHash([parts[0], 'item', parts[1]]);
  }
  return row;
}
