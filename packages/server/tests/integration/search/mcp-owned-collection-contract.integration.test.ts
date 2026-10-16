import assert from 'node:assert/strict';
import { beforeAll, afterAll, test } from 'vitest';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresOwnedCollectionsReadPort } from '../../../src/infrastructure/collections/index.js';
import { createPostgresLibraryCollectionUnitOfWork } from '../../../src/infrastructure/collections/library-collection-postgres.js';
import { createProductOwnedCollectionsCursorSigner, type LibraryCollection } from '../../../src/modules/collections/index.js';
import { createPhase4bMcpOwnedCollectionCreateService, callOwnedCollectionsListTool } from '../../../src/modules/mcp/owned-collection-mcp.js';
import { createPhase4bMcpLowRiskCollectionUpdateService } from '../../../src/modules/mcp/low-risk-collection-update.js';
import { createPhase4bMcpWriteComposition, createPhase4bMcpLowRiskNodeCreateInspect, createMcpChangePlanRateLimitPort, createAuthoritativeState } from '../../../src/bootstrap/mcp-write-composition.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import { createPhase4bMcpGatewayPlanner } from '../../../src/modules/mcp/change-plan-gateway-planner.js';

const account = Buffer.alloc(16, 131).toString('base64url');
const subject = Buffer.alloc(16, 132).toString('base64url');
const binding = { kind: 'authenticated' as const, principalId: account, clientId: 'library-agent',
  credentialBindingId: 'library-binding', resourceAudience: 'colp://known/collections', securityEpoch: '0' };
const context = { binding, accountSubjectId: subject, scope: ['collections:create', 'nodes:write', 'collections:write', 'nodes:delete', 'access:write'] };
const protectedError = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'library_protected';

describeWithPostgres('MCP agents use one private bookmark library', () => {
  let isolated: IsolatedPostgresRuntime;
  let library: LibraryCollection;
  const cursors = createProductOwnedCollectionsCursorSigner({ current: { id: 'library-agent', key: 'library-agent-cursor-signing-secret' } });
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('mcp_account_library', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query("INSERT INTO accounts(id,subject_id,status,security_epoch) VALUES ($1,$2,'active',0)", [account, subject]);
  }, 120_000);
  afterAll(async () => { cursors.destroy(); await isolated?.close(); });

  test('collections.list ensures and marks the library for a fresh account', async () => {
    const callContext = createMcpApplicationContext({ principal: binding, scopes: ['mcp:read:own'],
      abortSignal: new AbortController().signal, budgets: { maxDepth: 10, maxNodes: 100, maxBytes: 65536, maxOperations: 10 },
      correlationId: 'library-agent-list', authorization: { accountSubjectId: subject } });
    const result = await callOwnedCollectionsListTool({ reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
      cursors, clock: { now: async () => new Date() }, libraryCollectionUnitOfWork: createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db),
    }, callContext);
    assert.equal(result.kind, 'complete');
    if (result.kind !== 'complete') throw new Error('expected a library');
    const output = result.structuredContent as { collections: { id: string; library: boolean }[] };
    assert.equal(output.collections.length, 1);
    assert.equal(output.collections[0]?.library, true);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), output);
    const service = createPhase4bMcpOwnedCollectionCreateService({ libraryCollectionUnitOfWork: createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db) });
    await assert.rejects(service.execute({}, context), (error: unknown) => {
      assert.ok(protectedError(error));
      assert.ok(error instanceof Error && error.message.includes('nodes.create'));
      library = (error as Error & { library: LibraryCollection }).library;
      for (const id of [library.id, library.bookmarksBarId, library.otherBookmarksId]) assert.ok((error as Error).message.includes(id));
      return true;
    });
    const collections = await isolated.runtime.db.selectFrom('collections').select('id').where('owner_subject_id', '=', subject).execute();
    assert.equal(collections.length, 1);
  });

  test('collections.update refuses every library publication field in apply and preview', async () => {
    const row = await isolated.runtime.db.selectFrom('collections').selectAll().where('id', '=', library.id).executeTakeFirstOrThrow();
    const service = createPhase4bMcpLowRiskCollectionUpdateService({
      unitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      inspect: createPhase4bMcpLowRiskNodeCreateInspect(isolated.runtime.db),
    });
    for (const patch of [{ visibility: 'private' }, { visibility: 'public' }, { publicationSlug: 'library-slug' }, { allowSearchIndexing: true }]) {
      for (const dryRun of [undefined, true]) await assert.rejects(service.execute({ collectionId: library.id,
        baseRevision: row.resource_revision, patch, ...(dryRun ? { dryRun } : {}),
      }, context), protectedError);
    }
  });

  test('collection visibility plans and role-folder structural plans fail before an approval is created', async () => {
    const row = await isolated.runtime.db.selectFrom('collections').selectAll().where('id', '=', library.id).executeTakeFirstOrThrow();
    const composition = createPhase4bMcpWriteComposition({ db: isolated.runtime.db,
      serverUuid: '3ec3775d-48f1-42c4-8b54-0754f866c647', approvalBaseUri: 'https://app.example.test/approvals',
      requestStateKey: 'library-agent-request-state-secret-32-bytes', rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 20, windowMs: 60_000 }),
    });
    const planner = createPhase4bMcpGatewayPlanner(composition.changePlanOptions);
    for (const visibility of ['private', 'public', 'unlisted']) await assert.rejects(runWithMcpAccountSubjectId(subject, () => planner.plan({
      operations: [{ type: 'set_visibility', collectionId: library.id, baseRevision: row.resource_revision, input: { visibility } }],
    }, binding, context.scope)), protectedError);
    const state = createAuthoritativeState(isolated.runtime.db);
    await assert.rejects(runWithMcpAccountSubjectId(subject, () => state.resolveMovePlacement({
      collectionId: library.id, nodeId: library.bookmarksBarId, parentId: library.rootNodeId, afterId: null, beforeId: null,
    }, binding)), protectedError);
    await assert.rejects(runWithMcpAccountSubjectId(subject, () => state.resolveDeleteSubtree({
      collectionId: library.id, nodeId: library.otherBookmarksId,
    }, binding)), protectedError);
    assert.equal((await isolated.runtime.db.selectFrom('mcp_change_plans').select('plan_id').execute()).length, 0);
  });
});
