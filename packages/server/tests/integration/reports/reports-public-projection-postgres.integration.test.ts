import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresReportUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import {
  attachDigestEdition,
  createDigestSeries,
  getPublicReportIssue,
  getPublicReportSeries,
  listPublicReportDirectory,
  listPublicReportIssues,
  publishDigestEdition,
} from '../../../src/modules/reports/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * A small end-to-end persistence check for the report authority boundary.
 * Unlike the unit projection tests, this exercises the real source adapter,
 * receipt store, report writes, and PostgreSQL visibility changes together.
 */
describeWithPostgres('reports public projection PostgreSQL authority', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('reports_public_projection', {
      maxConnections: 8,
      applicationName: 'known-test-reports-public-projection',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('creates, attaches, publishes, replays, and conceals an invalidated source', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const ownerSubject = `reports-owner-${suffix}`;
    const ownerAccount = `reports-account-${suffix}`;
    const sourceCollectionId = `reports-source-${suffix}`;
    const sourceRootId = `reports-source-root-${suffix}`;
    const reportSlug = `reports-${suffix}`;
    const actor = { principalId: ownerSubject, subjectId: ownerSubject };

    await seedOwnerAndSource({
      ownerAccount,
      ownerSubject,
      sourceCollectionId,
      sourceRootId,
      sourceSlug: `source-${suffix}`,
    });

    const unit = createPostgresReportUnitOfWork(isolated.runtime.db);
    const createInput = {
      actor,
      commandId: randomUUID(),
      title: 'PostgreSQL authority report',
      summary: 'A persisted public report.',
      slug: reportSlug,
      visibility: 'public' as const,
      allowSearchIndexing: true,
    };
    const created = await createDigestSeries(unit, createInput);
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;

    const replay = await createDigestSeries(unit, createInput);
    assert.equal(replay.kind, 'replay');
    const reportCount = await isolated.runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from digest_series where id = $1',
      [created.value.id],
    );
    assert.equal(reportCount.rows[0]?.count, '1');

    const attached = await attachDigestEdition(unit, {
      actor,
      commandId: randomUUID(),
      seriesId: created.value.id,
      sourceCollectionId,
      issueKey: `issue-${suffix}`,
      titleSnapshot: 'Persisted issue',
      summarySnapshot: 'Issue body summary.',
    });
    assert.equal(attached.kind, 'succeeded');
    if (attached.kind !== 'succeeded') return;

    const published = await publishDigestEdition(unit, {
      actor,
      commandId: randomUUID(),
      seriesId: created.value.id,
      editionId: attached.value.id,
      expectedRevision: `"${attached.value.resourceRevision}"`,
    });
    assert.equal(published.kind, 'succeeded');

    // Accumulated private history must not consume the public projection page.
    // One bulk insert keeps the regression evidence fast while crossing the old
    // 2,001-row failure boundary with real PostgreSQL constraints and indexes.
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       select $1 || value::text, 'digest_edition', current_timestamp
         from generate_series(1, 2001) value`,
      [`reports-draft-${suffix}-`],
    );
    await isolated.runtime.pool.query(
      `insert into digest_editions(
         id, series_id, source_collection_id, issue_key, edition_ordinal,
         title_snapshot, summary_snapshot, source_content_revision,
         source_policy_revision, resource_revision, period_start, period_end,
         state, published_at, created_at, updated_at, withdrawn_at, detached_at)
       select $1 || value::text, $2, $3, 'draft-' || value::text, value + 1,
              'Unpublished draft', null, 'source-content-1', null,
              'draft-revision-' || value::text, null, null,
              'draft', null, current_timestamp, current_timestamp, null, null
         from generate_series(1, 2001) value`,
      [`reports-draft-${suffix}-`, created.value.id, sourceCollectionId],
    );

    const projected = await getPublicReportSeries(unit, reportSlug);
    assert.ok(projected);
    assert.equal(projected.slug, reportSlug);
    assert.equal(projected.indexable, true);
    assert.deepEqual(projected.issues.map((issue) => issue.id), [attached.value.id]);
    assert.equal('sourceCollectionId' in projected.issues[0]!, false);
    assert.match(projected.issues[0]!.url, new RegExp(`/reports/${reportSlug}/issues/`, 'u'));
    const direct = await getPublicReportIssue(unit, reportSlug, attached.value.id);
    assert.equal(direct?.issue.id, attached.value.id);
    const directory = await listPublicReportDirectory(unit, {
      active: { id: 'test', secret: Buffer.alloc(32, 17).toString('base64') },
    }, 10);
    assert.equal(directory.items.some((item) => item.id === created.value.id), true);
    const issuePage = await listPublicReportIssues(unit, reportSlug, {
      active: { id: 'test', secret: Buffer.alloc(32, 19).toString('base64') },
    }, 10);
    assert.deepEqual(issuePage?.items.map((issue) => issue.id), [attached.value.id]);

    await isolated.runtime.pool.query(
      `update collections
          set visibility = 'private', policy_revision = $2,
              updated_at = current_timestamp
        where id = $1`,
      [sourceCollectionId, `revoked-${suffix}`],
    );

    const concealed = await getPublicReportSeries(unit, reportSlug);
    assert.ok(concealed);
    assert.equal(concealed.indexable, false);
    assert.deepEqual(concealed.issues, []);

    const receipt = await isolated.runtime.pool.query<{
      result_status: number | null;
      result_headers: Record<string, string> | null;
    }>(
      `select result_status, result_headers
         from product_command_receipts
        where principal_id = $1 and command_scope = 'reports.series.create'
          and command_id = $2`,
      [ownerSubject, createInput.commandId],
    );
    assert.equal(receipt.rows[0]?.result_status, 201);
    assert.equal(receipt.rows[0]?.result_headers?.['cache-control'], 'private, no-store');
    assert.equal(typeof receipt.rows[0]?.result_headers?.etag, 'string');
  }, 60_000);

  test('all public surfaces check the source of an edition beyond the displayed page', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const good = `index-good-${suffix}`;
    const bad = `index-bad-${suffix}`;
    const ownerSubject = `index-owner-${suffix}`;
    for (const [id, subject] of [[good, ownerSubject], [bad, `${ownerSubject}-bad`]]) {
      await seedOwnerAndSource({ ownerAccount: `${id}-account`, ownerSubject: subject!,
        sourceCollectionId: id!, sourceRootId: `${id}-root`, sourceSlug: id! });
    }
    const unit = createPostgresReportUnitOfWork(isolated.runtime.db);
    const created = await createDigestSeries(unit, { actor: { principalId: ownerSubject, subjectId: ownerSubject },
      commandId: randomUUID(), title: 'Index policy across pages', summary: null, slug: `index-${suffix}`,
      visibility: 'public', allowSearchIndexing: true });
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    const prefix = `index-edition-${suffix}-`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      select $1 || n::text, 'digest_edition', current_timestamp from generate_series(1,201) n`, [prefix]);
    await isolated.runtime.pool.query(`insert into digest_editions(id,series_id,source_collection_id,issue_key,
      edition_ordinal,title_snapshot,source_content_revision,resource_revision,state,published_at)
      select $1 || n::text,$2,case when n=1 then $3 else $4 end,'issue-' || n::text,n,
        'Issue','content-1','revision-' || n::text,'published',current_timestamp
      from generate_series(1,201) n`, [prefix, created.value.id, bad, good]);
    const read = async () => {
      const series = await getPublicReportSeries(unit, `index-${suffix}`);
      const direct = await getPublicReportIssue(unit, `index-${suffix}`, `${prefix}201`);
      const directory = await listPublicReportDirectory(unit,
        { active: { id: 'test', secret: Buffer.alloc(32, 17).toString('base64') } }, 100);
      return [series?.indexable, direct?.series.indexable,
        directory.items.find(item => item.id === created.value.id)?.indexable];
    };
    assert.deepEqual(await read(), [true, true, true]);
    await isolated.runtime.pool.query('update collections set allow_search_indexing=false where id=$1', [bad]);
    assert.deepEqual(await read(), [false, false, false]);
    await isolated.runtime.pool.query('update collections set allow_search_indexing=true where id=$1', [bad]);
    assert.deepEqual(await read(), [true, true, true]);
    // The newest 200 candidates becoming private must not hide the older,
    // still-public source from the directory's initial batch of 100.
    await isolated.runtime.pool.query("update collections set visibility='private' where id=$1", [good]);
    const directory = await listPublicReportDirectory(unit,
      { active: { id: 'test', secret: Buffer.alloc(32, 17).toString('base64') } }, 100);
    const item = directory.items.find(candidate => candidate.id === created.value.id);
    assert.deepEqual(item?.issues.map(issue => issue.id), [`${prefix}1`]);
    assert.equal(item?.sourceCollectionSlug, bad);
  });

  test('source authorization keeps unlisted and deleted-account boundaries closed', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const ownerSubject = `source-owner-${suffix}`;
    const ownerAccount = `source-account-${suffix}`;
    const sourceCollectionId = `source-boundary-${suffix}`;
    const sourceRootId = `source-boundary-root-${suffix}`;
    const foreignSubject = `source-foreign-${suffix}`;
    await seedOwnerAndSource({
      ownerAccount,
      ownerSubject,
      sourceCollectionId,
      sourceRootId,
      sourceSlug: `source-boundary-${suffix}`,
    });
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status) values ($1, $2, 'active')`,
      [`${ownerAccount}-foreign`, foreignSubject],
    );
    await isolated.runtime.pool.query(
      `update collections set visibility = 'unlisted' where id = $1`,
      [sourceCollectionId],
    );
    const unit = createPostgresReportUnitOfWork(isolated.runtime.db);
    const foreign = await unit.execute((ports) =>
      ports.source.getForActor!(
        sourceCollectionId, { subjectId: foreignSubject },
      ));
    assert.equal(foreign.verdict, 'not_public');
    const owner = await unit.execute((ports) =>
      ports.source.getForActor!(
        sourceCollectionId, { subjectId: ownerSubject },
      ));
    assert.equal(owner.verdict, 'authorized');

    await isolated.runtime.pool.query(
      `update accounts set status = 'active', deleted_at = current_timestamp where id = $1`,
      [ownerAccount],
    );
    const facts = await unit.execute((ports) => ports.source.get(sourceCollectionId));
    assert.equal(facts?.ownerAccountActive, false);
    const deletedOwner = await unit.execute((ports) =>
      ports.source.getForActor!(
        sourceCollectionId, { subjectId: ownerSubject },
      ));
    assert.equal(deletedOwner.verdict, 'not_found');
  }, 60_000);

  async function seedOwnerAndSource(input: {
    readonly ownerAccount: string;
    readonly ownerSubject: string;
    readonly sourceCollectionId: string;
    readonly sourceRootId: string;
    readonly sourceSlug: string;
  }): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into accounts(id, subject_id, status)
         values ($1, $2, 'active')`,
        [input.ownerAccount, input.ownerSubject],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type, committed_at)
         values ($1, 'collection', current_timestamp),
                ($2, 'node', current_timestamp)`,
        [input.sourceCollectionId, input.sourceRootId],
      );
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, allow_search_indexing,
           publication_slug, published_at, root_node_id, root_node_is_root,
           resource_revision, content_revision, policy_revision, commit_ordinal,
           created_at, updated_at, deleted_at)
         values ($1, $2, 'Persisted source', 'bookmarks', 'public', true,
                 $3, current_timestamp, $4, true,
                 'source-resource-1', 'source-content-1', 'source-policy-1', 1,
                 current_timestamp, current_timestamp, null)`,
        [input.sourceCollectionId, input.ownerSubject, input.sourceSlug, input.sourceRootId],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url,
           position_token, resource_revision, children_revision,
           created_at, updated_at, deleted_at)
         values ($1, $2, null, 'folder', true, 'Persisted source root', null,
                 null, 'source-root-resource-1', 'source-root-children-1',
                 current_timestamp, current_timestamp, null)`,
        [input.sourceRootId, input.sourceCollectionId],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});
