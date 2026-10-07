import { createCaptureHistory } from './capture-history.js';
import { createCaptureLearning } from './capture-learning.js';
import { createCaptureRuntime } from './capture-runtime.js';
import { APPROVED_CLASSIFICATION_PRIOR_EVALUATION,CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION,CLASSIFICATION_POLICY,eligibleClassificationPriorEvaluation,APPROVED_CLASSIFICATION_AUTO_CALIBRATION,eligibleAutoCalibration } from '../../modules/collections/index.js';
import { createProfileAwareClassificationProvider } from './classification-profile-provider.js';
import { createPostgresClassificationProfilesRuntime } from './classification-profiles-runtime.js';
import { createClassificationSecretProtector,type ClassificationSecretKey } from '../security/classification-secret-envelope.js';
import type { DatabaseRuntime } from '../database/index.js';
import type { DatabaseTransaction } from '../database/index.js';
import type { AccountCreditsPort } from '../../modules/identity/index.js';
import type { Metrics } from '../telemetry/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { createBookmarkClassificationProvider,classificationDeploymentIdentity } from './classification-provider-factory.js';
import { createPostgresClassificationSettingsRuntime } from './classification-settings-postgres.js';
import { createPostgresClassificationConfirmationUnitOfWork } from './classification-confirmation-postgres.js';
import { createPostgresClassificationRuntime } from './classification-runtime.js';
import { createPostgresClassificationRunRuntime } from './classification-run-runtime.js';

/**
 * D4: the secret-envelope protector is only constructed when the BYOK feature
 * gate is on. With the flag off (the default) no envelope decryption path exists
 * at all, so a leaked keyring alone cannot decrypt stored profile secrets.
 */
export function classificationSecretProtector(config:{byokEnabled?:boolean;secretKeys?:readonly ClassificationSecretKey[];fingerprintKey?:Buffer|null}){
  return config.byokEnabled===true&&config.secretKeys?.length&&config.fingerprintKey?createClassificationSecretProtector(config.secretKeys,config.fingerprintKey):null;
}

export function createPostgresClassificationServices(database:DatabaseRuntime,config:{enabled:boolean;tagsEnabled:boolean;batchEnabled:boolean;autoTagsEnabled?:boolean;
  managedAdmissionEnabled?:boolean;creditEnabled?:boolean;priorEnabled?:boolean;byokEnabled?:boolean;secretKeys?:readonly ClassificationSecretKey[];fingerprintKey?:Buffer|null;
  provider:Parameters<typeof createBookmarkClassificationProvider>[0]},metrics:Metrics,reportSourceInvalidation?:ReportSourceInvalidationOutboxPort,
  creditPortFactory?:(transaction:DatabaseTransaction,accountId:string)=>AccountCreditsPort,observeCredits?:()=>Promise<void>){
  const billing={managedAdmissionEnabled:config.managedAdmissionEnabled!==false,credits:creditPortFactory,creditEnabled:config.creditEnabled===true};
  const protector=classificationSecretProtector(config);
  const identity=classificationDeploymentIdentity(config.provider);
  const baseProvider=createProfileAwareClassificationProvider(database.db,createBookmarkClassificationProvider(config.provider),protector,{enabled:()=>config.byokEnabled===true});
  const priorEnabled=config.priorEnabled===true&&identity!==null&&eligibleClassificationPriorEvaluation(APPROVED_CLASSIFICATION_PRIOR_EVALUATION,{...identity,promptVersion:CLASSIFICATION_POLICY.promptVersion,candidateVersion:CLASSIFICATION_POLICY.candidateVersion});
  const provider=priorEnabled?{...baseProvider,policyVersion:CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION}:baseProvider;
  const classificationPreview = createPostgresClassificationRuntime(database.db,provider,{...billing,observeCredits,priorEnabled,enabled:config.enabled,tagsEnabled:config.tagsEnabled,
      onGauge:(name,value)=>metrics.gauge(name,value),cancelBackend:database.cancelBackend,onError:code=>metrics.increment(`classification.execution.${code}`)});
  return {
    classificationProfiles:createPostgresClassificationProfilesRuntime(database.db,protector,{enabled:()=>config.enabled&&config.byokEnabled===true,onError:code=>metrics.increment(`classification.profile.${code}`)}),
    classificationSettings:{...createPostgresClassificationSettingsRuntime(database.db),autoEnabled:config.autoTagsEnabled===true&&identity!==null&&eligibleAutoCalibration(APPROVED_CLASSIFICATION_AUTO_CALIBRATION,{...identity,policyVersion:CLASSIFICATION_POLICY.version,promptVersion:CLASSIFICATION_POLICY.promptVersion,candidateVersion:CLASSIFICATION_POLICY.candidateVersion})},
    classificationConfirmation:createPostgresClassificationConfirmationUnitOfWork(database.db,{reportSourceInvalidation}),
    classificationPreview,
    captureHistory: createCaptureHistory(database.db, () => metrics.increment('classification.capture.retention_error')),
    captureLearning: createCaptureLearning(database.db, config.priorEnabled === true, identity),
    captureRuntime: createCaptureRuntime(database.db, classificationPreview, { enabled: config.enabled, tagsEnabled: config.tagsEnabled, autoTagsEnabled: config.autoTagsEnabled === true,
      priorEnabled: config.priorEnabled === true, identity, onPriorError: () => metrics.increment('classification.capture.prior_unavailable'), reportSourceInvalidation }),
    classificationRuns:createPostgresClassificationRunRuntime(database.db,provider,{...billing,priorEnabled,enabled:()=>config.enabled&&config.batchEnabled,
      tagsEnabled:()=>config.tagsEnabled,profilesEnabled:()=>config.byokEnabled===true,reportSourceInvalidation,cancelBackend:database.cancelBackend,onError:code=>metrics.increment(`classification.run.${code}`)}),
  };
}
