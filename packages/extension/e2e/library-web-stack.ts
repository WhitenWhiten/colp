import { registerProductSyncCenterRoutes } from '../../server/src/transport/product/product-sync-center-routes.js';
import { createPostgresProductSyncCenterUnitOfWork } from '../../server/src/infrastructure/sync/product-sync-center-postgres.js';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
import type { AppConfig } from '../../server/src/bootstrap/config.js';
import type { DatabaseRuntime } from '../../server/src/infrastructure/database/runtime.js';
import type { IdentityUnitOfWork } from '../../server/src/modules/identity/index.js';
import { createPostgresCollectionsUnitOfWork, createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresLibraryOrderCommandUnitOfWork, createPostgresLibraryOrderQueryUnitOfWork,
  createPostgresAnnotationReadUnitOfWork, createPostgresAnnotationMutationUnitOfWork } from '../../server/src/infrastructure/collections/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../server/src/infrastructure/collections/canonical-product-unit-of-work.js';
import { createPostgresLibraryCollectionUnitOfWork } from '../../server/src/infrastructure/collections/library-collection-postgres.js';
import { createPostgresFolderShareUnitOfWork } from '../../server/src/infrastructure/publication/folder-shares-postgres.js';
import { createPostgresPublicFolderShareReadPort } from '../../server/src/infrastructure/publication/folder-share-public-postgres.js';
import { createPostgresProductPublicCollectionLocatorReadPort, createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationSnapshotReadPort } from '../../server/src/infrastructure/publication/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../server/src/infrastructure/identity/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../server/src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort } from '../../server/src/infrastructure/database/index.js';
import { createProductEditorCursorSigner, createProductAnnotationCursorSigner } from '../../server/src/modules/collections/index.js';
import { createPublicationCursorKeyring } from '../../server/src/modules/publication/index.js';
import { registerCollectionRoutes } from '../../server/src/transport/product/collection-routes.js';
import { registerLibraryOrderRoutes } from '../../server/src/transport/product/library-order-routes.js';
import { registerProductPublicCollectionRoutes } from '../../server/src/transport/product/product-public-collection-routes.js';
import { createFixedWindowRateLimiter, createMemorySearchRateLimiter } from '../../server/src/transport/http-security.js';

/** The real web bundle and real Product routes share the isolated extension server. */
export async function mountLibraryWebFixture(app: FastifyInstance, runtime: DatabaseRuntime, config: AppConfig,
  identityUnitOfWork: IdentityUnitOfWork): Promise<void> {
  registerProductSyncCenterRoutes(app, { config, identityUnitOfWork,
    unitOfWork: createPostgresProductSyncCenterUnitOfWork(runtime.db, { cursorSecret: 'resilience-e2e-sync-center-cursor-secret',
      conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 31), keyVersion: 1 }, retained: [] } }) });
  const editor = createProductEditorCursorSigner({ current: config.productEditorCursor.current });
  const annotation = createProductAnnotationCursorSigner({ current: config.productEditorCursor.current });
  const cursors = createPublicationCursorKeyring({ active: { id: 'web-library', secret: Buffer.alloc(32, 29).toString('base64') }, retained: [] });
  app.addHook('onClose', async () => { cursors.destroy(); });
  registerCollectionRoutes(app, { config, identityUnitOfWork,
    collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db), libraryCollectionUnitOfWork: createPostgresLibraryCollectionUnitOfWork(runtime.db),
    productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db), collectionMetadataMutationsEnabled: true,
    collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(runtime.db, { cursorSigner: editor, cursorTtlMs: 60_000 }),
    annotationReadUnitOfWork: createPostgresAnnotationReadUnitOfWork(runtime.db, { cursorSigner: annotation, cursorTtlMs: 60_000 }),
    annotationMutationUnitOfWork: createPostgresAnnotationMutationUnitOfWork(runtime.db), folderShares: createPostgresFolderShareUnitOfWork(runtime.db),
  });
  registerLibraryOrderRoutes(app, { allowedOrigins: config.allowedOrigins, identityUnitOfWork,
    commandUnitOfWork: createPostgresLibraryOrderCommandUnitOfWork(runtime.db), queryUnitOfWork: createPostgresLibraryOrderQueryUnitOfWork(runtime.db),
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1000, windowMs: 60_000 }), timeoutMs: 10_000 });
  registerProductPublicCollectionRoutes(app, { identityUnitOfWork,
    rateLimiter: createMemorySearchRateLimiter({ anonymousMaxRequests: 1000, accountMaxRequests: 1000, windowMs: 60_000 }),
    query: { folderShares: createPostgresPublicFolderShareReadPort(runtime.db),
      locators: createPostgresProductPublicCollectionLocatorReadPort(runtime), viewCounts: createPostgresProductPublicCollectionViewCountReadPort(runtime), cursors,
      owners: createPostgresPublicProfileFactsReadPort(runtime), snapshot: { reads: createPostgresPublicationSnapshotReadPort(runtime),
        accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db), cursors, origin: config.productOrigin!, sharedExposure: createPostgresSharedExposureFactsPort(runtime) } } });
  const directory = resolve(import.meta.dirname, '../../web/dist');
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
  for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = resolve(file.parentPath, file.name), relative = path.slice(directory.length + 1);
    app.get('/' + relative, async (_request, reply) => reply.type(mime[extname(file.name)] ?? 'application/octet-stream').send(await readFile(path)));
  }
  for (const path of ['/', '/login', '/sync', '/library', '/library/:id', '/c/:slug']) {
    app.get(path, async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(resolve(directory, 'index.html'))));
  }
}
