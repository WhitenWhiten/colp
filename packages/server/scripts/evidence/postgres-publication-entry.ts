import { readFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  assembleSnapshotPages,
} from '@know-n/colp/semantic';
import type { Snapshot } from '@know-n/colp/types';
import type { PoolClient } from 'pg';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
} from '../../src/modules/collections/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationSnapshotPage,
  PublicationSnapshotExpiredError,
  type PublicationCursorKeyring,
  type PublicationSnapshotQueryPorts,
  type PublicationSnapshotReadPort,
} from '../../src/modules/publication/index.js';
import { createPostgresSharedExposureFactsPort, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  buildPublicationSnapshotCandidateStatement,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../src/infrastructure/publication/index.js';

const TARGET = Object.freeze({
  collectionId: 'FBQUFBQUFBQUFBQUFBQUFA',
  publicationSlug: 'phase2-publication-target',
  rootId: 'p2-root',
});
const OTHER = Object.freeze({
  collectionId: 'FRUVFRUVFRUVFRUVFRUVFQ',
  publicationSlug: 'phase2-publication-other',
  rootId: 'p2-other-root',
});
const OWNER_PROFILE_ID = 'IiIiIiIiIiIiIiIiIiIiIg';
export const POSTGRES_PUBLICATION_ENTRY_TARGET = TARGET;
const KEYSET_INDEX = 'nodes_live_editor_keyset_idx';
const FOLDERS = 100;

export interface PostgresPublicationEntryThresholds {
  readonly nodeCount: number;
  readonly pageSize: number;
  readonly pageP95Ms: number;
  readonly fullTraversalMs: number;
  readonly planExecutionMs: number;
  readonly maxPageBytes: number;
  readonly maxHeapDeltaBytes: number;
  readonly writerTransactionMs: number;
}

export interface PostgresPublicationEntryOptions {
  readonly thresholdsPath?: string;
  readonly seedFixture?: boolean;
}

interface LatencySummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface PublicationTraversalEvidence {
  readonly pageCount: number;
  readonly nodeCount: number;
  readonly elapsedMs: number;
  readonly pageLatencyMs: LatencySummary;
  readonly maxPageBytes: number;
  readonly heapDeltaBytes: number;
  readonly duplicateCount: number;
  readonly missingIds: readonly string[];
  readonly unexpectedIds: readonly string[];
  readonly structurallyValidPages: number;
  readonly assembledSemanticsValid: boolean;
  readonly strictlyOrdered: boolean;
  readonly transactionIsolation: readonly string[];
}

interface PlanEvidence {
  readonly location: 'first' | 'middle' | 'final';
  readonly planningMs: number;
  readonly executionMs: number;
  readonly indexNames: readonly string[];
  readonly hasSort: boolean;
  readonly hasNodesSequentialScan: boolean;
  readonly returnedRows: number;
  readonly rowLimit: number;
  readonly sharedBufferBlocks: number;
}

export interface PostgresPublicationEntryEvidence {
  readonly evidence: 'phase2_postgres_publication_entry';
  readonly thresholdsPath: string;
  readonly environment: {
    readonly node: string;
    readonly os: string;
    readonly cpu: string;
    readonly postgresVersion: string;
    readonly nodeCount: number;
    readonly pageSize: number;
  };
  readonly thresholds: PostgresPublicationEntryThresholds;
  readonly traversal: PublicationTraversalEvidence;
  readonly plans: readonly PlanEvidence[];
  readonly fences: {
    readonly contentRevision: 'snapshot_expired';
    readonly policyRevision: 'snapshot_expired';
    readonly tamperedCursor: 'snapshot_expired';
  };
  readonly writers: {
    readonly contentRevisionMs: number;
    readonly policyRevisionMs: number;
    readonly otherCollectionMs: number;
  };
  readonly concurrentSnapshot: {
    readonly writerCompletedWhileReaderPaused: boolean;
    readonly writerMs: number;
    readonly readerContentRevision: string;
    readonly readerNodeTitle: string;
    readonly nextContentRevision: string;
    readonly nextNodeTitle: string;
  };
  readonly boundaries: {
    readonly rootOnlyRootId: string | null;
    readonly rootOnlyCandidateIds: readonly string[];
    readonly liveLimitPlusOneIds: readonly string[];
    readonly finalPageIds: readonly string[];
    readonly otherCollectionIds: readonly string[];
  };
  readonly pass: {
    readonly exactTraversal: boolean;
    readonly schemaAndSemantics: boolean;
    readonly mvccAndFences: boolean;
    readonly latency: boolean;
    readonly serializationMemory: boolean;
    readonly plans: boolean;
    readonly writers: boolean;
    readonly overall: boolean;
  };
}

export class PublicationEntrySnapshotExpiredError extends Error {
  readonly code = 'snapshot_expired';

  constructor() {
    super('Publication Snapshot continuation no longer matches the current revision fence.');
    this.name = 'PublicationEntrySnapshotExpiredError';
  }
}

export function defaultPostgresPublicationEntryThresholdsPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../tests/fixtures/phase2/publication-entry-thresholds.json',
  );
}

export function loadPostgresPublicationEntryThresholds(
  path = defaultPostgresPublicationEntryThresholdsPath(),
): PostgresPublicationEntryThresholds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `PostgreSQL Publication entry thresholds are missing or invalid at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) throw new Error('PostgreSQL Publication entry thresholds must be an object');
  const expectedKeys = [
    '$schema',
    'fullTraversalMs',
    'maxHeapDeltaBytes',
    'maxPageBytes',
    'nodeCount',
    'pageP95Ms',
    'pageSize',
    'planExecutionMs',
    'writerTransactionMs',
  ];
  const actualKeys = Object.keys(parsed).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('PostgreSQL Publication entry thresholds contain missing or unknown fields');
  }
  if (parsed.$schema !== './publication-entry-thresholds.schema.json') {
    throw new Error('PostgreSQL Publication entry thresholds have an unexpected $schema');
  }
  const nodeCount = positiveInteger(parsed.nodeCount, 'nodeCount');
  const pageSize = positiveInteger(parsed.pageSize, 'pageSize');
  if (nodeCount < 10_000) throw new Error('nodeCount must be at least 10000');
  if (pageSize > 500) throw new Error('pageSize must be <= 500');
  return {
    nodeCount,
    pageSize,
    pageP95Ms: positiveNumber(parsed.pageP95Ms, 'pageP95Ms'),
    fullTraversalMs: positiveNumber(parsed.fullTraversalMs, 'fullTraversalMs'),
    planExecutionMs: positiveNumber(parsed.planExecutionMs, 'planExecutionMs'),
    maxPageBytes: positiveInteger(parsed.maxPageBytes, 'maxPageBytes'),
    maxHeapDeltaBytes: positiveInteger(parsed.maxHeapDeltaBytes, 'maxHeapDeltaBytes'),
    writerTransactionMs: positiveNumber(parsed.writerTransactionMs, 'writerTransactionMs'),
  };
}

/** Real-PostgreSQL Phase 2 entry evidence. The caller owns migrations and schema isolation. */
export async function runPostgresPublicationEntryEvidence(
  runtime: DatabaseRuntime,
  options: PostgresPublicationEntryOptions = {},
): Promise<PostgresPublicationEntryEvidence> {
  const thresholdsPath = options.thresholdsPath
    ? resolve(options.thresholdsPath)
    : defaultPostgresPublicationEntryThresholdsPath();
  const thresholds = loadPostgresPublicationEntryThresholds(thresholdsPath);
  if (thresholds.nodeCount % FOLDERS !== 0) {
    throw new Error(`Publication entry nodeCount must be divisible by ${FOLDERS}`);
  }

  if (options.seedFixture !== false) {
    await seedPostgresPublicationEntryFixture(runtime, thresholds.nodeCount);
  }

  const key = createPublicationCursorKeyring({
    active: { id: 'evidence-v1', secret: Buffer.alloc(32, 37).toString('base64') },
    retained: [],
  });
  try {
    const contentFirst = await loadPage(runtime, key, thresholds.pageSize);
    const contentRevisionMs = await timedWriter(() => mutateTargetContent(runtime));
    const contentRevision = await expectSnapshotExpired(
      runtime,
      key,
      thresholds.pageSize,
      snapshotNextCursor(contentFirst.page),
    );

    const policyFirst = await loadPage(runtime, key, thresholds.pageSize);
    const policyRevisionMs = await timedWriter(() => mutateTargetPolicy(runtime));
    const policyRevision = await expectSnapshotExpired(
      runtime,
      key,
      thresholds.pageSize,
      snapshotNextCursor(policyFirst.page),
    );

    const tamperFirst = await loadPage(runtime, key, thresholds.pageSize);
    const originalCursor = snapshotNextCursor(tamperFirst.page);
    const tamperedCursor = originalCursor === null
      ? null
      : `${originalCursor.slice(0, -1)}${originalCursor.endsWith('A') ? 'B' : 'A'}`;
    const tampered = await expectSnapshotExpired(
      runtime,
      key,
      thresholds.pageSize,
      tamperedCursor,
    );

    let otherCollectionMs = Number.POSITIVE_INFINITY;
    const concurrentSnapshot = await probeConcurrentSnapshot(runtime);
    const traversal = await traverse(runtime, key, thresholds, async (pageIndex) => {
      if (pageIndex === 1) {
        otherCollectionMs = await timedWriter(() => mutateOtherCollection(runtime));
      }
    });
    const plans = await capturePlans(runtime, thresholds.pageSize);
    const boundaries = await probeAdapterBoundaries(runtime);
    const version = await runtime.pool.query<{ server_version: string }>('show server_version');

    const exactTraversal = traversal.duplicateCount === 0
      && traversal.missingIds.length === 0
      && traversal.unexpectedIds.length === 0
      && traversal.strictlyOrdered
      && traversal.nodeCount === thresholds.nodeCount + 1;
    const schemaAndSemantics = traversal.structurallyValidPages === traversal.pageCount
      && traversal.assembledSemanticsValid;
    const mvccAndFences = traversal.transactionIsolation.every((value) => value === 'repeatable read')
      && contentRevision === 'snapshot_expired'
      && policyRevision === 'snapshot_expired'
      && tampered === 'snapshot_expired';
    const latency = traversal.pageLatencyMs.p95 <= thresholds.pageP95Ms
      && traversal.elapsedMs <= thresholds.fullTraversalMs;
    const serializationMemory = traversal.maxPageBytes <= thresholds.maxPageBytes
      && traversal.heapDeltaBytes <= thresholds.maxHeapDeltaBytes;
    const plansPass = plans.every((plan) =>
      plan.executionMs <= thresholds.planExecutionMs
      && plan.indexNames.includes(KEYSET_INDEX)
      && !plan.hasSort
      && !plan.hasNodesSequentialScan
      && plan.returnedRows <= plan.rowLimit
      && plan.sharedBufferBlocks > 0);
    const writers = [contentRevisionMs, policyRevisionMs, otherCollectionMs]
      .every((value) => value <= thresholds.writerTransactionMs)
      && concurrentSnapshot.writerCompletedWhileReaderPaused
      && concurrentSnapshot.writerMs <= thresholds.writerTransactionMs
      && concurrentSnapshot.readerContentRevision === 'c2'
      && concurrentSnapshot.readerNodeTitle === 'Publication Node 1 updated'
      && concurrentSnapshot.nextContentRevision === 'c3'
      && concurrentSnapshot.nextNodeTitle === 'Publication Node 1 updated concurrent';
    const overall = exactTraversal
      && schemaAndSemantics
      && mvccAndFences
      && latency
      && serializationMemory
      && plansPass
      && writers;
    const cpu = cpus();

    return {
      evidence: 'phase2_postgres_publication_entry',
      thresholdsPath,
      environment: {
        node: process.version,
        os: `${platform()} ${release()}`,
        cpu: cpu[0]?.model ?? 'unknown',
        postgresVersion: version.rows[0]?.server_version ?? 'unknown',
        nodeCount: thresholds.nodeCount,
        pageSize: thresholds.pageSize,
      },
      thresholds,
      traversal,
      plans,
      fences: {
        contentRevision,
        policyRevision,
        tamperedCursor: tampered,
      },
      writers: {
        contentRevisionMs,
        policyRevisionMs,
        otherCollectionMs,
      },
      concurrentSnapshot,
      boundaries,
      pass: {
        exactTraversal,
        schemaAndSemantics,
        mvccAndFences,
        latency,
        serializationMemory,
        plans: plansPass,
        writers,
        overall,
      },
    };
  } finally {
    key.destroy();
  }
}

interface PageLoadResult {
  readonly page: Snapshot;
  readonly isolation: string;
}

async function loadPage(
  runtime: DatabaseRuntime,
  key: PublicationCursorKeyring,
  pageSize: number,
  cursor?: string,
): Promise<PageLoadResult> {
  const query = createPostgresPublicationEntrySnapshotQueryPorts(runtime, key);
  let isolation = 'unknown';
  const reads: PublicationSnapshotReadPort = {
    async loadPage(request) {
      const page = await query.reads.loadPage(request);
      isolation = page.isolation;
      return page;
    },
  };
  const result = await getPublicationSnapshotPage({
    ...query,
    reads,
  }, {
    collectionId: TARGET.collectionId,
    principal: { kind: 'anonymous' },
    query: { limit: pageSize, ...(cursor ? { pageCursor: cursor } : {}) },
  });
  return { page: result.snapshot, isolation };
}

export function createPostgresPublicationEntrySnapshotQueryPorts(
  runtime: DatabaseRuntime,
  key: PublicationCursorKeyring,
): PublicationSnapshotQueryPorts {
  return {
    reads: createPostgresPublicationSnapshotReadPort(runtime),
    // P4A-R06: the I16 publication consumer leg also exercises the annotation
    // and relation streams (feature-flag include[] shapes) through the same
    // production read ports, so the evidence composition wires them here.
    annotations: createPostgresPublicationAnnotationReadPort(runtime, { origin: 'https://known.example' }),
    relations: createPostgresPublicationRelationReadPort(runtime),
    cursors: key,
    sharedExposure: createPostgresSharedExposureFactsPort(runtime),
    accessPolicy: {
      async loadCollectionFacts(input) {
        const facts = await runtime.pool.query<{
          id: string;
          owner_subject_id: string;
          visibility: 'private' | 'protected' | 'unlisted' | 'public';
          policy_revision: string;
          deleted_at: Date | null;
        }>(
          `select id, owner_subject_id, visibility, policy_revision, deleted_at
             from collections where id = $1`,
          [input.collectionId],
        );
        const row = facts.rows[0];
        if (!row) return null;
        return {
          collectionId: row.id,
          ownerSubjectId: row.owner_subject_id,
          visibility: row.visibility,
          policyRevision: row.policy_revision,
          membershipRole: null,
          deleted: row.deleted_at !== null,
        };
      },
    },
    origin: 'https://known.example',
  };
}

async function traverse(
  runtime: DatabaseRuntime,
  key: PublicationCursorKeyring,
  thresholds: PostgresPublicationEntryThresholds,
  pageHook: (pageIndex: number) => Promise<void>,
): Promise<PublicationTraversalEvidence> {
  const pages: Snapshot[] = [];
  const latencies: number[] = [];
  const isolation: string[] = [];
  const baselineHeap = process.memoryUsage().heapUsed;
  let peakHeap = baselineHeap;
  let maxPageBytes = 0;
  let cursor: string | undefined;
  let pageIndex = 0;
  const started = performance.now();
  do {
    const pageStarted = performance.now();
    const result = await loadPage(runtime, key, thresholds.pageSize, cursor);
    latencies.push(performance.now() - pageStarted);
    isolation.push(result.isolation);
    const serialized = JSON.stringify(result.page);
    maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(serialized, 'utf8'));
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    pages.push(result.page);
    cursor = snapshotNextCursor(result.page) ?? undefined;
    await pageHook(pageIndex);
    pageIndex += 1;
  } while (cursor !== undefined);
  const elapsedMs = performance.now() - started;
  const assembly = assembleSnapshotPages(pages);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  const returned = pages.flatMap((page) => page.nodes.map((node) => node.id));
  const expected = expectedPostgresPublicationEntryIds(thresholds.nodeCount);
  const returnedSet = new Set(returned);
  const expectedSet = new Set(expected);
  return {
    pageCount: pages.length,
    nodeCount: returned.length,
    elapsedMs,
    pageLatencyMs: latencySummary(latencies),
    maxPageBytes,
    heapDeltaBytes: Math.max(0, peakHeap - baselineHeap),
    duplicateCount: returned.length - returnedSet.size,
    missingIds: expected.filter((id) => !returnedSet.has(id)),
    unexpectedIds: returned.filter((id) => !expectedSet.has(id)),
    structurallyValidPages: pages.length,
    assembledSemanticsValid: assembly.valid,
    strictlyOrdered: returned.length === expected.length
      && returned.every((id, index) => id === expected[index]),
    transactionIsolation: isolation,
  };
}

async function expectSnapshotExpired(
  runtime: DatabaseRuntime,
  key: PublicationCursorKeyring,
  pageSize: number,
  cursor: string | null,
): Promise<'snapshot_expired'> {
  if (cursor === null) throw new Error('Publication fence probe requires a continuation cursor');
  try {
    await loadPage(runtime, key, pageSize, cursor);
  } catch (error: unknown) {
    if (error instanceof PublicationSnapshotExpiredError) return 'snapshot_expired';
    throw error;
  }
  throw new Error('Stale Publication cursor did not fail with snapshot_expired');
}

export async function seedPostgresPublicationEntryFixture(
  runtime: DatabaseRuntime,
  nodeCount: number,
): Promise<void> {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 10_000 || nodeCount % FOLDERS !== 0) {
    throw new Error(`Publication entry nodeCount must be an integer >= 10000 divisible by ${FOLDERS}`);
  }
  await seedTargetCollection(runtime, nodeCount);
  await seedOtherCollection(runtime);
  await runtime.pool.query('analyze nodes');
}

async function seedTargetCollection(runtime: DatabaseRuntime, nodeCount: number): Promise<void> {
  const bookmarksPerFolder = nodeCount / FOLDERS - 1;
  const bookmarkCount = bookmarksPerFolder * FOLDERS;
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await seedCollectionBase(client, TARGET.collectionId, TARGET.publicationSlug,
      TARGET.rootId, 'Phase 2 Publication target');
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       select 'p2-f' || lpad(n::text, 3, '0'), 'node'
       from generate_series(0, $1::integer - 1) as n`,
      [FOLDERS],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, title, position_token,
          resource_revision, children_revision)
       select 'p2-f' || lpad(n::text, 3, '0'), $1, $2, 'folder',
              'Folder ' || n::text, 'F' || lpad(n::text, 3, '0'), 'r1', 'ch1'
       from generate_series(0, $3::integer - 1) as n`,
      [TARGET.collectionId, TARGET.rootId, FOLDERS],
    );
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       select 'p2-n' || lpad(n::text, 6, '0'), 'node'
       from generate_series(1, $1::integer) as n`,
      [bookmarkCount],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, title, url, position_token,
          resource_revision, children_revision)
       select 'p2-n' || lpad(n::text, 6, '0'), $1,
              'p2-f' || lpad(((n - 1) / $2::integer)::text, 3, '0'),
              'bookmark', 'Publication Node ' || n::text,
              'https://example.test/publication/' || n::text,
              'B' || lpad((((n - 1) % $2::integer) + 1)::text, 3, '0'),
              'r1', 'ch1'
       from generate_series(1, $3::integer) as n`,
      [TARGET.collectionId, bookmarksPerFolder, bookmarkCount],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedOtherCollection(runtime: DatabaseRuntime): Promise<void> {
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await seedCollectionBase(client, OTHER.collectionId, OTHER.publicationSlug,
      OTHER.rootId, 'Phase 2 other Collection');
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       values ('p2-other-node', 'node')`,
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, title, url, position_token,
          resource_revision, children_revision)
       values ('p2-other-node', $1, $2, 'bookmark', 'Other node',
               'https://example.test/other', 'B001', 'r1', 'ch1')`,
      [OTHER.collectionId, OTHER.rootId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedCollectionBase(
  client: PoolClient,
  collectionId: string,
  publicationSlug: string,
  rootId: string,
  title: string,
): Promise<void> {
  await client.query(
    `insert into accounts(id,subject_id,status)
     values ($1,'phase2-publication-owner','active') on conflict (id) do nothing`,
    [OWNER_PROFILE_ID],
  );
  await client.query(
    `insert into profiles(account_id,display_name)
     values ($1,'Phase 2 Publication owner') on conflict (account_id) do nothing`,
    [OWNER_PROFILE_ID],
  );
  await client.query(
    `insert into resource_id_ledger (resource_id, resource_type)
     values ($1, 'collection'), ($2, 'node')`,
    [collectionId, rootId],
  );
  await client.query(
    `insert into collections
     (id, owner_subject_id, title, kind, root_node_id, visibility, publication_slug, published_at,
        resource_revision, content_revision, policy_revision)
     values ($1, 'phase2-publication-owner', $2, 'bookmarks', $3, 'public', $4, now(), 'r1', 'c1', 'p1')`,
    [collectionId, title, rootId, publicationSlug],
  );
  const authority = await client.query<{
    id: string;
    owner_subject_id: string;
    title: string;
    summary: string | null;
    kind: string;
    visibility: string;
    root_node_id: string;
    resource_revision: string;
    content_revision: string;
    policy_revision: string;
    commit_ordinal: string;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
  }>(
    `select id, owner_subject_id, title, summary, kind, visibility, root_node_id,
            resource_revision, content_revision, policy_revision,
            commit_ordinal::text, created_at, updated_at, deleted_at
       from collections where id = $1`,
    [collectionId],
  );
  const row = authority.rows[0]!;
  const payload = materializeCollectionPayload({
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
  if (!payload.ok) {
    throw new Error(`Publication entry fixture canonical payload failed: ${payload.fieldPath}`);
  }
  await client.query(
    `update collections
        set payload_json = $2::jsonb,
            payload_schema_version = $3,
            payload_authority_status = 'backfilled'
      where id = $1`,
    [collectionId, JSON.stringify(payload.payload), RESOURCE_PAYLOAD_SCHEMA_VERSION],
  );
  await client.query(
    `insert into nodes
       (id, collection_id, kind, is_root, title, resource_revision, children_revision)
     values ($1, $2, 'folder', true, $3, 'r1', 'ch1')`,
    [rootId, collectionId, title],
  );
}

async function mutateTargetContent(runtime: DatabaseRuntime): Promise<void> {
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update nodes
       set title = title || ' updated', resource_revision = 'r2', updated_at = clock_timestamp()
       where collection_id = $1 and id = 'p2-n000001'`,
      [TARGET.collectionId],
    );
    await client.query(
      `update collections
       set content_revision = 'c2', updated_at = clock_timestamp()
       where id = $1`,
      [TARGET.collectionId],
    );
    await refreshCollectionAuthority(client, TARGET.collectionId);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function mutateTargetPolicy(runtime: DatabaseRuntime): Promise<void> {
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update collections
       set policy_revision = 'p2', updated_at = clock_timestamp()
       where id = $1`,
      [TARGET.collectionId],
    );
    await refreshCollectionAuthority(client, TARGET.collectionId);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function refreshCollectionAuthority(client: PoolClient, collectionId: string): Promise<void> {
  const authority = await client.query<{
    id: string;
    owner_subject_id: string;
    title: string;
    summary: string | null;
    kind: string;
    visibility: string;
    root_node_id: string;
    resource_revision: string;
    content_revision: string;
    policy_revision: string;
    commit_ordinal: string;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
    payload_json: { extensions?: unknown } | null;
  }>(
    `select id, owner_subject_id, title, summary, kind, visibility, root_node_id,
            resource_revision, content_revision, policy_revision,
            commit_ordinal::text, created_at, updated_at, deleted_at, payload_json
       from collections where id = $1`,
    [collectionId],
  );
  const row = authority.rows[0];
  if (!row) throw new Error(`Publication fixture Collection ${collectionId} disappeared`);
  const payload = materializeCollectionPayload({
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
  if (!payload.ok) {
    throw new Error(`Publication fixture canonical refresh failed: ${payload.fieldPath}`);
  }
  await client.query(
    `update collections
        set payload_json = $2::jsonb,
            payload_schema_version = $3,
            payload_authority_status = 'backfilled'
      where id = $1`,
    [collectionId, JSON.stringify(payload.payload), RESOURCE_PAYLOAD_SCHEMA_VERSION],
  );
}

async function mutateOtherCollection(runtime: DatabaseRuntime): Promise<void> {
  await runtime.pool.query(
    `update collections
     set content_revision = 'c2', updated_at = clock_timestamp()
     where id = $1`,
    [OTHER.collectionId],
  );
}

async function probeConcurrentSnapshot(
  runtime: DatabaseRuntime,
): Promise<PostgresPublicationEntryEvidence['concurrentSnapshot']> {
  const snapshotEstablished = deferred();
  const resumeReader = deferred();
  const reader = createPostgresPublicationSnapshotReadPort(runtime, {
    async afterSnapshotEstablished() {
      snapshotEstablished.resolve();
      await resumeReader.promise;
    },
  });
  const readerPromise = reader.loadPage({ collectionId: TARGET.collectionId, limit: 1 });
  await snapshotEstablished.promise;

  let writerCompletedWhileReaderPaused = false;
  let writerMs = Number.POSITIVE_INFINITY;
  let writerError: unknown;
  try {
    writerMs = await timedWriter(async () => {
      const writer = await runtime.pool.connect();
      try {
        await writer.query('begin');
        await writer.query(
          `update nodes
              set title = title || ' concurrent', resource_revision = 'r3', updated_at = clock_timestamp()
            where collection_id = $1 and id = 'p2-n000001'`,
          [TARGET.collectionId],
        );
        await writer.query(
          `update collections set content_revision = 'c3', updated_at = clock_timestamp()
            where id = $1`,
          [TARGET.collectionId],
        );
        await refreshCollectionAuthority(writer, TARGET.collectionId);
        await writer.query('commit');
        writerCompletedWhileReaderPaused = true;
      } catch (error: unknown) {
        await writer.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        writer.release();
      }
    });
  } catch (error: unknown) {
    writerError = error;
  } finally {
    resumeReader.resolve();
  }
  let page: Awaited<typeof readerPromise>;
  try {
    page = await readerPromise;
  } catch (readerError: unknown) {
    if (writerError !== undefined) {
      throw new AggregateError([writerError, readerError], 'Publication concurrent Snapshot probe failed');
    }
    throw readerError;
  }
  if (writerError !== undefined) throw writerError;
  const next = await createPostgresPublicationSnapshotReadPort(runtime).loadPage({
    collectionId: TARGET.collectionId,
    limit: 1,
  });
  const readerNode = page.candidates[0];
  const nextNode = next.candidates[0];
  if (!page.collection || !readerNode || !next.collection || !nextNode) {
    throw new Error('Publication concurrent Snapshot probe did not return its target records');
  }
  return {
    writerCompletedWhileReaderPaused,
    writerMs,
    readerContentRevision: page.collection.contentRevision,
    readerNodeTitle: readerNode.title,
    nextContentRevision: next.collection.contentRevision,
    nextNodeTitle: nextNode.title,
  };
}

async function probeAdapterBoundaries(
  runtime: DatabaseRuntime,
): Promise<PostgresPublicationEntryEvidence['boundaries']> {
  const reads = createPostgresPublicationSnapshotReadPort(runtime);
  const rootOnly = await reads.loadPage({
    collectionId: TARGET.collectionId,
    rootId: TARGET.rootId,
    depth: 0,
    limit: 1,
  });
  await runtime.pool.query(
    `update nodes set deleted_at = clock_timestamp()
      where collection_id = $1 and id = 'p2-n000002'`,
    [TARGET.collectionId],
  );
  const live = await reads.loadPage({ collectionId: TARGET.collectionId, limit: 2 });
  const final = await reads.loadPage({
    collectionId: TARGET.collectionId,
    limit: 2,
    after: { parentId: TARGET.rootId, position: 'F098', nodeId: 'p2-f098' },
  });
  const other = await reads.loadPage({ collectionId: OTHER.collectionId, limit: 2 });
  return {
    rootOnlyRootId: rootOnly.root?.id ?? null,
    rootOnlyCandidateIds: rootOnly.candidates.map((node) => node.id),
    liveLimitPlusOneIds: live.candidates.map((node) => node.id),
    finalPageIds: final.candidates.map((node) => node.id),
    otherCollectionIds: other.candidates.map((node) => node.id),
  };
}

interface ExplainPlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly ExplainPlanNode[];
}

interface ExplainPlan {
  readonly Plan: ExplainPlanNode;
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
}

async function capturePlans(runtime: DatabaseRuntime, pageSize: number): Promise<PlanEvidence[]> {
  const locations: ReadonlyArray<{
    readonly location: PlanEvidence['location'];
    readonly after?: {
      readonly parentId: string;
      readonly position: string;
      readonly nodeId: string;
    };
  }> = [
    { location: 'first' },
    {
      location: 'middle',
      after: { parentId: 'p2-f050', position: 'B050', nodeId: 'p2-n005000' },
    },
    {
      location: 'final',
      after: { parentId: TARGET.rootId, position: 'F098', nodeId: 'p2-f098' },
    },
  ];
  const plans: PlanEvidence[] = [];
  for (const entry of locations) {
    const statement = buildPublicationSnapshotCandidateStatement({
      collectionId: TARGET.collectionId,
      limit: pageSize,
      ...(entry.after ? { after: entry.after } : {}),
    });
    const result = await runtime.pool.query<{ 'QUERY PLAN': ExplainPlan[] }>(
      `explain (analyze, buffers, format json) ${statement.text}`,
      [...statement.values],
    );
    const plan = result.rows[0]?.['QUERY PLAN'][0];
    if (!plan) throw new Error(`Publication ${entry.location} EXPLAIN plan is missing`);
    const nodes = flattenPlan(plan.Plan);
    plans.push({
      location: entry.location,
      planningMs: plan['Planning Time'],
      executionMs: plan['Execution Time'],
      indexNames: nodes.flatMap((node) => node['Index Name'] ? [node['Index Name']] : []),
      hasSort: nodes.some((node) => node['Node Type'] === 'Sort'),
      hasNodesSequentialScan: nodes.some((node) =>
        node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'nodes'),
      returnedRows: plan.Plan['Actual Rows'] ?? Number.POSITIVE_INFINITY,
      rowLimit: pageSize + 1,
      sharedBufferBlocks: (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0),
    });
  }
  return plans;
}

function flattenPlan(root: ExplainPlanNode): ExplainPlanNode[] {
  return [root, ...(root.Plans ?? []).flatMap(flattenPlan)];
}

export function expectedPostgresPublicationEntryIds(nodeCount: number): string[] {
  const bookmarksPerFolder = nodeCount / FOLDERS - 1;
  const ids: string[] = [TARGET.rootId];
  for (let folder = 0; folder < FOLDERS; folder += 1) {
    for (let child = 1; child <= bookmarksPerFolder; child += 1) {
      const ordinal = folder * bookmarksPerFolder + child;
      ids.push(`p2-n${String(ordinal).padStart(6, '0')}`);
    }
  }
  for (let folder = 0; folder < FOLDERS; folder += 1) {
    ids.push(`p2-f${String(folder).padStart(3, '0')}`);
  }
  return ids;
}

function snapshotNextCursor(snapshot: Snapshot): string | null {
  const value = (snapshot.page as { readonly nextCursor: unknown }).nextCursor;
  if (value === null || typeof value === 'string') return value;
  throw new Error('COLP Snapshot page has an invalid nextCursor');
}

function latencySummary(values: readonly number[]): LatencySummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function timedWriter(write: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await write();
  return performance.now() - started;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
