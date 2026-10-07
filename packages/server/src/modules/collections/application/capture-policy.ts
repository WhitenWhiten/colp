import { CAPTURE_POLICY_VERSION } from './capture-contracts.js';
import { CLASSIFICATION_POLICY } from './classification-policy.js';

export interface CaptureFolderCalibration {
  readonly policyVersion: string;
  readonly providerId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly candidateVersion: string;
  readonly threshold: number;
  readonly calibrationHash: string;
  readonly holdoutHash: string;
  readonly correct: number;
  readonly wrong: number;
  readonly provenance: 'human';
}
/**
 * Optional, version-bound confidence bar for automatic filing. Automatic capture applies the
 * classifier's folder decision when the feature is enabled; a calibration that passes this
 * gate only adds a minimum confidence on top.
 */
export const APPROVED_CAPTURE_FOLDER_CALIBRATION: CaptureFolderCalibration | null = null;

export function captureFolderGate(
  value: CaptureFolderCalibration | null,
  identity?: { readonly providerId: string; readonly modelVersion: string }
): value is CaptureFolderCalibration {
  if (!value || !identity || value.policyVersion !== CAPTURE_POLICY_VERSION || value.provenance !== 'human'
    || value.providerId !== identity.providerId || value.modelVersion !== identity.modelVersion
    || value.promptVersion !== CLASSIFICATION_POLICY.promptVersion || value.candidateVersion !== CLASSIFICATION_POLICY.candidateVersion
    || !Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > 1
    || !/^[a-f0-9]{64}$/u.test(value.calibrationHash) || !/^[a-f0-9]{64}$/u.test(value.holdoutHash)
    || value.calibrationHash === value.holdoutHash || !Number.isSafeInteger(value.correct) || !Number.isSafeInteger(value.wrong)
    || value.correct < 0 || value.wrong < 0) return false;
  const n = value.correct + value.wrong;
  if (n < 200) return false;
  const p = value.wrong / n, z = 1.959963984540054, z2 = z * z;
  const upper = (p + z2 / (2 * n) + z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  return upper <= 0.05;
}
