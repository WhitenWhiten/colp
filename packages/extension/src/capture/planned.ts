import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../canonical-json.js';
import type { CaptureTask } from './contracts.js';
import type { NativeBinding, RepresentationKey } from '../site-adapters/contracts.js';
export interface PlannedCaptureMetadata {
  readonly version: 1; readonly planId: string; readonly effectId: string; readonly logicalDigest: string; readonly resolvedDigest: string;
  readonly connectionId: string; readonly purpose: 'sourceArchive' | 'semantic'; readonly classification: 'disabled' | 'authorizedSemantic';
  readonly representation: RepresentationKey; readonly parent: NativeBinding<'folder'>;
  readonly acknowledged?: boolean;
}
export function plannedPayloadDigest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value, () => { throw new Error('invalidData'); }))))}`;
}
export function plannedCaptureDigest(task: CaptureTask): string {
  if (!task.planned) throw new Error('planned_metadata_required');
  const { acknowledged: _acknowledged, ...planned } = task.planned;
  const command = { planned, scope: task.scope, source: task.source, title: task.title, url: task.url, targetNativeId: task.targetNativeId,
    insertPosition: task.insertPosition, saveAnother: task.saveAnother, allowUnverifiedCloud: task.allowUnverifiedCloud,
    automaticIntent: task.automaticIntent, annotation: task.annotation ?? null };
  return plannedPayloadDigest(command);
}
let guard: (task: CaptureTask) => Promise<void> = async () => { throw new Error('planned_authority_unavailable'); };
export function installPlannedCaptureGuard(check: (task: CaptureTask) => Promise<void>) { guard = check; }
export async function assertPlannedCaptureAuthority(task: CaptureTask) { if (task.planned) await guard(task); }
export function assertPlannedTask(task: CaptureTask) {
  const p = task.planned;
  if (!p || p.version !== 1 || !p.planId || !p.effectId || p.parent.nativeId !== task.targetNativeId || !task.saveAnother
    || p.representation.connectionId !== p.connectionId || p.representation.purpose !== p.purpose) throw new Error('planned_capture_invalid');
  if (p.purpose === 'sourceArchive' && (p.classification !== 'disabled' || task.automaticIntent || task.classification !== 'none'
    || task.local || task.billingAuthorization || task.automatic || task.automation || task.annotation)) throw new Error('source_archive_classification_forbidden');
}

let nativeFault: (point: string, commandId: string) => Promise<void> = async () => undefined;
/** Installed only by the development evidence harness; production has no RPC for it. */
export function installPlannedNativeFault(hook: typeof nativeFault) { nativeFault = hook; }
export function plannedNativeFault(point: string, commandId: string) { return nativeFault(point, commandId); }
