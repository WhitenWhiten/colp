import type { operations } from '../../../server/generated/openapi/product-v1.js';
import type { CaptureTask } from './contracts.js';
import { classificationTriggerReason } from '../classification-intent.js';
export type AutomaticDecision = operations['getCaptureDecision']['responses'][200]['content']['application/json'];
export type AutomaticInput = operations['classifyCapturedBookmark']['requestBody']['content']['application/json'];
export interface AutomaticIntent {
  readonly document: AutomaticInput;
  readonly classifyCommandId: string;
  readonly applyCommandId: string;
  readonly applySubmitted: boolean;
  readonly applyState?: 'prepared' | 'outcome-unknown' | 'applied' | 'rejected';
  /** Durable request body identity; absent on legacy automatic intents. */
  readonly applyUserInitiated?: boolean;
  readonly decision: AutomaticDecision | null;
}
export interface AutomaticPorts {
  readonly now: () => number;
  read(): Promise<CaptureTask>;
  save(next: CaptureTask): Promise<void>;
  authorize(task: CaptureTask): Promise<string | null>;
  prepare(task: CaptureTask): Promise<AutomaticInput | null>;
  classify(intent: AutomaticIntent): Promise<AutomaticDecision>;
  get(decisionId: string): Promise<AutomaticDecision>;
  apply(intent: AutomaticIntent): Promise<AutomaticDecision>;
  mappedTarget(folderId: string): Promise<boolean>;
  uuid(): string;
}

/** Each paid intent and apply payload is durable before dispatch; recovery never invents a new execution. */
export async function advanceAutomaticCapture(ports: AutomaticPorts): Promise<CaptureTask> {
  let task = await ports.read();
  const write = async (patch: Partial<CaptureTask>) => {
    const next = { ...task, ...patch, revision: task.revision + 1, updatedAt: ports.now() };
    await ports.save(next); task = next;
  };
  if (classificationTriggerReason({ kind: 'saved-capture', task })) return task;
  if (task.automatic?.applySubmitted) {
    const decision = await ports.get(task.automatic.decision!.decisionId);
    if (decision.status === 'applied') await write({ classification: 'applied', classificationAppliedAt: task.classificationAppliedAt ?? ports.now(), decisionId: decision.decisionId,
      appliedRevision: decision.nodeEtag, automatic: { ...task.automatic, decision, applyState: 'applied' }, sync: 'syncing' });
    if (decision.status !== 'suggested' || task.automatic.applyState === 'rejected') return task;
    // A prepared/unknown request may never have reached the server. Continue through
    // current authorization and replay its durable command, body and precondition.

  }
  const reason = await ports.authorize(task);
  if (reason) { await write({ reason, ...(['manually_edited', 'authorization_expired', 'authorization_required', 'resume_disabled', 'execution_control_changed', 'manual', 'paused'].includes(reason) ? { ...(reason === 'manually_edited' ? { manualFence: task.manualFence + 1 } : {}), classification: 'manual' as const } : {}) }); return task; }
  if (!task.automatic) {
    const document = await ports.prepare(task);
    if (!document) { await write({ reason: 'awaiting_sync_receipt' }); return task; }
    await write({ automatic: { document, classifyCommandId: ports.uuid(), applyCommandId: ports.uuid(), applySubmitted: false, applyState: 'prepared', applyUserInitiated: false, decision: null },
      classification: 'running', reason: null });
  }
  const intent = task.automatic!;
  const decision = intent.decision ?? await ports.classify(intent);
  const afterClassification = await ports.read();
  if (afterClassification.manualFence || afterClassification.controlGeneration !== task.controlGeneration) {
    task = afterClassification;
    await write({ classification: 'manual', reason: 'manually_edited',
      automatic: { ...intent, decision }, decisionId: decision.decisionId, executionId: decision.executionId });
    return task;
  }
  task = afterClassification;
  await write({ automatic: { ...intent, decision }, decisionId: decision.decisionId, executionId: decision.executionId });
  if (decision.status === 'waiting' || decision.status === 'running') {
    // A replay of the SAME classified command retrieves its eventual receipt.
    await write({ automatic: { ...task.automatic!, decision: null } }); return task;
  }
  if (decision.status !== 'suggested' || !decision.suggestedParentId) {
    await write({ classification: 'manual', reason: decision.reason ?? 'classification_unavailable' }); return task;
  }
  const latest = await ports.read();
  const stopped = await ports.authorize(latest);
  if (latest.manualFence || latest.controlGeneration !== task.controlGeneration || stopped) {
    task = latest; await write({ classification: 'manual', reason: stopped ?? 'manually_edited' }); return task;
  }
  if (!await ports.mappedTarget(decision.suggestedParentId)) {
    await write({ classification: 'manual', reason: 'target_not_mapped' }); return task;
  }
  await write({ automatic: { ...task.automatic!, applySubmitted: true, applyState: 'outcome-unknown' } });
  const applied = await ports.apply(task.automatic!);
  if (applied.status === 'applied') await write({ classification: 'applied', classificationAppliedAt: task.classificationAppliedAt ?? ports.now(), appliedRevision: applied.nodeEtag,
    automatic: { ...task.automatic!, decision: applied, applyState: 'applied' }, sync: 'syncing' });
  return task;
}
