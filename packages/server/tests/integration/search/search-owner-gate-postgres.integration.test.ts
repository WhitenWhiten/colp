import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import { parseGovernanceTarget, targetFingerprint } from '../../../src/modules/governance/domain/moderation.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * MRS-01 follow-up: public discovery eligibility must not require the collection
 * owner to have a live `accounts` row. `collections.owner_subject_id` is
 * intentionally not a foreign key, so a missing owner row is a legal state and
 * must stay discoverable; an owner row that exists but is non-active,
 * soft-deleted or publication-restricted still delists the collection.
 */
describeWithPostgres('public search discovery owner gate', () => {
  let isolated: IsolatedPostgresRuntime;

  async function seedPublicCollection(id: string, ownerSubjectId: string): Promise<void> {
    const root = `${id}-root`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        values($1,'collection'),($2,'node')`, [id, root]);
      await client.query(`insert into collections(id,owner_subject_id,title,summary,kind,visibility,
        allow_search_indexing,publication_slug,published_at,root_node_id,resource_revision,content_revision,policy_revision)
        values($1,$2,'ownergateneedle','ownergateneedle','bookmarks','public',true,$1,current_timestamp,$3,'r1','c1','policy-1')`,
      [id, ownerSubjectId, root]);
      await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values($1,$2,'folder',true,'Root','r1','ch1')`, [root, id]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_owner_gate', {
      maxConnections: 2, applicationName: 'known-search-owner-gate',
    });
    const result = await createMigrator(isolated.runtime.db, undefined, isolated.schema).migrateToLatest();
    if (result.error) throw result.error;

    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status,security_epoch)
      values('gate-active','gate-subject-active','active',1),
        ('gate-disabled','gate-subject-disabled','disabled',1),
        ('gate-restricted','gate-subject-restricted','active',1)`);
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status,security_epoch,deleted_at)
      values('gate-deleted','gate-subject-deleted','deleted',1,now())`);

    // No accounts row at all for gate-subject-missing.
    await seedPublicCollection('gate-owner-missing', 'gate-subject-missing');
    await seedPublicCollection('gate-owner-active', 'gate-subject-active');
    await seedPublicCollection('gate-owner-disabled', 'gate-subject-disabled');
    await seedPublicCollection('gate-owner-deleted', 'gate-subject-deleted');
    await seedPublicCollection('gate-owner-restricted', 'gate-subject-restricted');

    const target = parseGovernanceTarget({ kind: 'account', id: 'gate-restricted' });
    const targetJson = JSON.stringify(target), fingerprint = targetFingerprint(target);
    await isolated.runtime.pool.query(`insert into moderation_cases(id,reporter_account_id,target_kind,target_id,target_json,target_fingerprint,category,description,status,revision,created_at,updated_at)
      values('gate-case','gate-active',$1,$2,$3::jsonb,$4,'privacy','owner gate','resolved','1',now(),now())`,
    [target.kind, target.id, targetJson, fingerprint]);
    await isolated.runtime.pool.query(`insert into moderation_actions(id,case_id,target_kind,target_id,parent_id,target_json,target_fingerprint,action,reason,actor_account_id,state,revision,created_at)
      values('gate-case','gate-case',$1,$2,null,$3::jsonb,$4,'restrict_publication','owner gate','gate-active','active','1',now())`,
    [target.kind, target.id, targetJson, fingerprint]);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('a missing owner account stays discoverable while deactivated and restricted owners stay delisted', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    const page = await candidates.listCandidates({
      query: 'ownergateneedle', types: ['collection'], projection: { kind: 'anonymous' }, limit: 50, timeoutMs: 5_000,
    });
    assert.deepEqual(
      [...page.items.map((item) => item.resourceId)].sort(),
      ['gate-owner-active', 'gate-owner-missing'],
    );
  });
});
