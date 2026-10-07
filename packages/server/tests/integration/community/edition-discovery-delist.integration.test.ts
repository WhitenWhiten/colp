import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import {
  createPostgresCommunityRankingQueryUnitOfWork,
  createPostgresCommunityRankingRefreshUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { resolveCommunityTargetRows } from '../../../src/infrastructure/community/community-target-batch-postgres.js';
import { resolveCommunityTargetRow } from '../../../src/infrastructure/community/community-target-shared-postgres.js';
import {
  listPublishedEditions,
  listPublishedEditionsBySeries,
} from '../../../src/infrastructure/reports/report-edition-public-read.js';
import {
  createCommunityRankingCursorCodec,
  listCommunityRanking,
  parseCommunityRankingQuery,
  refreshCommunityRanking,
  type CommunityTargetQuery,
} from '../../../src/modules/community/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * P1-3: a delist-only edition stays directly readable, but it is not a hot
 * candidate and is not served back from a snapshot that already listed it.
 * Hide conceals every surface. Series and source gates stay in force.
 */
describeWithPostgres('edition discovery delist predicate', () => {
  let isolated: IsolatedPostgresRuntime;
  const ownerAccountId = 'p13-owner';
  const ownerSubjectId = 'p13-subject';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('edition_discovery_delist', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status) values ($1,$2,'active')`,
      [ownerAccountId, ownerSubjectId],
    );
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedCollection(collectionId: string, slug: string): Promise<void> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId],
      );
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,'Source','bookmarks','public',$4,current_timestamp,$3,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, rootId, slug]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedSeries(seriesId: string, slug: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'report',current_timestamp)`, [seriesId]);
      await client.query(`insert into digest_series(
        id,owner_subject_id,title,summary,slug,visibility,state,
        resource_revision,content_revision,policy_revision,commit_ordinal,
        created_at,updated_at)
        values($1,$2,'Digest','Weekly',$3,'public','active',
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [seriesId, ownerSubjectId, slug]);
      await client.query(`insert into digest_members(series_id,subject_id,role,granted_at)
        values($1,$2,'owner',current_timestamp)`, [seriesId, ownerSubjectId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedEdition(editionId: string, seriesId: string, sourceId: string, title: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'report',current_timestamp)`, [editionId]);
      await client.query(`insert into digest_editions(
        id,series_id,source_collection_id,issue_key,edition_ordinal,
        title_snapshot,summary_snapshot,source_content_revision,source_policy_revision,
        resource_revision,period_start,period_end,state,published_at,created_at,updated_at)
        values($1,$2,$3,$4,1,$5,'Summary','c1','p1','r1',
          current_timestamp - interval '7 days',current_timestamp,'published',current_timestamp,
          current_timestamp,current_timestamp)`,
      [editionId, seriesId, sourceId, `issue-${editionId}`, title]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function moderate(
    targetKind: 'digest_edition' | 'digest_series',
    targetId: string,
    parentId: string | null,
    action: 'delist' | 'hide_public',
  ): Promise<void> {
    const caseId = `case_${randomUUID()}`;
    const actionId = `act_${randomUUID()}`;
    const fingerprint = `${targetKind}:${targetId}:${actionId}`;
    const targetJson = JSON.stringify({ kind: targetKind, id: targetId, ...(parentId ? { seriesId: parentId } : {}) });
    await isolated.runtime.pool.query(
      `insert into moderation_cases (
         id, reporter_account_id, target_kind, target_id, parent_id, target_json, target_fingerprint,
         category, description, status, revision, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,'spam','fixture','in_review','1',current_timestamp,current_timestamp)`,
      [caseId, ownerAccountId, targetKind, targetId, parentId, targetJson, fingerprint],
    );
    await isolated.runtime.pool.query(
      `insert into moderation_actions (
         id, case_id, target_kind, target_id, parent_id, target_json, target_fingerprint, action, reason,
         actor_account_id, state, revision, created_at, owner_account_id)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'official fixture',$9,'active','1',current_timestamp,$9)`,
      [actionId, caseId, targetKind, targetId, parentId, targetJson, fingerprint, action, ownerAccountId],
    );
  }

  async function refresh(): Promise<void> {
    await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
      .execute((ports) => refreshCommunityRanking(ports));
  }

  async function rankedEditionIds(): Promise<readonly string[]> {
    const page = await createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db)
      .execute((ports) => listCommunityRanking(ports, {
        viewer: { accountId: null, subjectId: null },
        query: parseCommunityRankingQuery({ kind: 'digest_edition', limit: '20' }),
        cursorCodec: createCommunityRankingCursorCodec(Buffer.alloc(32, 11)),
      }));
    return page.items.map((item) => item.target.id);
  }

  async function snapshotEditionIds(): Promise<readonly string[]> {
    const rows = await isolated.runtime.pool.query<{ target_id: string }>(
      `select target_id from community_rank_entries
        where snapshot_id = (select max(snapshot_id) from community_rank_snapshots)
          and target_kind = 'digest_edition'`,
    );
    return rows.rows.map((row) => row.target_id);
  }

  async function resolveEdition(seriesId: string, editionId: string) {
    const query: CommunityTargetQuery = { kind: 'digest_edition', id: editionId, seriesId };
    return createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const direct = await resolveCommunityTargetRow(transaction, query, 'none', 'direct');
      const discovery = await resolveCommunityTargetRow(transaction, query, 'none', 'discovery');
      const batch = await resolveCommunityTargetRows(transaction, [query], 'discovery');
      const issuePage = await listPublishedEditions(transaction, seriesId, 20, undefined, true);
      const storedPage = await listPublishedEditions(transaction, seriesId, 20, undefined, false);
      const directory = await listPublishedEditionsBySeries(transaction, [seriesId], 20, true);
      return {
        direct,
        discovery,
        batch: batch[0] ?? null,
        issueIds: issuePage.map((edition) => edition.id),
        storedIds: storedPage.map((edition) => edition.id),
        directoryIds: (directory.get(seriesId) ?? []).map((edition) => edition.id),
      };
    });
  }

  test('delist-only edition leaves discovery and an old hot board, and hide conceals direct access', async () => {
    const sourceA = 'p13-source-a';
    const seriesA = 'p13-series-a';
    const editionA = 'p13-edition-a';
    const sourceB = 'p13-source-b';
    const seriesB = 'p13-series-b';
    const editionB = 'p13-edition-b';
    await seedCollection(sourceA, sourceA);
    await seedCollection(sourceB, sourceB);
    await seedSeries(seriesA, seriesA);
    await seedSeries(seriesB, seriesB);
    await seedEdition(editionA, seriesA, sourceA, 'Edition A');
    await seedEdition(editionB, seriesB, sourceB, 'Edition B');

    await refresh();
    assert.ok((await snapshotEditionIds()).includes(editionA));
    assert.ok((await rankedEditionIds()).includes(editionA));
    const before = await resolveEdition(seriesA, editionA);
    assert.equal(before.direct?.title, 'Edition A');
    assert.equal(before.direct?.href, `/reports/${seriesA}/issues/${editionA}`);
    assert.equal(before.discovery?.title, 'Edition A');
    assert.equal(before.batch?.title, 'Edition A');
    assert.ok(before.issueIds.includes(editionA));
    assert.ok(before.directoryIds.includes(editionA));

    await moderate('digest_edition', editionA, seriesA, 'delist');
    assert.ok((await snapshotEditionIds()).includes(editionA), 'the old snapshot row is still stored');
    assert.equal((await rankedEditionIds()).includes(editionA), false, 'old board re-read drops delist');
    const delisted = await resolveEdition(seriesA, editionA);
    assert.equal(delisted.direct?.title, 'Edition A');
    assert.equal(delisted.direct?.href, `/reports/${seriesA}/issues/${editionA}`);
    assert.equal(delisted.discovery, null);
    assert.equal(delisted.batch, null);
    assert.equal(delisted.issueIds.includes(editionA), false);
    assert.equal(delisted.directoryIds.includes(editionA), false);
    assert.ok(delisted.storedIds.includes(editionA), 'non-discovery reads still see a delist-only edition');

    await refresh();
    assert.equal((await snapshotEditionIds()).includes(editionA), false, 'delist is not a new candidate');
    assert.ok((await snapshotEditionIds()).includes(editionB));

    await moderate('digest_edition', editionA, seriesA, 'hide_public');
    const hidden = await resolveEdition(seriesA, editionA);
    assert.equal(hidden.direct, null);
    assert.equal(hidden.discovery, null);
    assert.equal(hidden.batch, null);
    assert.ok(hidden.issueIds.includes(editionA), 'hide stays on the issue page so it can be tombstoned');
    assert.equal(hidden.directoryIds.includes(editionA), false);
    assert.equal((await rankedEditionIds()).includes(editionA), false);

    await isolated.runtime.pool.query(`update collections set visibility = 'private' where id = $1`, [sourceB]);
    const privateSource = await resolveEdition(seriesB, editionB);
    assert.equal(privateSource.direct, null);
    assert.equal(privateSource.discovery, null);
    await refresh();
    assert.equal((await snapshotEditionIds()).includes(editionB), false, 'a private source leaves the candidate set');

    await isolated.runtime.pool.query(`update collections set visibility = 'public' where id = $1`, [sourceB]);
    await refresh();
    assert.ok((await snapshotEditionIds()).includes(editionB));
    await moderate('digest_series', seriesB, null, 'delist');
    const seriesDelisted = await resolveEdition(seriesB, editionB);
    assert.equal(seriesDelisted.direct?.title, 'Edition B');
    assert.equal(seriesDelisted.discovery, null);
    assert.equal(seriesDelisted.batch, null);
    await refresh();
    assert.equal((await snapshotEditionIds()).includes(editionB), false, 'series delist still drops the edition');
    assert.equal((await rankedEditionIds()).includes(editionB), false);
  }, 60_000);
});
