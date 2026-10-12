import { digestJson } from '../bookmark-event-codec.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import type { SyncStoreRuntime } from './runtime.js';
import { STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type JsonObject, type SyncScope } from './types.js';

export type AdvancedStepState = 'pending' | 'executing' | 'terminal' | 'attention';
export interface AdvancedPlanRecord {
  readonly scopeKey: string; readonly planId: string; readonly digest: string;
  readonly metadata: JsonObject; readonly stepCount: number;
  readonly state: 'active' | 'completed' | 'attention'; readonly updatedAt: number;
}
export interface AdvancedStepRecord {
  readonly scopeKey: string; readonly planId: string; readonly order: number;
  readonly definition: JsonObject; readonly digest: string; readonly state: AdvancedStepState;
  readonly evidence?: JsonObject; readonly error?: string;
}

/** A plan becomes visible atomically with every immutable step. Execution only
 * changes progress; retries never regenerate the operation set from a new tree. */
export function createAdvancedRepository(ctx: SyncStoreRuntime) {
  const keyFor = (scope: SyncScope) => scopeKey(validateScope(scope));
  const verified = new Map<string, { digest: string; steps: readonly string[] }>();

  function remember(plan: AdvancedPlanRecord, steps: readonly AdvancedStepRecord[]) {
    if (verified.size >= 8) verified.clear();
    verified.set(`${plan.scopeKey}:${plan.planId}`, { digest: plan.digest, steps: steps.map((step) => step.digest) });
  }

  async function commitAdvancedPlan(scope: SyncScope, input: {
    readonly planId: string; readonly metadata: JsonObject; readonly steps: readonly JsonObject[];
    readonly now: number;
  }): Promise<AdvancedPlanRecord> {
    ctx.assertWritable(); const key = keyFor(scope);
    boundedString(input.planId, 'planId'); safeInteger(input.now, 'now', 1);
    if (input.steps.length > 100_000) throw new SyncStateError('advanced_plan_too_large');
    const steps: AdvancedStepRecord[] = input.steps.map((definition, order) => readStep({
      scopeKey: key, planId: input.planId, order, definition: clone(definition),
      digest: digestJson(definition), state: 'pending',
    }, key, ctx.maxRecordBytes));
    const digest = digestJson({ metadata: input.metadata, steps: steps.map((step) => step.digest) });
    let result = readPlan({ scopeKey: key, planId: input.planId, digest,
      metadata: clone(input.metadata), stepCount: steps.length, state: 'active', updatedAt: input.now,
    }, key, ctx.maxRecordBytes);
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.advancedPlans, STORES.advancedSteps], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const plans = tx.objectStore(STORES.advancedPlans);
      const prior = await requestValue(plans.get([key, input.planId]));
      if (prior) {
        result = readPlan(prior, key, ctx.maxRecordBytes);
        if (result.digest !== digest) throw new SyncStateError('advanced_plan_changed');
        return;
      }
      const all = await cursorPage<AdvancedPlanRecord>(plans, scopeRowsRange(key), 100_001);
      if (all.some((plan) => readPlan(plan, key, ctx.maxRecordBytes).state !== 'completed')) {
        throw new SyncStateError('advanced_plan_in_progress');
      }
      plans.add(result);
      for (const step of steps) tx.objectStore(STORES.advancedSteps).add(step);
    });
    return clone(result);
  }

  async function listAdvancedPlans(scope: SyncScope): Promise<AdvancedPlanRecord[]> {
    const key = keyFor(scope); const db = await ctx.open();
    const tx = db.transaction(STORES.advancedPlans, 'readonly'); const done = transactionDone(tx);
    const rows = await cursorPage(tx.objectStore(STORES.advancedPlans), scopeRowsRange(key), 100_001);
    await done;
    return rows.map((row) => readPlan(row, key, ctx.maxRecordBytes));
  }

  async function readAdvancedPlan(scope: SyncScope, planId: string): Promise<{
    readonly plan: AdvancedPlanRecord; readonly steps: readonly AdvancedStepRecord[];
  } | null> {
    const key = keyFor(scope); boundedString(planId, 'planId');
    const db = await ctx.open(); const tx = db.transaction([STORES.advancedPlans, STORES.advancedSteps], 'readonly');
    const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.advancedPlans).get([key, planId]));
    const rows = raw ? await cursorPage(tx.objectStore(STORES.advancedSteps),
      IDBKeyRange.bound([key, planId], [key, planId, []]), 100_001) : [];
    await done; if (!raw) return null;
    const plan = readPlan(raw, key, ctx.maxRecordBytes);
    const steps = rows.map((row) => readStep(row, key, ctx.maxRecordBytes));
    if (steps.length !== plan.stepCount || steps.some((step, order) => step.order !== order || step.planId !== planId)
        || digestJson({ metadata: plan.metadata, steps: steps.map((step) => step.digest) }) !== plan.digest) {
      verified.delete(`${key}:${planId}`);
      throw new SyncStateError('advanced_plan_corrupt');
    }
    remember(plan, steps);
    return { plan, steps };
  }

  async function settleAdvancedStep(scope: SyncScope, planId: string, order: number, input: {
    readonly expectedState: AdvancedStepState; readonly state: AdvancedStepState;
    readonly evidence?: JsonObject; readonly error?: string; readonly observedNativeId?: string;
  }): Promise<AdvancedStepRecord> {
    ctx.assertWritable(); const key = keyFor(scope); let result!: AdvancedStepRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.advancedPlans, STORES.advancedSteps], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const plan = readPlan(await requestValue(tx.objectStore(STORES.advancedPlans).get([key, planId])),
        key, ctx.maxRecordBytes);
      if (plan.state === 'completed') throw new SyncStateError('advanced_plan_completed');
      const steps = tx.objectStore(STORES.advancedSteps);
      const range = IDBKeyRange.bound([key, planId], [key, planId, []]);
      if (await requestValue(steps.count(range)) !== plan.stepCount) throw new SyncStateError('advanced_plan_corrupt');
      let commitment = verified.get(`${key}:${planId}`);
      if (!commitment || commitment.digest !== plan.digest) {
        const rows = (await cursorPage(steps, range, 100_001)).map((row) => readStep(row, key, ctx.maxRecordBytes));
        if (rows.some((row, index) => row.order !== index)
            || digestJson({ metadata: plan.metadata, steps: rows.map((row) => row.digest) }) !== plan.digest) {
          throw new SyncStateError('advanced_plan_corrupt');
        }
        remember(plan, rows); commitment = verified.get(`${key}:${planId}`)!;
      }
      const prior = readStep(await requestValue(steps.get([key, planId, order])), key, ctx.maxRecordBytes);
      if (commitment.steps[order] !== prior.digest) throw new SyncStateError('advanced_plan_corrupt');
      if (prior.state !== input.expectedState) throw new SyncStateError('advanced_step_stale');
      if (prior.state === 'terminal' || !validTransition(prior.state, input.state)) {
        throw new SyncStateError('advanced_step_transition_invalid');
      }
      const { error: _error, ...withoutError } = prior;
      const observations = Array.isArray(prior.evidence?.observedNativeIds) ? prior.evidence.observedNativeIds : [];
      const suppliedObservations = Array.isArray(input.evidence?.observedNativeIds)
        ? input.evidence.observedNativeIds : [];
      const evidence = input.evidence || input.observedNativeId
        ? { ...(prior.evidence ?? {}), ...(input.evidence ?? {}),
          ...(input.evidence?.observedNativeIds || input.observedNativeId ? {
            observedNativeIds: [...new Set([...observations, ...suppliedObservations,
              ...(input.observedNativeId ? [boundedString(input.observedNativeId, 'observedNativeId')] : [])])],
          } : {}) }
        : undefined;
      result = readStep({ ...withoutError, state: input.state,
        ...(evidence ? { evidence: clone(evidence) } : {}),
        ...(input.error ? { error: input.error } : {}),
      }, key, ctx.maxRecordBytes);
      steps.put(result);
      if (input.state === 'attention') tx.objectStore(STORES.advancedPlans).put({ ...plan, state: 'attention' });
    });
    return clone(result);
  }

  /** Atomically consume one browser callback as evidence of a durable local
   * plan step. The marker is deliberately separate from step state: a late
   * callback may arrive after the step became terminal, while a repeated
   * callback must fall through to normal user-event capture. */
  async function recordAdvancedEcho(scope: SyncScope, planId: string, order: number, input: {
    readonly stepDigest: string;
    readonly evidence: JsonObject;
  }): Promise<boolean> {
    ctx.assertWritable(); const key = keyFor(scope); boundedString(planId, 'planId');
    safeInteger(order, 'order'); boundedString(input.stepDigest, 'stepDigest');
    let consumed = false;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.advancedPlans, STORES.advancedSteps], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const plans = tx.objectStore(STORES.advancedPlans);
      const plan = readPlan(await requestValue(plans.get([key, planId])), key, ctx.maxRecordBytes);
      const steps = tx.objectStore(STORES.advancedSteps);
      const range = IDBKeyRange.bound([key, planId], [key, planId, []]);
      if (await requestValue(steps.count(range)) !== plan.stepCount) throw new SyncStateError('advanced_plan_corrupt');
      let commitment = verified.get(`${key}:${planId}`);
      if (!commitment || commitment.digest !== plan.digest) {
        const rows = (await cursorPage(steps, range, 100_001)).map((row) => readStep(row, key, ctx.maxRecordBytes));
        if (rows.some((row, index) => row.order !== index)
            || digestJson({ metadata: plan.metadata, steps: rows.map((step) => step.digest) }) !== plan.digest) {
          throw new SyncStateError('advanced_plan_corrupt');
        }
        remember(plan, rows); commitment = verified.get(`${key}:${planId}`)!;
      }
      const prior = readStep(await requestValue(steps.get([key, planId, order])), key, ctx.maxRecordBytes);
      if (commitment.steps[order] !== prior.digest || prior.digest !== input.stepDigest) {
        throw new SyncStateError('advanced_step_corrupt');
      }
      if (prior.state !== 'executing' && prior.state !== 'terminal') {
        throw new SyncStateError('advanced_step_stale');
      }
      if (prior.evidence?.echoObserved !== undefined) return;
      const evidence = { ...(prior.evidence ?? {}), echoObserved: clone(input.evidence) };
      steps.put(readStep({ ...prior, evidence }, key, ctx.maxRecordBytes)); consumed = true;
    });
    return consumed;
  }

  async function completeAdvancedPlan(scope: SyncScope, planId: string, now: number): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope); const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.advancedPlans, STORES.advancedSteps], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const plans = tx.objectStore(STORES.advancedPlans);
      const plan = readPlan(await requestValue(plans.get([key, planId])), key, ctx.maxRecordBytes);
      const steps = await cursorPage<AdvancedStepRecord>(tx.objectStore(STORES.advancedSteps),
        IDBKeyRange.bound([key, planId], [key, planId, []]), 100_001);
      if (steps.length !== plan.stepCount || steps.some((step) => readStep(step, key, ctx.maxRecordBytes).state !== 'terminal')) {
        throw new SyncStateError('advanced_plan_incomplete');
      }
      if (steps.some((step, order) => step.order !== order || step.planId !== planId)
          || digestJson({ metadata: plan.metadata, steps: steps.map((step) => step.digest) }) !== plan.digest) {
        throw new SyncStateError('advanced_plan_corrupt');
      }
      plans.put(readPlan({ ...plan, state: 'completed', updatedAt: now }, key, ctx.maxRecordBytes));
    });
  }

  return { commitAdvancedPlan, listAdvancedPlans, readAdvancedPlan, settleAdvancedStep, recordAdvancedEcho,
    completeAdvancedPlan };
}

function validTransition(before: AdvancedStepState, after: AdvancedStepState): boolean {
  return before === 'pending' ? after === 'executing' || after === 'attention'
    : before === 'executing' ? ['executing', 'terminal', 'attention'].includes(after)
      : before === 'attention' && after === 'executing';
}

function jsonObject(value: unknown): JsonObject {
  const result = validateJson(value, 'advanced');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SyncStateError('advanced_record_invalid');
  return result;
}

function readPlan(input: unknown, key: string, maxBytes: number): AdvancedPlanRecord {
  const row = strictObject(input, ['scopeKey', 'planId', 'digest', 'metadata', 'stepCount', 'state', 'updatedAt'], 'advanced plan');
  if (row.scopeKey !== key || !['active', 'completed', 'attention'].includes(String(row.state))) {
    throw new SyncStateError('advanced_record_invalid');
  }
  const plan: AdvancedPlanRecord = { scopeKey: key, planId: boundedString(row.planId, 'planId'),
    digest: boundedString(row.digest, 'digest'), metadata: jsonObject(row.metadata),
    stepCount: safeInteger(row.stepCount, 'stepCount'), state: row.state as AdvancedPlanRecord['state'],
    updatedAt: safeInteger(row.updatedAt, 'updatedAt', 1) };
  validateRecord(plan, maxBytes); return plan;
}

function readStep(input: unknown, key: string, maxBytes: number): AdvancedStepRecord {
  const row = strictObject(input, ['scopeKey', 'planId', 'order', 'definition', 'digest', 'state', 'evidence', 'error'],
    'advanced step', ['evidence', 'error']);
  if (row.scopeKey !== key || !['pending', 'executing', 'terminal', 'attention'].includes(String(row.state))) {
    throw new SyncStateError('advanced_record_invalid');
  }
  const definition = jsonObject(row.definition);
  if (row.digest !== digestJson(definition)) throw new SyncStateError('advanced_step_corrupt');
  const step: AdvancedStepRecord = { scopeKey: key, planId: boundedString(row.planId, 'planId'),
    order: safeInteger(row.order, 'order'), definition, digest: String(row.digest), state: row.state as AdvancedStepState,
    ...(row.evidence === undefined ? {} : { evidence: jsonObject(row.evidence) }),
    ...(row.error === undefined ? {} : { error: boundedString(row.error, 'error', 128) }) };
  validateRecord(step, maxBytes); return step;
}
