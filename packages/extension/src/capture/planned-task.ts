import type { CaptureTask } from './contracts.js';
import type { PlannedNativeCommand } from '../site-adapters/planned-types.js';
export function createPlannedCaptureTask(command: PlannedNativeCommand, digest: string): CaptureTask {
  const b = command.bookmark; if (!b || command.kind !== 'bookmark') throw new Error('bookmarkCommandRequired');
  const now = Date.now();
  return { version: 1, captureId: crypto.randomUUID(), commandId: command.commandId, scope: b.scope, source: b.source,
    planned: { version: 1, planId: b.planId, effectId: b.effectId, logicalDigest: command.logicalDigest, resolvedDigest: digest,
      connectionId: command.connectionId, purpose: b.representation.purpose, classification: 'disabled', representation: b.representation, parent: command.parent },
    batchId: null, tabId: null, url: b.url, title: command.title, targetNativeId: command.parent.nativeId,
    insertPosition: 'bottom', saveAnother: true, allowUnverifiedCloud: false, createdAt: now, updatedAt: now, revision: 0,
    deviceId: command.deviceId, policyVersion: 'source-archive.v1', automaticIntent: false, disposition: 'new',
    save: 'unsubmitted', classification: 'none', sync: 'local-only', existence: null, nativeIntentId: null, nativeId: null,
    nodeId: null, executionId: null, decisionId: null, localLocation: null, cloudLocation: null, appliedRevision: null,
    manualFence: 0, controlGeneration: 0, reason: null };
}
