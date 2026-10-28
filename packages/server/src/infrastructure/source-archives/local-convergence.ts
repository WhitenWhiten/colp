import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresNodeWritePort } from '../collections/repositories.js';
import { managedReconcilePorts } from './reconcile.js';
import { recordHash } from './managed-record-codec.js';
import { managedSlotKey, SourceArchiveError, type ManagedSaveCommand, type ManagedNode, type ManagedBinding, type ManagedSlot } from '../../modules/source-archives/index.js';
/** Merge only an unchanged, unannotated provisional copy. Every mutation emits ordinary Sync effects. */
export async function convergeLocalCopy(tx: DatabaseTransaction, subjectId: string, accountId: string, command: ManagedSaveCommand, winner: ManagedNode | null, winnerSlot?: ManagedSlot) {
  const fail = (reason = 'source_copy_convergence_review'): never => { throw new SourceArchiveError(reason); };
  if (!command.adopt || !command.converge) return fail();
  const nodes = createPostgresNodeWritePort(tx), node = await nodes.getNode(command.collectionId, command.adopt.nodeId);
  if (!node || node.deletedAt || node.isRoot || node.folderRole || node.resourceRevision !== command.adopt.revision
    || node.parentId !== command.converge.fromParentId || node.title !== command.title || node.url !== command.url
    || node.description || node.tags.length || node.visibility !== 'inherit') return fail();
  const payload = await tx.selectFrom('nodes').select('payload_json').where('collection_id', '=', command.collectionId).where('id', '=', node.id).executeTakeFirstOrThrow();
  if (Object.keys(payload.payload_json?.extensions ?? {}).length) return fail();
  const annotations = await tx.selectFrom('annotations').select('id').where('collection_id', '=', command.collectionId)
    .where('subject_id', '=', node.id).where('deleted_at', 'is', null).limit(1).execute();
  if (annotations.length) return fail();
  const relations = await tx.selectFrom('relations').select('id').where('collection_id', '=', command.collectionId)
    .where(eb => eb.or([eb('from_node_id', '=', node.id), eb('to_node_id', '=', node.id)])).where('deleted_at', 'is', null).limit(1).execute();
  if (relations.length) return fail();
  if (node.kind === 'folder') {
    if (!winner || winner.parentId !== command.parentId || node.parentId !== command.parentId || winner.url !== null) return fail();
    const child = await tx.selectFrom('nodes').select('id').where('collection_id', '=', command.collectionId)
      .where('parent_id', '=', node.id).where('deleted_at', 'is', null).limit(1).execute();
    if (child.length) return fail('source_convergence_pending');
  } else if (command.slot.kind === 'bookmark' && command.slot.copy.purpose === 'sourceArchive') {
    const copy = command.slot.copy, key = managedSlotKey(command.collectionId, { kind: 'folder', source: {
      site: copy.content.site, identityVersion: copy.content.identityVersion, sourceAccount: copy.sourceAccount, sourceCollectionId: copy.sourceCollectionId } });
    const row = (await sql<{ payload_json: ManagedBinding }>`SELECT payload_json FROM source_archive_managed_records
      WHERE account_id=${accountId} AND kind='bindings' AND record_hash=${recordHash(key)} AND record_key=${key}`.execute(tx)).rows[0];
    const parent = await nodes.getNode(command.collectionId, command.converge.fromParentId);
    if (!row || row.payload_json.state !== 'active' || row.payload_json.node.nodeId !== command.parentId || !parent
      || parent.deletedAt || parent.parentId !== row.payload_json.node.parentId || parent.title !== row.payload_json.node.title) return fail();
    if (winner && winner.parentId !== command.parentId) return fail();
  } else if (node.kind !== 'bookmark' || command.converge.fromParentId !== command.parentId) return fail();
  if (winner && (winner.deleted || winner.url !== node.url)) return fail();
  const ports = managedReconcilePorts(tx, subjectId, accountId);
  const expected = { nodeId: node.id, parentId: node.parentId!, title: node.title, url: node.url, revision: node.resourceRevision };
  const changed = await ports.mutate({ commandId: command.commandId, collectionId: command.collectionId, replicaId: command.replicaId,
    action: 'move', expected, slot: null, parentId: winner ? node.parentId! : command.parentId, title: node.title, retire: false }, !!winner);
  if (winner && command.copyPolicy === 'singlePreferSemantic' && command.slot.kind === 'bookmark' && command.slot.copy.purpose === 'semantic'
    && winnerSlot?.kind === 'bookmark' && winnerSlot.copy.purpose === 'sourceArchive' && winner.parentId !== command.parentId) {
    return ports.mutate({ commandId: command.commandId, collectionId: command.collectionId, replicaId: command.replicaId, action: 'move',
      expected: winner, slot: winnerSlot, parentId: command.parentId, title: winner.title, retire: false });
  }
  return winner ?? changed;
}
