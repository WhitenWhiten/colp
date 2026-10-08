import { createProfileAwareClassificationProvider } from './classification-profile-provider.js';
import type { ClassificationSecretKey } from '../security/classification-secret-envelope.js';
import { classificationSecretProtector } from './classification-services.js';
import { APPROVED_CLASSIFICATION_AUTO_CALIBRATION } from '../../modules/collections/index.js';
import type { DatabaseRuntime } from '../database/index.js';
import type { Metrics } from '../telemetry/index.js';
import { createClassificationAutoTagOutboxRoute } from '../outbox/classification-auto-tag.js';
import { createPostgresReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { classificationDeploymentIdentity, createBookmarkClassificationProvider } from './classification-provider-factory.js';
import { createPostgresClassificationAutoTagProcessor } from './classification-auto-tag-process.js';
export function createPostgresClassificationAutoTagRoute(database:DatabaseRuntime,config:{enabled:boolean;tagsEnabled:boolean;autoTagsEnabled:boolean;
  creditEnabled?:boolean;byokEnabled?:boolean;secretKeys?:readonly ClassificationSecretKey[];fingerprintKey?:Buffer|null;
  provider:Parameters<typeof createBookmarkClassificationProvider>[0]},metrics:Metrics,reportCacheEnabled:boolean){
  metrics.gauge('classification.auto.calibration_ready',APPROVED_CLASSIFICATION_AUTO_CALIBRATION?1:0);
  const protector=classificationSecretProtector(config);
  const provider=createProfileAwareClassificationProvider(database.db,createBookmarkClassificationProvider(config.provider),protector,{enabled:()=>config.byokEnabled===true});
  return createClassificationAutoTagOutboxRoute(createPostgresClassificationAutoTagProcessor(database.db,provider,{
    managedEnabled:()=>config.creditEnabled!==true,profilesEnabled:()=>config.byokEnabled===true,enabled:()=>config.enabled&&config.tagsEnabled&&config.autoTagsEnabled,calibration:()=>APPROVED_CLASSIFICATION_AUTO_CALIBRATION,
    identity:classificationDeploymentIdentity(config.provider),
    metric:code=>metrics.increment(`classification.auto.${code}`),cancelBackend:database.cancelBackend,
    ...(reportCacheEnabled?{reportSourceInvalidation:createPostgresReportSourceInvalidationOutboxPort()}:{}),
  }));
}
