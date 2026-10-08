import {CLASSIFICATION_POLICY,type ClassificationAutoCalibration} from '../../src/modules/collections/index.js';
import type {ClassificationDeploymentIdentity} from '../../src/infrastructure/collections/classification-provider-factory.js';
/** Synthetic deployment identity for pipeline tests; production derives it from BOOKMARK_CLASSIFICATION_* config. */
export const SYNTHETIC_DEPLOYMENT_IDENTITY:ClassificationDeploymentIdentity={providerId:'cloudflare_jev',model:'typesafe/jev',modelVersion:'jev-1.13.0'};
/** Artificial approval ONLY for pipeline tests. Never a model-quality result or production registry entry. */
export const SYNTHETIC_PIPELINE_CALIBRATION:ClassificationAutoCalibration={tagSemanticsVersion:'tag-semantics.v1',...SYNTHETIC_DEPLOYMENT_IDENTITY,policyVersion:CLASSIFICATION_POLICY.version,
  promptVersion:CLASSIFICATION_POLICY.promptVersion,candidateVersion:CLASSIFICATION_POLICY.candidateVersion,threshold:0.9,
  calibration:{truePositives:500,falsePositives:0},holdout:{truePositives:500,falsePositives:0},calibrationHash:'a'.repeat(64),holdoutHash:'b'.repeat(64),provenance:'synthetic_user_waiver'};
