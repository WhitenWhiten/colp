import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, type PostgresCanonicalMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import {
  ANNOTATION_DELETED_EVENT_TYPE,
  NODE_DELETED_EVENT_TYPE,
  RELATION_DELETED_EVENT_TYPE,
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import { SOCIAL_COLLECTION_CHANGE_EVENT_TYPE } from '../../../src/infrastructure/outbox/social-collection-change.js';
import type { SocialCollectionChangeRouteFaultInjector } from '../../../src/infrastructure/outbox/social-collection-change.js';
import { PUBLICATION_CACHE_PURGE_EVENT_TYPE } from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import { registerSyncPushRoutes, SyncPushHttpError } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'r17-root';
const TARGET_ID = 'r17-subtree-target';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const SEED_TS = '2026-01-02T03:04:05Z';
const PUSH_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PUSH_TOKEN = 'r17-push-secret-token';

interface TracedStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  elapsedMs: number;
}

interface StageCounts {
  readonly route_lookup: number;
  readonly id_reserve: number;
  readonly primary_outbox: number;
  readonly social_outbox: number;
  readonly publication_purge: number;
  readonly sidecar_cascade: number;
  readonly total: number;
}

interface OutboxPhaseMeasurement {
  readonly published: boolean;
  readonly nodes: number;
  readonly annotations: number;
  readonly relations: number;
  readonly statements: StageCounts;
  readonly outboxRows: ReadonlyMap<string, number>;
  readonly resourceBatches: { readonly node: number; readonly annotation: number; readonly relation: number };
  readonly outboxPhaseElapsedMs: number;
  readonly socialStageElapsedMs: number;
}

function isRouteSelect(sql: string): boolean {
  return !/left join/iu.test(sql)
    && (/from "collections"/iu.test(sql) || /from "nodes"/iu.test(sql) || /from "children_revisions"/iu.test(sql));
}

function isSocialSelect(sql: string): boolean {
  return /left join/iu.test(sql) || /select current_timestamp/iu.test(sql);
}

/** The self-hosted edition removes the feed and public activity handlers. */
const SOCIAL_COLLECTION_CHANGE_HANDLER_ROWS = 0;

/**
 * Analytical classification of the observed outbox-phase SQL slice into the
 * separately-recorded stages required by R17. This is NOT a mirror of any
 * production algorithm: it buckets captured statements by their ordered
 * position relative to the primary/social/purge outbox_events inserts.
 * Social is two handler rows (collection-change + public-activity) sharing one
 * domain event; both stay in social_outbox, not sidecar_cascade.
 */
function classifyOutboxSlice(slice: readonly TracedStatement[], published: boolean): StageCounts {
  const inserts: number[] = [];
  const reserves: number[] = [];
  const others: number[] = [];
  slice.forEach((entry, index) => {
    if (/insert into "outbox_events"/iu.test(entry.sql)) inserts.push(index);
    else if (/insert into "resource_id_ledger"/iu.test(entry.sql)) reserves.push(index);
    else others.push(index);
  });
  assert.ok(inserts.length >= 1 + SOCIAL_COLLECTION_CHANGE_HANDLER_ROWS,
    `outbox slice must contain primary + ${SOCIAL_COLLECTION_CHANGE_HANDLER_ROWS} social handler inserts, got ${inserts.length}`);
  const lastSocialInsertIndex = inserts[SOCIAL_COLLECTION_CHANGE_HANDLER_ROWS]!;
  const purgeInsertIndex = published ? inserts[1 + SOCIAL_COLLECTION_CHANGE_HANDLER_ROWS] : undefined;
  if (published) {
    assert.ok(purgeInsertIndex !== undefined,
      'published outbox slice must include the publication purge insert after both social handlers');
  }
  const sidecarStart = (purgeInsertIndex ?? lastSocialInsertIndex) + 1;
  const routeLookup = others.filter((index) => isRouteSelect(slice[index]!.sql)).length;
  const socialSelects = others.filter((index) => isSocialSelect(slice[index]!.sql)).length;
  assert.equal(others.length, routeLookup + socialSelects,
    `unclassified outbox statements: ${others.map((index) => slice[index]!.sql).join(' | ')}`);
  const idReserve = reserves.filter((index) => index < inserts[0]!).length;
  const primaryOutbox = 1;
  const socialOutbox = lastSocialInsertIndex - inserts[0]!;
  const publicationPurge = purgeInsertIndex === undefined ? 0 : purgeInsertIndex - lastSocialInsertIndex;
  const sidecarCascade = Math.max(0, slice.length - sidecarStart);
  return {
    route_lookup: routeLookup,
    id_reserve: idReserve,
    primary_outbox: primaryOutbox,
    social_outbox: socialOutbox,
    publication_purge: publicationPurge,
    sidecar_cascade: sidecarCascade,
    total: slice.length,
  };
}

describeWithPostgres('R17 outbox and JSON serialization performance evidence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('r17_outbox_serialization', {
      maxConnections: 6,
      applicationName: 'known-r17-outbox-serialization-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  async function resetFixture(options: { readonly published?: boolean } = {}): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          sync_node_revision_history, relations, annotations, collection_policies,
          collection_members, nodes, collections, resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'R17 owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node')`,
        [COLLECTION_ID, ROOT_ID],
      );
      if (options.published) {
        await client.query(
          `insert into collections (
             id, owner_subject_id, title, summary, kind, visibility, root_node_id,
             resource_revision, content_revision, policy_revision, commit_ordinal,
             publication_slug, published_at
           ) values ($1, $2, 'R17 published', null, 'bookmarks', 'unlisted', $3,
             'collection-r1', 'content-r1', 'policy-r1', 1, $4, $5::timestamptz)`,
          [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID, 'r17-published', SEED_TS],
        );
      } else {
        await client.query(
          `insert into collections (
             id, owner_subject_id, title, summary, kind, visibility, root_node_id,
             resource_revision, content_revision, policy_revision, commit_ordinal
           ) values ($1, $2, 'R17', null, 'bookmarks', 'private', $3, 'collection-r1', 'content-r1', 'policy-r1', 1)`,
          [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
        );
      }
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values (
           $1, $2, null, 'folder', true, 'R17 root', null, null, '[]'::jsonb,
           'inherit', null, 'r17-root-r1', 'r17-root-children-r1'
         )`,
        [ROOT_ID, COLLECTION_ID],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await materializeRows('collections', [COLLECTION_ID]);
    await materializeRows('nodes', [ROOT_ID]);
  }

  async function materializeRows(table: 'collections' | 'nodes', ids: readonly string[]): Promise<void> {
    const rows = await isolated.runtime.pool.query(
      `select * from ${table} where id = any($1::text[])`,
      [ids],
    );
    assert.equal(rows.rowCount, ids.length);
    for (const row of rows.rows) {
      if (table === 'collections') {
        const materialized = materializeCollectionPayload({
          id: row.id,
          ownerSubjectId: row.owner_subject_id,
          title: row.title,
          summary: row.summary,
          kind: row.kind,
          visibility: row.visibility,
          rootNodeId: row.root_node_id,
          resourceRevision: row.resource_revision,
          contentRevision: row.content_revision,
          policyRevision: row.policy_revision,
          commitOrdinal: row.commit_ordinal,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        });
        assert.equal(materialized.ok, true);
        if (!materialized.ok) throw new Error('collection materialization failed');
        await isolated.runtime.pool.query(
          `update collections
             set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
           where id = $1`,
          [row.id, JSON.stringify(materialized.payload)],
        );
      } else {
        const materialized = materializeNodePayload({
          id: row.id,
          collectionId: row.collection_id,
          parentId: row.parent_id,
          kind: row.kind,
          isRoot: row.is_root,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: row.tags,
          visibility: row.visibility,
          positionToken: row.position_token,
          resourceRevision: row.resource_revision,
          childrenRevision: row.children_revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
          deletedCommitOrdinal: row.deleted_commit_ordinal,
        });
        assert.equal(materialized.ok, true);
        if (!materialized.ok) throw new Error('node materialization failed');
        await isolated.runtime.pool.query(
          `update nodes
             set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
           where id = $1`,
          [row.id, JSON.stringify(materialized.payload)],
        );
      }
    }
  }

  /** target folder + (totalNodes - 1) bookmark children; returns [target, ...children]. */
  async function insertFlatSubtree(totalNodes: number): Promise<readonly string[]> {
    assert.ok(totalNodes >= 1);
    const childCount = totalNodes - 1;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [TARGET_ID],
    );
    await isolated.runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values (
         $1, $2, $3, 'folder', false, 'R17 target', null, null, '[]'::jsonb,
         'inherit', 'zz-r17-target', 'r17-target-rev', 'r17-target-children-rev'
       )`,
      [TARGET_ID, COLLECTION_ID, ROOT_ID],
    );
    if (childCount > 0) {
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         select 'r17-node-' || lpad(series::text, 4, '0'), 'node'
         from generate_series(1, $1::integer) series`,
        [childCount],
      );
      await isolated.runtime.pool.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         )
         select 'r17-node-' || lpad(series::text, 4, '0'), $2, $3,
           'bookmark', false, 'R17 node ' || series::text,
           'https://example.test/r17/' || series::text, null, '[]'::jsonb,
           'inherit', lpad(series::text, 8, '0'),
           'r17-node-rev-' || series::text, 'r17-node-children-rev-' || series::text
         from generate_series(1, $1::integer) series`,
        [childCount, COLLECTION_ID, TARGET_ID],
      );
    }
    const ids = [
      TARGET_ID,
      ...Array.from({ length: childCount }, (_, index) => `r17-node-${String(index + 1).padStart(4, '0')}`),
    ];
    await materializeRows('nodes', ids);
    return ids;
  }

  /** Annotation n is attached to node 'r17-node-{n}' with revision 'r17-annotation-rev-{n}'. */
  async function insertAnnotations(count: number): Promise<readonly string[]> {
    assert.ok(count >= 1);
    const ids = Array.from({ length: count }, (_, index) => `r17-annotation-${String(index + 1).padStart(4, '0')}`);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'r17-annotation-' || lpad(series::text, 4, '0'), 'annotation'
       from generate_series(1, $1::integer) series`,
      [count],
    );
    await isolated.runtime.pool.query(
      `insert into annotations (
         id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
         visibility, resource_revision, created_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status
       )
       select
         'r17-annotation-' || lpad(series::text, 4, '0'), $2::text, 'node',
         'r17-node-' || lpad(series::text, 4, '0'), $3::text,
         'note', 'plain', jsonb_build_object('text', 'R17 note ' || series::text),
         'private', 'r17-annotation-rev-' || series::text, $4::timestamptz, $4::timestamptz,
         jsonb_build_object(
           'id', 'r17-annotation-' || lpad(series::text, 4, '0'),
           'collectionId', $2,
           'subject', jsonb_build_object('type', 'node', 'id', 'r17-node-' || lpad(series::text, 4, '0')),
           'creator', jsonb_build_object('type', 'account', 'id', $3),
           'type', 'note', 'format', 'plain',
           'value', jsonb_build_object('text', 'R17 note ' || series::text),
           'visibility', 'private',
           'revision', 'r17-annotation-rev-' || series::text,
           'createdAt', $4, 'updatedAt', $4
         ),
         1, 'backfilled'
       from generate_series(1, $1::integer) series`,
      [count, COLLECTION_ID, PRINCIPAL_ID, SEED_TS],
    );
    return ids;
  }

  /** Relation n links 'r17-node-{n}' -> 'r17-node-{(n % count) + 1}' with a distinct revision. */
  async function insertRelations(count: number): Promise<readonly string[]> {
    assert.ok(count >= 1);
    const ids = Array.from({ length: count }, (_, index) => `r17-relation-${String(index + 1).padStart(4, '0')}`);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'r17-relation-' || lpad(series::text, 4, '0'), 'relation'
       from generate_series(1, $1::integer) series`,
      [count],
    );
    await isolated.runtime.pool.query(
      `insert into relations (
         id, collection_id, from_node_id, to_node_id, type, label, visibility,
         resource_revision, created_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status
       )
       select
         'r17-relation-' || lpad(series::text, 4, '0'), $2::text,
         'r17-node-' || lpad(series::text, 4, '0'),
         case when $1::integer = 1 then $3::text
              else 'r17-node-' || lpad(((series % $1::integer) + 1)::text, 4, '0')
         end,
         'related', null, 'private',
         'r17-relation-rev-' || series::text, $4::timestamptz, $4::timestamptz,
         jsonb_build_object(
           'id', 'r17-relation-' || lpad(series::text, 4, '0'),
           'collectionId', $2,
           'type', 'related',
           'fromNodeId', 'r17-node-' || lpad(series::text, 4, '0'),
           'toNodeId', case when $1::integer = 1 then $3::text
                            else 'r17-node-' || lpad(((series % $1::integer) + 1)::text, 4, '0')
                       end,
           'visibility', 'private',
           'revision', 'r17-relation-rev-' || series::text,
           'createdAt', $4, 'updatedAt', $4
         ),
         1, 'backfilled'
       from generate_series(1, $1::integer) series`,
      [count, COLLECTION_ID, TARGET_ID, SEED_TS],
    );
    return ids;
  }

  function deleteMutation(
    operationId: string,
    resourceId: string,
    parentId: string | null,
    options: { expectedResourceRevision?: string } = {},
  ): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'delete',
        target: { collectionId: COLLECTION_ID, resourceId, resourceKind: 'node' },
        parentId,
        ...(options.expectedResourceRevision ? { expectedResourceRevision: options.expectedResourceRevision } : {}),
        deleteIntent: { scope: 'subtree' },
      },
    };
  }

  async function executeMutation(
    input: CanonicalMutationInput,
    options: {
      readonly canonicalFaultInjector?: {
        afterPhase(context: PostgresCanonicalMutationFaultContext): void | Promise<void>;
      };
      readonly socialRouteFaultInjector?: SocialCollectionChangeRouteFaultInjector;
      readonly db?: Kysely<DatabaseSchema>;
    } = {},
  ) {
    const binding = {
      principalId: PRINCIPAL_ID,
      commandScope: `canonical:delete`,
      commandId: input.operationId,
    };
    const fingerprint = `fp-${input.operationId}`;
    return createPostgresCanonicalMutationUnitOfWork(options.db ?? isolated.runtime.db, {
      ...(options.canonicalFaultInjector ? { canonicalFaultInjector: options.canonicalFaultInjector } : {}),
      ...(options.socialRouteFaultInjector ? { socialRouteFaultInjector: options.socialRouteFaultInjector } : {}),
    }).execute(async (ports) => {
      assert.deepEqual(await ports.receipts.claim(binding, fingerprint), { kind: 'claimed' });
      const result = await ports.canonical.execute(input);
      await ports.receipts.complete(binding, fingerprint, {
        status: 200,
        body: Buffer.from(JSON.stringify({ operationId: input.operationId })),
        stableHeaders: { 'content-type': 'application/json' },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
        targetIdentity: input.mutation.target.resourceId,
      });
      return result;
    });
  }

  async function readOutboxRows(operationId: string): Promise<ReadonlyMap<string, number>> {
    const rows = await isolated.runtime.pool.query(
      `select e.event_type, count(*)::int as count
       from outbox_events e
       join operations o on o.collection_id = e.aggregate_scope and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = $1
       group by e.event_type
       order by e.event_type`,
      [operationId],
    );
    return new Map(rows.rows.map((row) => [row.event_type as string, row.count as number] as const));
  }

  async function measureMutation(options: {
    readonly published?: boolean;
    readonly nodes: number;
    readonly annotations?: number;
    readonly relations?: number;
  }): Promise<OutboxPhaseMeasurement> {
    await resetFixture({ published: options.published ?? false });
    await insertFlatSubtree(options.nodes);
    if ((options.annotations ?? 0) > 0) await insertAnnotations(options.annotations!);
    if ((options.relations ?? 0) > 0) await insertRelations(options.relations!);
    const operationId = randomUUID();
    const baseExecutor = isolated.runtime.db.getExecutor();
    const captured: TracedStatement[] = [];
    const timingById = new Map<unknown, { entry: TracedStatement; startedAt: number }>();
    const countedDb = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        const compiled = baseExecutor.compileQuery(args.node, args.queryId);
        const entry: TracedStatement = {
          sql: compiled.sql,
          parameters: compiled.parameters,
          elapsedMs: 0,
        };
        timingById.set(args.queryId, { entry, startedAt: performance.now() });
        captured.push(entry);
        return args.node;
      },
      async transformResult(args) {
        const timing = timingById.get(args.queryId);
        if (timing) timing.entry.elapsedMs = performance.now() - timing.startedAt;
        return args.result;
      },
    });
    const resourceContexts: PostgresCanonicalMutationFaultContext[] = [];
    const auditStatementCount = { value: -1 };
    const outboxStatementCount = { value: -1 };
    let auditAt = 0;
    let outboxAt = 0;
    let socialStartAt = 0;
    let socialEndAt = 0;
    const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
      expectedResourceRevision: 'r17-target-rev',
    }), {
      db: countedDb,
      canonicalFaultInjector: {
        afterPhase(context) {
          if (context.phase === 'resource') resourceContexts.push(context);
          if (context.phase === 'audit') {
            auditStatementCount.value = captured.length;
            auditAt = performance.now();
          }
          if (context.phase === 'outbox') {
            outboxStatementCount.value = captured.length;
            outboxAt = performance.now();
          }
        },
      },
      socialRouteFaultInjector: {
        beforeMap() {
          socialStartAt = performance.now();
        },
        afterAppend() {
          socialEndAt = performance.now();
        },
      },
    });
    assert.ok(auditStatementCount.value >= 0, 'audit hook must fire before outbox statements');
    assert.ok(outboxStatementCount.value > auditStatementCount.value, 'outbox hook must fire after outbox statements');
    const outboxSlice = captured.slice(auditStatementCount.value, outboxStatementCount.value);
    const statements = classifyOutboxSlice(outboxSlice, options.published ?? false);
    const outboxRows = await readOutboxRows(operationId);
    const nodeBatches = resourceContexts.filter((c) => !c.resourceId?.startsWith('r17-annotation-')
      && !c.resourceId?.startsWith('r17-relation-')).length;
    const annotationBatches = resourceContexts.filter((c) => c.resourceId?.startsWith('r17-annotation-')).length;
    const relationBatches = resourceContexts.filter((c) => c.resourceId?.startsWith('r17-relation-')).length;
    return {
      published: options.published ?? false,
      nodes: options.nodes,
      annotations: options.annotations ?? 0,
      relations: options.relations ?? 0,
      statements,
      outboxRows,
      resourceBatches: { node: nodeBatches, annotation: annotationBatches, relation: relationBatches },
      outboxPhaseElapsedMs: outboxAt - auditAt,
      socialStageElapsedMs: socialEndAt - socialStartAt,
    };
  }

  test('sidecar-less delete: outbox work is constant for N=1 and N=300 subtree sizes', async () => {
    const one = await measureMutation({ nodes: 1 });
    const many = await measureMutation({ nodes: 300 });
    const expected: StageCounts = {
      route_lookup: 3,
      id_reserve: 2,
      primary_outbox: 1,
      social_outbox: 0,
      publication_purge: 0,
      sidecar_cascade: 0,
      total: 6,
    };
    assert.deepEqual(one.statements, expected, 'N=1 outbox slice must be exactly 6 statements');
    assert.deepEqual(many.statements, expected, 'N=300 outbox slice must be exactly 6 statements');
    assert.deepEqual(many.statements, one.statements,
      'deleting 1 vs 300 sidecar-less nodes must yield identical outbox-phase statement counts');
    assert.equal(one.outboxRows.get(NODE_DELETED_EVENT_TYPE), 1);
    assert.equal(many.outboxRows.get(NODE_DELETED_EVENT_TYPE), 1,
      'the primary node.deleted domain event count must be independent of N');
    assert.equal(many.outboxRows.get(SOCIAL_COLLECTION_CHANGE_EVENT_TYPE) ?? 0, 0);
    assert.equal(many.outboxRows.size, 1, 'a sidecar-less delete emits primary + social event types (two social handlers)');
    // N only scales the bounded resource-phase batching, never the outbox phase.
    assert.equal(one.resourceBatches.node, 1);
    assert.equal(many.resourceBatches.node, Math.ceil(300 / 128));
    assert.equal(many.resourceBatches.annotation, 0);
    assert.equal(many.resourceBatches.relation, 0);
  }, 120_000);

  test('annotation cascade: outbox sidecar rows and statements grow linearly with A (1, 128, 300)', async () => {
    const measurements: OutboxPhaseMeasurement[] = [];
    for (const A of [1, 128, 300]) {
      const m = await measureMutation({ nodes: 301, annotations: A });
      assert.equal(m.statements.route_lookup, 3, 'route stage must stay constant as A grows');
      assert.equal(m.statements.id_reserve, 2,
        'the primary ID reserve stays constant at 2; cascade ID reserves are attributed to the sidecar stage');
      assert.equal(m.statements.primary_outbox, 1, 'primary outbox stays a single insert');
      assert.equal(m.statements.social_outbox, 0, 'the removed social handlers append no statements');
      assert.equal(m.statements.publication_purge, 0);
      assert.equal(m.statements.sidecar_cascade, 3 * A, 'each annotation cascade is reserve + reserve + insert');
      assert.equal(m.statements.total, 6 + 3 * A);
      assert.equal(m.outboxRows.get(ANNOTATION_DELETED_EVENT_TYPE), A);
      assert.equal(m.outboxRows.get(NODE_DELETED_EVENT_TYPE), 1);
      assert.equal(m.resourceBatches.annotation, Math.ceil(A / 128),
        'resource-phase annotation tombstones must stay batched by 128');
      assert.equal(m.resourceBatches.node, Math.ceil(301 / 128));
      measurements.push(m);
    }
    const [a1, a128, a300] = measurements;
    // Linear slope: the delta between A=300 and A=128 is exactly 3 per annotation.
    assert.equal(a300.statements.sidecar_cascade - a128.statements.sidecar_cascade, 3 * (300 - 128));
    assert.equal(a300.statements.id_reserve - a128.statements.id_reserve, 0,
      'the primary ID reserve is N-independent; cascade ID reserves scale inside sidecar_cascade');
    assert.equal(a300.outboxRows.get(ANNOTATION_DELETED_EVENT_TYPE)! - a128.outboxRows.get(ANNOTATION_DELETED_EVENT_TYPE)!,
      300 - 128);
    assert.equal(a1.statements.total, 6 + 3 * 1);
    void a1;
  }, 120_000);

  test('relation cascade: outbox sidecar rows and statements grow linearly with R (1, 128, 300)', async () => {
    const measurements: OutboxPhaseMeasurement[] = [];
    for (const R of [1, 128, 300]) {
      const m = await measureMutation({ nodes: 301, relations: R });
      assert.equal(m.statements.route_lookup, 3);
      assert.equal(m.statements.id_reserve, 2,
        'the primary ID reserve stays constant at 2; cascade ID reserves are attributed to the sidecar stage');
      assert.equal(m.statements.primary_outbox, 1);
      assert.equal(m.statements.social_outbox, 0);
      assert.equal(m.statements.publication_purge, 0);
      assert.equal(m.statements.sidecar_cascade, 3 * R, 'each relation cascade is reserve + reserve + insert');
      assert.equal(m.statements.total, 6 + 3 * R);
      assert.equal(m.outboxRows.get(RELATION_DELETED_EVENT_TYPE), R);
      assert.equal(m.outboxRows.get(NODE_DELETED_EVENT_TYPE), 1);
      assert.equal(m.resourceBatches.relation, Math.ceil(R / 128));
      measurements.push(m);
    }
    const [, r128, r300] = measurements;
    assert.equal(r300.statements.sidecar_cascade - r128.statements.sidecar_cascade, 3 * (300 - 128));
    assert.equal(r300.outboxRows.get(RELATION_DELETED_EVENT_TYPE)! - r128.outboxRows.get(RELATION_DELETED_EVENT_TYPE)!,
      300 - 128);
  }, 120_000);

  test('published collection: publication purge stage appends exactly reserve + insert (2 statements)', async () => {
    const m = await measureMutation({ published: true, nodes: 2 });
    assert.deepEqual(m.statements, {
      route_lookup: 3,
      id_reserve: 2,
      primary_outbox: 1,
      social_outbox: 0,
      publication_purge: 2,
      sidecar_cascade: 0,
      total: 8,
    });
    assert.equal(m.outboxRows.get(NODE_DELETED_EVENT_TYPE), 1);
    assert.equal(m.outboxRows.get(SOCIAL_COLLECTION_CHANGE_EVENT_TYPE) ?? 0, 0);
    assert.equal(m.outboxRows.get(PUBLICATION_CACHE_PURGE_EVENT_TYPE), 1);
    assert.equal(m.outboxRows.size, 2);
  }, 120_000);

  test('sync push route: request fingerprint serialization is deterministic and bounded', async () => {
    const apps: FastifyInstance[] = [];
    const app = Fastify({ logger: false });
    apps.push(app);
    let admitCalls = 0;
    registerSyncPushRoutes(app, {
      path: '/private-entry/operation-ingress',
      allowedOrigins: [PUSH_ORIGIN],
      credentialVerifier: {
        async verify() {
          return mintVerifiedExtensionCredentialFixture({
            issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
            subject: 'push-subject', credentialId: 'push-credential',
          });
        },
      },
      application: {
        runtimeOwnership: { operationIdReservationOwner: 'sequence', usesPushCoordinator: false,
          maxBatchOperations: 1, evaluator: 'canonical_node_create' },
        async admit() {
          admitCalls += 1;
          throw new SyncPushHttpError('unsupported_operation');
        },
      },
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
      maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    await app.ready();

    const body = JSON.stringify(syncNodeCreatePushRequest({
      node: {
        kind: 'bookmark',
        title: 'R17 Unicode 中文 🎯 serialization evidence',
        url: 'https://example.test/r17/unicode',
        description: 'description with unicode 描述 and a nested extension payload',
        tags: ['r17', '证据'],
        visibility: 'inherit',
        extensions: {},
      },
    }));
    const bodyBytes = Buffer.byteLength(body, 'utf8');

    async function measureInject(idempotencyKey: string): Promise<{ calls: number; bytes: number }> {
      let calls = 0;
      let bytes = 0;
      const original = JSON.stringify;
      const patched = ((value: unknown, replacer?: unknown, space?: unknown): string | undefined => {
        calls += 1;
        const serialized = original(value as never, replacer as never, space as never);
        if (typeof serialized === 'string') bytes += Buffer.byteLength(serialized, 'utf8');
        return serialized;
      }) as unknown as typeof original;
      (JSON as unknown as { stringify: typeof original }).stringify = patched;
      try {
        await app.inject({
          method: 'POST',
          url: '/private-entry/operation-ingress',
          headers: {
            Authorization: `Bearer ${PUSH_TOKEN}`,
            Origin: PUSH_ORIGIN,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          payload: body,
        });
      } finally {
        (JSON as unknown as { stringify: typeof original }).stringify = original;
      }
      return { calls, bytes };
    }

    const first = await measureInject('r17-push-key-1');
    const second = await measureInject('r17-push-key-2');
    await Promise.all(apps.map((instance) => instance.close()));
    assert.equal(admitCalls, 2, 'both push requests must reach admission after fingerprint serialization');
    assert.ok(first.calls > 0, 'the push route must serialize the request document for its fingerprint');
    assert.ok(first.bytes > 0, 'the push route must produce serialized fingerprint bytes');
    assert.equal(first.calls, second.calls, 'canonical request serialization invocation count must be deterministic');
    assert.equal(first.bytes, second.bytes, 'canonical request serialization bytes must be deterministic');
    assert.ok(first.bytes <= 4 * bodyBytes,
      `request serialization must stay a constant factor of the body, got ${first.bytes} bytes for ${bodyBytes}`);
  }, 120_000);

  test('records outbox + serialization evidence JSON', async () => {
    const constancyOne = await measureMutation({ nodes: 1 });
    const constancyMany = await measureMutation({ nodes: 300 });
    // Sequential on purpose: every mutation truncates and reseeds the same
    // fixture rows, so parallel execution would race on the shared schema.
    const annotationSlopes: OutboxPhaseMeasurement[] = [];
    for (const A of [1, 128, 300]) annotationSlopes.push(await measureMutation({ nodes: 301, annotations: A }));
    const relationSlopes: OutboxPhaseMeasurement[] = [];
    for (const R of [1, 128, 300]) relationSlopes.push(await measureMutation({ nodes: 301, relations: R }));
    const purge = await measureMutation({ published: true, nodes: 2 });
    console.log(JSON.stringify({
      evidence: 'r17_outbox_serialization_postgres',
      constancy: {
        nodeCounts: [constancyOne.nodes, constancyMany.nodes],
        statementsEqual: JSON.stringify(constancyOne.statements) === JSON.stringify(constancyMany.statements),
        statements: constancyMany.statements,
        outboxRows: Object.fromEntries(constancyMany.outboxRows),
        outboxPhaseElapsedMs: { one: constancyOne.outboxPhaseElapsedMs, many: constancyMany.outboxPhaseElapsedMs },
      },
      annotationSlope: annotationSlopes.map((m) => ({
        A: m.annotations, sidecarStatements: m.statements.sidecar_cascade,
        idReserve: m.statements.id_reserve, outboxRows: Object.fromEntries(m.outboxRows),
        resourceAnnotationBatches: m.resourceBatches.annotation,
      })),
      relationSlope: relationSlopes.map((m) => ({
        R: m.relations, sidecarStatements: m.statements.sidecar_cascade,
        idReserve: m.statements.id_reserve, outboxRows: Object.fromEntries(m.outboxRows),
        resourceRelationBatches: m.resourceBatches.relation,
      })),
      publicationPurge: { statements: purge.statements, outboxRows: Object.fromEntries(purge.outboxRows) },
    }, null, 2));
  }, 120_000);
});
