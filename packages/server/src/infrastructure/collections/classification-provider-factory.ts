import { CLASSIFICATION_POLICY, ClassificationProviderError, type BookmarkClassificationProvider } from '../../modules/collections/index.js';
import {
  createCloudflareJevClassificationProvider,
  createClassificationUpstream,
  createCloudflareUpstream,
  DEFAULT_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  MIN_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  MAX_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  type ClassificationUpstream,
  type ClassificationUpstreamConfig,
  type ClassificationWire,
  type CloudflareClassificationConfig,
} from './classification-provider-cloudflare-jev.js';

export {
  createCloudflareJevClassificationProvider,
  createClassificationUpstream,
  createCloudflareUpstream,
  DEFAULT_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  MIN_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  MAX_CLASSIFICATION_REQUEST_TIMEOUT_MS,
  type ClassificationUpstream,
  type ClassificationUpstreamConfig,
  type ClassificationWire,
  type CloudflareClassificationConfig,
};

/**
 * Calibration certificates bind an exact upstream identity. Alias mode has no
 * pinned version, so it cannot bind one and calibration-gated features stay off.
 */
export interface ClassificationDeploymentIdentity {
  readonly providerId: string; readonly model: string; readonly modelVersion: string;
}

export function classificationDeploymentIdentity(upstream: ClassificationUpstream | null): ClassificationDeploymentIdentity | null {
  if (!upstream || !upstream.expectedModelVersion) return null;
  return {providerId: upstream.id, model: upstream.model, modelVersion: upstream.expectedModelVersion};
}

export function createBookmarkClassificationProvider(upstream: ClassificationUpstream | null): BookmarkClassificationProvider {
  if(upstream)return createCloudflareJevClassificationProvider(upstream);
  return {id:'cloudflare_jev',model:'typesafe/jev',policyVersion:CLASSIFICATION_POLICY.version,promptVersion:CLASSIFICATION_POLICY.promptVersion,
    capabilities:{idempotency:false},classify:async()=>{throw new ClassificationProviderError('disabled');}};
}

