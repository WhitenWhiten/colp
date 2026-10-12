import type { FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
import type { DatabaseRuntime } from '../../server/src/infrastructure/database/index.js';
import type { CapturePreview } from '../../server/src/modules/collections/index.js';
import { createCaptureRuntime } from '../../server/src/infrastructure/collections/capture-runtime.js';
import { createCaptureHistory } from '../../server/src/infrastructure/collections/capture-history.js';
import { createCaptureLearning } from '../../server/src/infrastructure/collections/capture-learning.js';
import { registerCaptureRoutes } from '../../server/src/transport/product/capture-routes.js';
import { registerCaptureHistoryRoutes } from '../../server/src/transport/product/capture-history-routes.js';
import { registerCaptureLearningRoutes } from '../../server/src/transport/product/capture-learning-routes.js';
import { createPostgresIdentityUnitOfWork } from '../../server/src/infrastructure/identity/index.js';
import { createFixedWindowRateLimiter } from '../../server/src/transport/http-security.js';
import { externalBackendOrigin, pointExtensionBuildConfig, skippedInProcessProductStack } from './external-backend.js';
import type { CaptureProductFixture } from './cloud-product-fixtures.js';

// Know-N backend only; see cloud-product-fixtures.ts.
export function mountCaptureProductFixture(app: FastifyInstance, database: DatabaseRuntime, preview: CapturePreview, origins: readonly string[], synthetic: boolean): CaptureProductFixture {
  // create-user via the server CLI is a precondition; see external-backend.ts.
  const origin = externalBackendOrigin();
  if (origin) {
    pointExtensionBuildConfig(origin);
    return skippedInProcessProductStack('capture-product-stack');
  }
  // Pipeline-only test seam. These fixture counts are NOT an approval artifact or a real quality sample.
  const runtime = createCaptureRuntime(database.db, preview, { enabled: true, identity: { providerId: 'cloudflare_jev', model: 'typesafe/jev', modelVersion: 'jev-1.13.0' }, calibration: synthetic ? {
    policyVersion: 'capture-folder.v1', providerId: 'cloudflare_jev', modelVersion: 'jev-1.13.0', promptVersion: 'l1-description-c-v2',
    candidateVersion: 'candidates.v1', threshold: 0.9, calibrationHash: 'a'.repeat(64), holdoutHash: 'b'.repeat(64),
    correct: 200, wrong: 0, provenance: 'human',
  } : null });
  const common = { identityUnitOfWork: createPostgresIdentityUnitOfWork(database.db), allowedOrigins: origins,
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1000, windowMs: 60000 }) };
  registerCaptureRoutes(app, { ...common, runtime });
  registerCaptureHistoryRoutes(app, { ...common, runtime: createCaptureHistory(database.db) });
  registerCaptureLearningRoutes(app, { ...common, runtime: createCaptureLearning(database.db, false) });
  return {
    async facts() {
      const decisions = await database.db.selectFrom('bookmark_capture_decisions').select(['id', 'capture_id', 'node_id', 'status', 'execution_id', 'applied_at']).execute();
      const events = await database.db.selectFrom('bookmark_capture_feedback').select(['kind', 'learning_eligible', 'evidence_generation']).execute();
      const charges = await database.db.selectFrom('credit_charges').select(['id', 'state']).execute();
      return { decisions, events, charges };
    },
  };
}
