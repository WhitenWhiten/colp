import { SourceArchiveError, object, text, integer, sourceHash } from './codec.js';
export interface ManagedContent { site: string; identityVersion: number; itemId: string; accountId: string | null }
export type ManagedCopy = { content: ManagedContent } & (
  | { purpose: 'sourceArchive'; sourceAccount: string; sourceCollectionId: string }
  | { purpose: 'semantic' }
);
export interface ManagedFolder { site: string; identityVersion: number; sourceAccount: string; sourceCollectionId: string }
export type ManagedSlot = { kind: 'bookmark'; copy: ManagedCopy } | { kind: 'folder'; source: ManagedFolder };
export interface ManagedSaveCommand {
  copyPolicy?: 'sourceAndSemantic' | 'singlePreferSemantic' | 'singleKeepExisting';
  commandId: string; replicaId: string; collectionId: string;
  parentId: string; parentRevision: string; slot: ManagedSlot; title: string; url: string | null;
  semanticClaim?: { ownerId: string; revision: number };
  adopt?: { nodeId: string; revision: string };
  converge?: { fromParentId: string };
}
export interface ManagedNode { nodeId: string; parentId: string; title: string; url: string | null; revision: string; deleted?: boolean }
export interface ManagedSaveReceipt {
  convergedFrom?: string;
  reusedFrom?: 'sourceArchive' | 'semantic';
  controlRevision?: number;
  version: 1; commandId: string; digest: string; key: string; node: ManagedNode;
  disposition: 'created' | 'reused' | 'detached' | 'suppressed';
}
export interface ManagedBinding { slot: ManagedSlot; collectionId: string; node: ManagedNode; state: 'active' | 'detached' | 'suppressed'; lifecycle?: 'current' | 'retired'; titleOverride?: boolean; controlRevision?: number }
export interface SemanticClaim { ownerId: string | null; revision: number }
export interface ManagedSaveState { bindings: Record<string, ManagedBinding>; receipts: Record<string, ManagedSaveReceipt>; semanticClaims?: Record<string, SemanticClaim>; edits?: Record<string, import('./reconcile.js').ManagedReconcileReceipt>; cancelled?: Record<string, string> }
export interface ManagedSavePorts {
  /** Caller holds the authenticated session, account, replica and collection locks through commit. */
  assertTarget(command: ManagedSaveCommand): Promise<void>;
  read(collectionId: string, nodeId: string): Promise<ManagedNode | null>;
  create(command: ManagedSaveCommand): Promise<ManagedNode>;
  converge?(command: ManagedSaveCommand, winner: ManagedNode | null, winnerSlot?: ManagedSlot): Promise<ManagedNode>;
}
const fail = (code: string): never => { throw new SourceArchiveError(code); };
const own = <T>(r: Record<string, T>, key: string) => Object.hasOwn(r, key) ? r[key] : undefined;
export function parseManagedSlot(raw: unknown): ManagedSlot {
  if ((raw as { kind?: unknown } | null)?.kind === 'bookmark') {
    const slot = object(raw, ['kind', 'copy']); parseManagedCopy(slot.copy); return slot as unknown as ManagedSlot;
  }
  const slot = object(raw, ['kind', 'source']); if (slot.kind !== 'folder') fail('invalid_managed_copy');
  const s = object(slot.source, ['site', 'identityVersion', 'sourceAccount', 'sourceCollectionId']);
  text(s.site, 512); integer(s.identityVersion); text(s.sourceAccount, 512); text(s.sourceCollectionId, 512);
  return slot as unknown as ManagedSlot;
}
/** Keep the canonical bookmark while opting out of reconstruction on every replica. */
export function markManagedChange(state: ManagedSaveState, collectionId: string, slot: ManagedSlot, nodeId: string, status: 'detached' | 'suppressed', revision = 0) {
  const key = managedSlotKey(collectionId, slot), binding = own(state.bindings, key);
  if (!binding || binding.node.nodeId !== nodeId) return fail('source_copy_adoption_conflict');
  if ((binding.controlRevision ?? 0) !== revision && binding.state !== status) return fail('source_association_changed');
  for (const [alias, value] of Object.entries(state.bindings)) if (value.collectionId === collectionId && value.node.nodeId === nodeId
    && ((value.controlRevision ?? 0) <= revision || value.state === status))
    state.bindings[alias] = { ...value, state: value.state === 'suppressed' ? 'suppressed' : status };
  return state.bindings[key];
}
/** Complete an explicitly authorized host move after ordinary Sync has committed its exact result. */
export async function relocateManagedCopy(state: ManagedSaveState, collectionId: string, slot: ManagedSlot,
  expected: { nodeId: string; from: string; to: string; title: string; url: string | null; revision: string }, ports: Pick<ManagedSavePorts, 'read'>) {
  const key = managedSlotKey(collectionId, slot), binding = own(state.bindings, key);
  if (!binding || binding.node.nodeId !== expected.nodeId || binding.state === 'suppressed') return fail('source_copy_adoption_conflict');
  const node = await ports.read(collectionId, expected.nodeId);
  if (!node || node.deleted || node.parentId !== expected.to || node.title !== expected.title || node.url !== expected.url || node.revision !== expected.revision)
    return fail('source_representation_needs_review');
  for (const [alias, value] of Object.entries(state.bindings)) if (value.collectionId === collectionId && value.node.nodeId === node.nodeId
    && value.state !== 'suppressed' && value.node.title === expected.title && value.node.url === expected.url
    && [expected.from, expected.to].includes(value.node.parentId)) state.bindings[alias] = { ...value, node, state: 'active' };
  return state.bindings[key];
}
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
  const c = object(raw, ['commandId', 'replicaId', 'collectionId', 'parentId', 'parentRevision', 'slot', 'title', 'url',
    ...raw && typeof raw === 'object' && Object.hasOwn(raw, 'semanticClaim') ? ['semanticClaim'] : [],
    ...raw && typeof raw === 'object' && Object.hasOwn(raw, 'adopt') ? ['adopt'] : [],
    ...raw && typeof raw === 'object' && Object.hasOwn(raw, 'converge') ? ['converge'] : [],
    ...raw && typeof raw === 'object' && Object.hasOwn(raw, 'copyPolicy') ? ['copyPolicy'] : []]);
  for (const k of ['commandId', 'replicaId', 'collectionId', 'parentId', 'parentRevision']) text(c[k]);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(String(c.commandId)) || ['constructor', 'prototype'].includes(String(c.commandId))) fail('invalid_managed_command');
  if (typeof c.title !== 'string' || c.title.length > 512 || /[\u0000-\u001f]/u.test(c.title)) fail('invalid_managed_command');
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
  if (c.copyPolicy !== undefined && !['sourceAndSemantic', 'singlePreferSemantic', 'singleKeepExisting'].includes(String(c.copyPolicy))) fail('invalid_managed_copy');
  if (c.semanticClaim !== undefined) {
    const claim = object(c.semanticClaim, ['ownerId', 'revision']); text(claim.ownerId); integer(claim.revision);
    if (kind !== 'bookmark' || (c.slot as { copy: ManagedCopy }).copy.purpose !== 'semantic') fail('invalid_managed_copy');
  }
  if (c.adopt !== undefined) { const adopt = object(c.adopt, ['nodeId', 'revision']); text(adopt.nodeId); text(adopt.revision); }
  if (c.converge !== undefined) { text(object(c.converge, ['fromParentId']).fromParentId); if (!c.adopt) fail('invalid_managed_command'); }
  return c as unknown as ManagedSaveCommand;
}
/** Run in the same transaction as canonical creation. The durable key is shared by all replicas. */
export async function saveManagedCopy(state: ManagedSaveState, command: ManagedSaveCommand, ports: ManagedSavePorts): Promise<ManagedSaveReceipt> {
  const digest = sourceHash(command), previous = own(state.receipts, command.commandId);
  const cancelled = own(state.cancelled ?? {}, command.commandId);
  if (cancelled) { if (cancelled !== digest) fail('source_command_reused'); fail('source_command_cancelled'); }
  if (previous) {
    if (previous.digest !== digest) fail('source_command_reused');
    return previous;
  }
  await ports.assertTarget(command);
  const key = managedSlotKey(command.collectionId, command.slot);
  let binding = await observeManagedCopy(state, command.collectionId, command.slot, ports);
  const single = command.copyPolicy !== undefined && command.copyPolicy !== 'sourceAndSemantic' && command.slot.kind === 'bookmark';
  if (single && command.slot.kind === 'bookmark') {
    const content = command.slot.copy.content, matches: ManagedBinding[] = [];
    for (const candidate of Object.values(state.bindings)) {
      if (candidate.collectionId !== command.collectionId || candidate.slot.kind !== 'bookmark') continue;
      const c = candidate.slot.copy.content;
      if (c.site !== content.site || c.identityVersion !== content.identityVersion || c.itemId !== content.itemId || c.accountId !== content.accountId) continue;
      const current = await observeManagedCopy(state, command.collectionId, candidate.slot, ports); if (current) matches.push(current);
    }
    if (new Set(matches.map(b => b.node.nodeId)).size > 1) fail('source_copy_policy_needs_review');
    binding = matches.find(b => b.state === 'suppressed') ?? matches.find(b => b.state === 'detached') ?? binding ?? matches[0] ?? null;
  }
  const identity = command.slot.kind === 'folder' ? { site: command.slot.source.site, version: command.slot.source.identityVersion, account: command.slot.source.sourceAccount }
    : { site: command.slot.copy.content.site, version: command.slot.copy.content.identityVersion, account: command.slot.copy.purpose === 'sourceArchive' ? command.slot.copy.sourceAccount : command.slot.copy.content.accountId };
  if (!binding && Object.values(state.bindings).some(b => {
    const previous = b.slot.kind === 'folder' ? { site: b.slot.source.site, version: b.slot.source.identityVersion, account: b.slot.source.sourceAccount }
      : { site: b.slot.copy.content.site, version: b.slot.copy.content.identityVersion, account: b.slot.copy.purpose === 'sourceArchive' ? b.slot.copy.sourceAccount : b.slot.copy.content.accountId };
    return b.collectionId === command.collectionId && previous.site === identity.site && previous.account === identity.account && previous.version !== identity.version;
  })) fail('source_identity_migration_required');
  if (Object.keys(state.receipts).length >= 50000 || !binding && Object.keys(state.bindings).length >= 50000) fail('source_capacity');
  let node: ManagedNode, disposition: ManagedSaveReceipt['disposition'];
  if (binding) {
    if (command.adopt && command.adopt.nodeId !== binding.node.nodeId && !command.converge) fail('source_copy_adoption_conflict');
    node = await ports.read(command.collectionId, binding.node.nodeId) ?? { ...binding.node, deleted: true };
    if (binding.state === 'suppressed' || node.deleted) disposition = 'suppressed';
    else if (binding.state === 'detached' || node.parentId !== binding.node.parentId || node.title !== binding.node.title
      || node.url !== binding.node.url) disposition = 'detached';
    else {
      if (binding.node.parentId !== command.parentId && !single && !(command.slot.kind === 'bookmark' && command.slot.copy.purpose === 'semantic')) fail('source_mapping_migration_required');
      disposition = 'reused';
      if (command.converge && command.adopt!.nodeId !== node.nodeId) {
        if (!ports.converge || Object.values(state.bindings).some(b => b.collectionId === command.collectionId && b.node.nodeId === command.adopt!.nodeId)) fail('source_copy_protected');
        node = await ports.converge!(command, node, binding.slot);
        for (const [alias, value] of Object.entries(state.bindings)) if (value.collectionId === command.collectionId && value.node.nodeId === node.nodeId && value.state === 'active')
          state.bindings[alias] = { ...value, node };
      }
    }
  } else {
    if (command.slot.kind === 'bookmark' && command.slot.copy.purpose === 'semantic' && !command.adopt) {
      const claim = own(state.semanticClaims ?? {}, key);
      if (!claim?.ownerId || !command.semanticClaim || claim.ownerId !== command.semanticClaim.ownerId || claim.revision !== command.semanticClaim.revision) fail('source_semantic_claim_changed');
    }
    if (command.adopt) {
      const existing = await ports.read(command.collectionId, command.adopt.nodeId);
      if (!existing || existing.deleted || existing.revision !== command.adopt.revision || existing.parentId !== (command.converge?.fromParentId ?? command.parentId)
        || existing.title !== command.title || existing.url !== command.url) return fail('source_copy_adoption_conflict');
      node = command.converge && existing.parentId !== command.parentId
        ? ports.converge ? await ports.converge(command, null) : fail('source_copy_protected') : existing;
      disposition = 'reused';
    } else { node = await ports.create(command); disposition = 'created'; }
  }
  const receipt: ManagedSaveReceipt = { version: 1, commandId: command.commandId, digest, key, node, disposition, controlRevision: binding?.controlRevision ?? 0,
    ...(command.converge && command.adopt!.nodeId !== node.nodeId && disposition === 'reused' ? { convergedFrom: command.adopt!.nodeId } : {}),
    ...(disposition === 'reused' && binding?.slot.kind === 'bookmark' ? { reusedFrom: binding.slot.copy.purpose } : {}) };
  state.bindings[key] = { ...binding, slot: command.slot, collectionId: command.collectionId, node,
    state: disposition === 'suppressed' || disposition === 'detached' ? disposition : 'active' };
  state.receipts[command.commandId] = receipt;
  return receipt;
}
/** Refresh manual state from canonical data; read failures must propagate rather than imply deletion. */
export async function observeManagedCopy(state: ManagedSaveState, collectionId: string, slot: ManagedSlot, ports: Pick<ManagedSavePorts, 'read'>): Promise<ManagedBinding | null> {
  const key = managedSlotKey(collectionId, slot), binding = own(state.bindings, key); if (!binding) return null;
  const node = await ports.read(collectionId, binding.node.nodeId);
  const titleOnly = binding.state === 'active' && node && !node.deleted && node.parentId === binding.node.parentId && node.url === binding.node.url && node.title !== binding.node.title;
  const status = binding.state === 'suppressed' || !node || node.deleted ? 'suppressed'
    : binding.state === 'detached' || node.parentId !== binding.node.parentId || !titleOnly && node.title !== binding.node.title || node.url !== binding.node.url ? 'detached' : 'active';
  const current = { ...binding, node: node ?? { ...binding.node, deleted: true }, state: status, ...(titleOnly ? { titleOverride: true } : {}) } satisfies ManagedBinding;
  state.bindings[key] = current; return current;
}
/** A provider call has no automatic timeout takeover: an uncertain result requires an explicit retry. */
export function claimManagedSemantic(state: ManagedSaveState, collectionId: string, copy: ManagedCopy, ownerId: string) {
  if (copy.purpose !== 'semantic') fail('invalid_managed_copy');
  const key = managedCopyKey(collectionId, copy), binding = own(state.bindings, key);
  if (binding) return { status: 'saved' as const, binding };
  const claims = state.semanticClaims ??= {}, old = own(claims, key);
  if (!old && Object.keys(claims).length >= 50000) fail('source_capacity');
  if (old?.ownerId && old.ownerId !== ownerId) return { status: 'waiting' as const, claim: old };
  if (!old?.ownerId) claims[key] = { ownerId, revision: (old?.revision ?? 0) + 1 };
  return { status: 'claimed' as const, claim: claims[key]! };
}
export function releaseManagedSemantic(state: ManagedSaveState, collectionId: string, copy: ManagedCopy, claim: SemanticClaim) {
  if (copy.purpose !== 'semantic') fail('invalid_managed_copy');
  const claims = state.semanticClaims ??= {}, key = managedCopyKey(collectionId, copy), current = own(claims, key);
  // A lost release reply may be retried after a newer owner has claimed. The old attempt stays fenced.
  if (current && current.revision > claim.revision) return;
  if (!current || current.ownerId !== claim.ownerId || current.revision !== claim.revision) return fail('source_semantic_claim_changed');
  claims[key] = { ownerId: null, revision: current.revision + 1 };
}
export function recoverManagedCopy(state: ManagedSaveState, commandId: string, digest: string): ManagedSaveReceipt | null {
  const receipt = own(state.receipts, commandId);
  if (receipt && receipt.digest !== digest) fail('source_command_reused');
  return receipt ?? null;
}

/** Serialize cancellation with saves under the account lock; an existing receipt always wins. */
export function cancelManagedCopy(state: ManagedSaveState, commandId: string, digest: string): ManagedSaveReceipt | null {
  const receipt = recoverManagedCopy(state, commandId, digest);
  if (receipt) return receipt;
  const cancelled = state.cancelled ??= {}, previous = own(cancelled, commandId);
  if (previous && previous !== digest) fail('source_command_reused');
  cancelled[commandId] = digest;
  return null;
}
