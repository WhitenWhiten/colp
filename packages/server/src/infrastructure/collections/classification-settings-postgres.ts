import { sql, type Kysely } from 'kysely';
import {
  DEFAULT_CLASSIFICATION_SETTINGS, type ClassificationSettings, type ClassificationSettingsStore,
  type ClassificationSettingsUnitOfWork, ClassificationSettingsError,
} from '../../modules/collections/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';

export function createPostgresClassificationSettingsStore(db: DatabaseTransaction | Kysely<DatabaseSchema>, lock = false): ClassificationSettingsStore {
  return {
    async loadOwned(input) {
      let query = db.selectFrom('collections').select(['id', 'created_at'])
        .where('id', '=', input.collectionId).where('owner_subject_id', '=', input.ownerSubjectId).where('deleted_at', 'is', null);
      if (lock) query = query.forUpdate();
      const collection = await query.executeTakeFirst();
      if (!collection) return null;
      const row = await db.selectFrom('collection_classification_settings').selectAll().where('collection_id', '=', collection.id).executeTakeFirst();
      if (row && row.owner_subject_id !== input.ownerSubjectId) throw new ClassificationSettingsError('resource_not_found');
      return row ? toSettings(row) : {contractVersion: '1.0.0', collectionId: collection.id, ...DEFAULT_CLASSIFICATION_SETTINGS, revision: '0', updatedAt: collection.created_at.toISOString()};
    },
    async compareAndSet({ current, values, ownerSubjectId }) {
      if(values.providerProfileId!==null){
        const profile=await db.selectFrom('classification_provider_profiles').select('id').where('id','=',values.providerProfileId)
          .where('owner_subject_id','=',ownerSubjectId).where('status','=','active').where('secret_envelope','is not',null).forShare().executeTakeFirst();
        if(!profile)throw new ClassificationSettingsError('invalid_document');
      }
      const next = {collection_id: current.collectionId, owner_subject_id: ownerSubjectId,
        auto_tag_mode: values.autoTagMode, max_auto_tags: values.maxAutoTags,
        execution_mode: values.executionMode, provider_profile_id: values.providerProfileId,
        revision: BigInt(current.revision) + 1n, updated_at: new Date()};
      const row = current.revision === '0'
        ? await db.insertInto('collection_classification_settings').values(next).onConflict(c => c.column('collection_id').doNothing()).returningAll().executeTakeFirst()
        : await db.updateTable('collection_classification_settings').set({...next, updated_at: sql<Date>`greatest(now(), updated_at + interval '1 millisecond')`})
          .where('collection_id', '=', current.collectionId).where('owner_subject_id', '=', ownerSubjectId).where('revision', '=', BigInt(current.revision)).returningAll().executeTakeFirst();
      return row ? toSettings(row) : null;
    },
  };
}

function toSettings(row: DatabaseSchema['collection_classification_settings']): ClassificationSettings {
  return {contractVersion: '1.0.0', collectionId: row.collection_id, autoTagMode: row.auto_tag_mode, maxAutoTags: row.max_auto_tags,
    executionMode: row.execution_mode, providerProfileId: row.provider_profile_id, revision: String(row.revision), updatedAt: row.updated_at.toISOString()};
}

export function createPostgresClassificationSettingsUnitOfWork(db: Kysely<DatabaseSchema>): ClassificationSettingsUnitOfWork {
  const unit = createUnitOfWork(db);
  return {execute: work => unit.execute(({transaction}) => work({
    settings: createPostgresClassificationSettingsStore(transaction, true), receipts: createPostgresProductCommandReceiptPort(transaction),
  }))};
}

export function createPostgresClassificationSettingsRuntime(db: Kysely<DatabaseSchema>) {
  const reads = createUnitOfWork(db, {isolationLevel: 'repeatable read'});
  return {commands: createPostgresClassificationSettingsUnitOfWork(db),
    reads: {loadOwned: (input: Parameters<ClassificationSettingsStore['loadOwned']>[0]) =>
      reads.execute(({transaction}) => createPostgresClassificationSettingsStore(transaction).loadOwned(input))}};
}
