import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const syncRuntime = new URL('../../../src/bootstrap/sync-session-runtime.ts', import.meta.url);
const apiBootstrap = new URL('../../../src/bootstrap/api.ts', import.meta.url);
const push = new URL('../../../src/infrastructure/sync/sync-push-postgres.ts', import.meta.url);
const pushCreateUpdate = new URL('../../../src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', import.meta.url);
const pushMoveDelete = new URL('../../../src/infrastructure/sync/postgres/sync-push-move-delete-postgres.ts', import.meta.url);
const conflict = new URL('../../../src/infrastructure/sync/sync-conflict-resolution-postgres.ts', import.meta.url);
const conflictHelper = new URL('../../../src/infrastructure/sync/report-source-invalidation.ts', import.meta.url);
const productSync = new URL('../../../src/infrastructure/sync/product-sync-center-postgres.ts', import.meta.url);
const apiPostgresPorts = new URL('../../../src/bootstrap/api-postgres-ports.ts', import.meta.url);
const mcpComposition = new URL('../../../src/bootstrap/mcp-write-composition.ts', import.meta.url);
const mcpPorts = new URL('../../../src/bootstrap/mcp-write-postgres-ports.ts', import.meta.url);
const mcpSurface = new URL('../../../src/bootstrap/api-mcp-surface-composition.ts', import.meta.url);
const organize = new URL('../../../src/infrastructure/collections/organize-plan-postgres.ts', import.meta.url);
const collectionVersions = new URL('../../../src/infrastructure/collections/collection-tree-version-postgres.ts', import.meta.url);
const classifyAccept = new URL('../../../src/infrastructure/collections/classify-inbox-accept-postgres.ts', import.meta.url);
const publisher = new URL('../../../src/infrastructure/publisher/canonical-unit-of-work.ts', import.meta.url);

describe('ND-13B Sync report source invalidation wiring', () => {
  test('composes one optional invalidation port through runtime and API bootstrap', async () => {
    const [runtime, api, pushSource, conflictSource, productSource, apiPorts, mcp, mcpApi, mcpPortsSource, organizeSource, versionsSource, classifySource, publisherSource] = await Promise.all([
      readFile(syncRuntime, 'utf8'),
      readFile(apiBootstrap, 'utf8'),
      readFile(push, 'utf8'),
      readFile(conflict, 'utf8'),
      readFile(productSync, 'utf8'),
      readFile(apiPostgresPorts, 'utf8'),
      readFile(mcpComposition, 'utf8'),
      readFile(mcpSurface, 'utf8'),
      readFile(mcpPorts, 'utf8'),
      readFile(organize, 'utf8'),
      readFile(collectionVersions, 'utf8'),
      readFile(classifyAccept, 'utf8'),
      readFile(publisher, 'utf8'),
    ]);
    expect(runtime).toMatch(/reportSourceInvalidation/iu);
    expect(api).toMatch(/reportSourceInvalidation/iu);
    expect(pushSource).toMatch(/createPostgresSyncPushApplication[\s\S]*PostgresSyncNodeCreateOptions/iu);
    expect(conflictSource).toMatch(/reportSourceInvalidation/iu);
    expect(productSource).toMatch(/reportSourceInvalidation/iu);
    expect(apiPorts).toMatch(/productSyncCenterUnitOfWork[\s\S]*reportSourceInvalidation/iu);
    expect(mcp).toMatch(/createPostgresCanonicalMutationUnitOfWork[\s\S]*reportSourceInvalidation/iu);
    expect(mcp).toMatch(/createPostgresAnnotationMutationUnitOfWork[\s\S]*reportSourceInvalidation/iu);
    expect(mcp).toMatch(/createMcpWriteProductPorts[\s\S]*reportSourceInvalidation/iu);
    expect(mcpPortsSource).toMatch(/createPostgresCanonicalMutationPorts[\s\S]*reportSourceInvalidation/iu);
    expect(mcpApi).toMatch(/createPhase4bMcpWriteComposition[\s\S]*reportSourceInvalidation/iu);
    expect(organizeSource).toMatch(/createOrganizePlanCanonicalPorts[\s\S]*reportSourceInvalidation/iu);
    expect(versionsSource).toMatch(/createCollectionVersionCanonicalPorts[\s\S]*reportSourceInvalidation/iu);
    expect(classifySource).toMatch(/createClassificationCanonicalPorts\(transaction, options\)/u);
    const classificationPorts = await readFile(new URL('../../../src/infrastructure/collections/classification-canonical-ports.ts', import.meta.url), 'utf8');
    expect(classificationPorts).toMatch(/createPostgresCanonicalMutationPorts[\s\S]*reportSourceInvalidation/iu);
    expect(publisherSource).toMatch(/createPostgresCanonicalMutationPorts[\s\S]*reportSourceInvalidation/iu);
  });

  test('passes the source fan-out option to every Sync canonical mutation evaluator', async () => {
    const [createUpdate, moveDelete, conflictSource, helperSource] = await Promise.all([
      readFile(pushCreateUpdate, 'utf8'),
      readFile(pushMoveDelete, 'utf8'),
      readFile(conflict, 'utf8'),
      readFile(conflictHelper, 'utf8'),
    ]);
    expect(createUpdate.match(/reportSourceInvalidation/giu)?.length).toBeGreaterThanOrEqual(2);
    expect(moveDelete.match(/reportSourceInvalidation/giu)?.length).toBeGreaterThanOrEqual(2);
    expect(conflictSource).toMatch(/canonicalApplication[\s\S]*reportSourceInvalidation/iu);
    expect(helperSource).toMatch(/sync:conflict-dismissed/iu);
  });
});
