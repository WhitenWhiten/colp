import { object, text, sourceHash, SourceArchiveError } from './codec.js';
import { parseManagedSlot, managedSlotKey, type ManagedNode, type ManagedSlot, type ManagedSaveState } from './managed-copies.js';
export interface ManagedReconcileCommand {
  commandId: string; collectionId: string; replicaId: string; action: 'rename' | 'move' | 'restore' | 'unlink';
  expected: ManagedNode; slot: ManagedSlot | null; parentId: string; title: string; retire: boolean;
  associationRevision?: number;
}
export interface ManagedReconcileReceipt { commandId: string; digest: string; before: ManagedNode; after: ManagedNode; slot: ManagedSlot | null; retire: boolean;
  previousState?: 'active' | 'detached' | 'suppressed'; previousLifecycle?: 'current' | 'retired'; controlRevision?: number; afterState?: 'active' | 'suppressed'; keepPhysical?: boolean }
export interface ReconcileState { edits?: Record<string, ManagedReconcileReceipt> }
export interface ManagedReconcilePorts {
  read(collectionId: string, nodeId: string): Promise<ManagedNode | null>;
  mutate(command: ManagedReconcileCommand, undoDelete?: boolean): Promise<ManagedNode>;
}
const fail = (code: string): never => { throw new SourceArchiveError(code); };
const own = <T>(map: Record<string, T>, key: string) => Object.hasOwn(map, key) ? map[key] : undefined;
const commandId = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value) || ['constructor', 'prototype'].includes(value)) fail('invalid_managed_command'); };
const title = (value: unknown) => { if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f]/u.test(value)) fail('invalid_managed_command'); };
export function parseManagedReconcile(raw: unknown): ManagedReconcileCommand {
  const c = object(raw, ['commandId', 'collectionId', 'replicaId', 'action', 'expected', 'slot', 'parentId', 'title', 'retire',
    ...raw && typeof raw === 'object' && Object.hasOwn(raw, 'associationRevision') ? ['associationRevision'] : []]);
  if (c.associationRevision !== undefined && (!Number.isSafeInteger(c.associationRevision) || Number(c.associationRevision) < 0)) fail('invalid_managed_command');
  for (const name of ['commandId', 'collectionId', 'replicaId', 'parentId']) text(c[name]); title(c.title);
  commandId(String(c.commandId));
  if (!['rename', 'move', 'restore', 'unlink'].includes(String(c.action)) || typeof c.retire !== 'boolean') fail('invalid_managed_command');
  if (c.slot !== null) parseManagedSlot(c.slot);
  const n = object(c.expected, ['nodeId', 'parentId', 'title', 'url', 'revision', ...c.expected && typeof c.expected === 'object' && Object.hasOwn(c.expected, 'deleted') ? ['deleted'] : []]);
  for (const name of ['nodeId', 'parentId', 'revision']) text(n[name]); title(n.title); if (n.url !== null) text(n.url, 8192);
  if (n.deleted !== undefined && typeof n.deleted !== 'boolean') fail('invalid_managed_command');
  if (['restore', 'unlink'].includes(String(c.action)) && c.slot === null || c.retire && c.slot === null) fail('invalid_managed_command');
  return c as unknown as ManagedReconcileCommand;
}
const same = (a: ManagedNode, b: ManagedNode) => a.nodeId === b.nodeId && a.parentId === b.parentId && a.title === b.title && a.url === b.url && a.revision === b.revision && !!a.deleted === !!b.deleted;
export async function reconcileManagedCopy(state: ManagedSaveState & ReconcileState, command: ManagedReconcileCommand, ports: ManagedReconcilePorts) {
  const edits = state.edits ??= {}, digest = sourceHash(command), old = own(edits, command.commandId);
  if (old) { if (old.digest !== digest) fail('source_command_reused'); return old; }
  if (Object.keys(edits).length >= 50000) fail('source_capacity');
  const role = command.slot && managedSlotKey(command.collectionId, command.slot);
  const binding = role ? own(state.bindings, role) : null;
  if (role && (!binding || binding.node.nodeId !== command.expected.nodeId)) fail('source_copy_adoption_conflict');
  if (binding && (binding.controlRevision ?? 0) !== (command.associationRevision ?? 0)) fail('source_association_changed');
  const aliases = Object.entries(state.bindings).filter(([, b]) => b.collectionId === command.collectionId && b.node.nodeId === command.expected.nodeId);
  const metadataOnly = command.action === 'unlink' || command.action === 'restore' && !command.expected.deleted && command.parentId === command.expected.parentId && command.title === command.expected.title;
  if (!metadataOnly && (aliases.some(([key]) => key !== role) || !role && aliases.length)) fail('source_copy_protected');
  if (!metadataOnly && command.expected.url === null) {
    const parents = new Map<string, string | null>();
    for (const b of Object.values(state.bindings)) if (b.collectionId === command.collectionId && b.node.nodeId !== command.expected.nodeId) {
      if (command.slot?.kind === 'folder' && b.slot.kind === 'bookmark' && b.slot.copy.purpose === 'sourceArchive'
        && b.slot.copy.content.site === command.slot.source.site && b.slot.copy.content.identityVersion === command.slot.source.identityVersion
        && b.slot.copy.sourceAccount === command.slot.source.sourceAccount && b.slot.copy.sourceCollectionId === command.slot.source.sourceCollectionId) continue;
      let id: string | null = b.node.parentId; const seen = new Set<string>();
      while (id) {
        if (id === command.expected.nodeId) fail('source_copy_protected');
        if (seen.has(id) || seen.size >= 256 || parents.size >= 10000) fail('source_capacity'); seen.add(id);
        if (!parents.has(id)) parents.set(id, (await ports.read(command.collectionId, id))?.parentId ?? null);
        id = parents.get(id) ?? null;
      }
    }
  }
  const before = await ports.read(command.collectionId, command.expected.nodeId);
  if (!before || !same(before, command.expected) || before.deleted && command.action !== 'restore') return fail('source_reconcile_conflict');
  const after = metadataOnly ? before : await ports.mutate(command);
  if (role && binding) state.bindings[role] = { ...binding, node: after, state: command.action === 'unlink' ? 'suppressed' : 'active', lifecycle: command.retire ? 'retired' : 'current',
    controlRevision: (binding.controlRevision ?? 0) + 1 };
  const receipt: ManagedReconcileReceipt = { commandId: command.commandId, digest, before, after, slot: command.slot, retire: command.retire,
    ...(binding ? { previousState: binding.state, previousLifecycle: binding.lifecycle ?? 'current', controlRevision: (binding.controlRevision ?? 0) + 1,
      afterState: command.action === 'unlink' ? 'suppressed' : 'active' } : {}) };
  edits[command.commandId] = receipt; return receipt;
}
export async function undoManagedReconcile(state: ManagedSaveState & ReconcileState, input: { commandId: string; collectionId: string; replicaId: string; original: string }, ports: ManagedReconcilePorts) {
  commandId(input.commandId);
  const edits = state.edits ??= {}, digest = sourceHash(input), existing = own(edits, input.commandId);
  if (existing) { if (existing.digest !== digest) fail('source_command_reused'); return existing; }
  if (Object.keys(edits).length >= 50000) fail('source_capacity');
  const original = own(edits, input.original); if (!original) return fail('source_reconcile_missing');
  const current = await ports.read(input.collectionId, original.after.nodeId);
  if (!current || !same(current, original.after)) return fail('source_reconcile_conflict');
  const aliases = Object.entries(state.bindings).filter(([, b]) => b.collectionId === input.collectionId && b.node.nodeId === current.nodeId);
  const role = original.slot && managedSlotKey(input.collectionId, original.slot);
  if (role && ((state.bindings[role]?.controlRevision ?? 0) !== (original.controlRevision ?? 0) || state.bindings[role]?.state !== (original.afterState ?? 'active'))) fail('source_association_changed');
  const metadataOnly = same(original.before, original.after);
  if (!metadataOnly && aliases.some(([key]) => key !== role)) fail('source_copy_protected');
  const command: ManagedReconcileCommand = { ...input, action: 'move', expected: current, slot: original.slot,
    parentId: original.before.parentId, title: original.before.title, retire: false };
  const after = metadataOnly ? current : await ports.mutate(command, !!original.before.deleted);
  if (role && state.bindings[role]) state.bindings[role] = { ...state.bindings[role]!, node: after, state: original.previousState ?? (original.before.deleted ? 'suppressed' : 'active'), lifecycle: original.previousLifecycle ?? 'current', controlRevision: (original.controlRevision ?? 0) + 1 };
  const receipt = { commandId: input.commandId, digest, before: current, after, slot: original.slot, retire: false,
    keepPhysical: aliases.some(([key]) => key !== role), ...(role ? { controlRevision: (original.controlRevision ?? 0) + 1 } : {}) };
  edits[input.commandId] = receipt; return receipt;
}
