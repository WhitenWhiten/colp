import { SourceArchiveError, object, text, integer, sourceHash } from './codec.js';
export interface ManagedContent { site: string; identityVersion: number; itemId: string; accountId: string | null }
export type ManagedCopy = { content: ManagedContent } & (
  | { purpose: 'sourceArchive'; sourceAccount: string; sourceCollectionId: string }
  | { purpose: 'semantic' }
);
export interface ManagedFolder { site: string; identityVersion: number; sourceAccount: string; sourceCollectionId: string }
export type ManagedSlot = { kind: 'bookmark'; copy: ManagedCopy } | { kind: 'folder'; source: ManagedFolder };
export interface ManagedSaveCommand {
  commandId: string; replicaId: string; collectionId: string;
  parentId: string; parentRevision: string; slot: ManagedSlot; title: string; url: string | null;
}
export interface ManagedNode { nodeId: string; parentId: string; title: string; url: string | null; revision: string; deleted?: boolean }
export interface ManagedSaveReceipt {
  version: 1; commandId: string; digest: string; key: string; node: ManagedNode;
  disposition: 'created' | 'reused' | 'detached' | 'suppressed';
}
export interface ManagedBinding { slot: ManagedSlot; collectionId: string; node: ManagedNode; state: 'active' | 'detached' | 'suppressed' }
export interface ManagedSaveState { bindings: Record<string, ManagedBinding>; receipts: Record<string, ManagedSaveReceipt> }
export interface ManagedSavePorts {
  /** Caller holds the authenticated session, account, replica and collection locks through commit. */
  assertTarget(command: ManagedSaveCommand): Promise<void>;
  read(collectionId: string, nodeId: string): Promise<ManagedNode | null>;
  create(command: ManagedSaveCommand): Promise<ManagedNode>;
}
const fail = (code: string): never => { throw new SourceArchiveError(code); };
const own = <T>(r: Record<string, T>, key: string) => Object.hasOwn(r, key) ? r[key] : undefined;
export function parseManagedCopy(raw: unknown): ManagedCopy {
  const purpose = (raw as { purpose?: unknown } | null)?.purpose;
  const value = object(raw, purpose === 'sourceArchive' ? ['content', 'purpose', 'sourceAccount', 'sourceCollectionId'] : ['content', 'purpose']);
  const c = object(value.content, ['site', 'identityVersion', 'itemId', 'accountId']);
  text(c.site, 512); integer(c.identityVersion); text(c.itemId, 512);
  if (c.accountId !== null) text(c.accountId, 512);
  if (purpose === 'sourceArchive') {
    text(value.sourceAccount, 512); text(value.sourceCollectionId, 512);
    if (c.accountId !== null && c.accountId !== value.sourceAccount) fail('invalid_managed_copy');
  } else if (purpose !== 'semantic') fail('invalid_managed_copy');
  return value as unknown as ManagedCopy;
}
export function managedCopyKey(collectionId: string, copy: ManagedCopy): string {
  const c = copy.content;
  return JSON.stringify(['site-copy', 1, collectionId, c.site, c.identityVersion, c.accountId, c.itemId, copy.purpose,
    ...copy.purpose === 'sourceArchive' ? [copy.sourceAccount, copy.sourceCollectionId] : []]);
}
export function managedSlotKey(collectionId: string, slot: ManagedSlot): string {
  if (slot.kind === 'bookmark') return managedCopyKey(collectionId, slot.copy);
  const s = slot.source;
  return JSON.stringify(['site-folder', 1, collectionId, s.site, s.identityVersion, s.sourceAccount, s.sourceCollectionId]);
}
export function parseManagedSave(raw: unknown): ManagedSaveCommand {
  const c = object(raw, ['commandId', 'replicaId', 'collectionId', 'parentId', 'parentRevision', 'slot', 'title', 'url']);
  for (const k of ['commandId', 'replicaId', 'collectionId', 'parentId', 'parentRevision']) text(c[k]);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(String(c.commandId)) || ['constructor', 'prototype'].includes(String(c.commandId))) fail('invalid_managed_command');
  text(c.title, 512);
  const kind = (c.slot as { kind?: unknown } | null)?.kind;
  if (kind === 'bookmark') {
    const slot = object(c.slot, ['kind', 'copy']); parseManagedCopy(slot.copy);
    let url: URL;
    try { url = new URL(text(c.url, 8192)); } catch { return fail('invalid_managed_url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('invalid_managed_url');
  } else if (kind === 'folder') {
    const slot = object(c.slot, ['kind', 'source']);
    const s = object(slot.source, ['site', 'identityVersion', 'sourceAccount', 'sourceCollectionId']);
    text(s.site, 512); integer(s.identityVersion); text(s.sourceAccount, 512); text(s.sourceCollectionId, 512);
    if (c.url !== null) fail('invalid_managed_url');
  } else fail('invalid_managed_copy');
  return c as unknown as ManagedSaveCommand;
}
/** Run in the same transaction as canonical creation. The durable key is shared by all replicas. */
export async function saveManagedCopy(state: ManagedSaveState, command: ManagedSaveCommand, ports: ManagedSavePorts): Promise<ManagedSaveReceipt> {
  const digest = sourceHash(command), previous = own(state.receipts, command.commandId);
  if (previous) {
    if (previous.digest !== digest) fail('source_command_reused');
    return previous;
  }
  await ports.assertTarget(command);
  const key = managedSlotKey(command.collectionId, command.slot), binding = own(state.bindings, key);
  if (Object.keys(state.receipts).length >= 50000 || !binding && Object.keys(state.bindings).length >= 50000) fail('source_capacity');
  let node: ManagedNode, disposition: ManagedSaveReceipt['disposition'];
  if (binding) {
    node = await ports.read(command.collectionId, binding.node.nodeId) ?? { ...binding.node, deleted: true };
    if (binding.state === 'suppressed' || node.deleted) disposition = 'suppressed';
    else if (binding.state === 'detached' || node.parentId !== binding.node.parentId || node.title !== binding.node.title
      || node.url !== binding.node.url) disposition = 'detached';
    else {
      if (binding.node.parentId !== command.parentId) fail('source_mapping_migration_required');
      disposition = 'reused';
    }
  } else { node = await ports.create(command); disposition = 'created'; }
  const receipt: ManagedSaveReceipt = { version: 1, commandId: command.commandId, digest, key, node, disposition };
  state.bindings[key] = { slot: command.slot, collectionId: command.collectionId, node,
    state: disposition === 'suppressed' || disposition === 'detached' ? disposition : 'active' };
  state.receipts[command.commandId] = receipt;
  return receipt;
}
export function recoverManagedCopy(state: ManagedSaveState, commandId: string, digest: string): ManagedSaveReceipt | null {
  const receipt = own(state.receipts, commandId);
  if (receipt && receipt.digest !== digest) fail('source_command_reused');
  return receipt ?? null;
}
