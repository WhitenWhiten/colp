import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { ownerAuthoredNote } from './automation-notes.js';

/** The Owner's own bounded note set, used for initial pins and every current-input check; automation notes are excluded. */
export function readWorkerNotes(tx: DatabaseTransaction,ownerId: string,collectionId: string,nodeId: string) {
  return tx.selectFrom('annotations').select(['id','resource_revision','payload_json'])
    .where('collection_id','=',collectionId).where('subject_type','=','node').where('subject_id','=',nodeId)
    .where('creator_principal_id','=',ownerId).where('visibility','=','private').where('deleted_at','is',null)
    .where(sql<string>`payload_json->>'type'`,'=','note').where(ownerAuthoredNote).orderBy('id').limit(2).execute();
}
