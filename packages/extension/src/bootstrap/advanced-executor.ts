import type { createSyncStateStore, JsonObject, SyncScope } from '../sync-state-store.js';
import type { AdvancedStepRecord } from '../sync-state/advanced-repository.js';

type Store = ReturnType<typeof createSyncStateStore>;
export type StepOutcome = { readonly state: 'complete'; readonly evidence: JsonObject }
  | { readonly state: 'waiting' }
  | { readonly state: 'changed'; readonly code: string };

/** The adapter must observe an executing step before retrying a browser call.
 * It may replay a remote step only through its original durable queue opId. */
export interface AdvancedStepAdapter {
  apply(step: AdvancedStepRecord, completed: readonly AdvancedStepRecord[]): Promise<StepOutcome>;
}

export async function advanceConfirmedPlan(input: {
  readonly store: Store; readonly scope: SyncScope; readonly planId: string;
  readonly adapter: AdvancedStepAdapter; readonly now?: () => number;
  readonly assertAuthority?: () => Promise<void>;
}): Promise<'completed' | 'waiting' | 'attention'> {
  const loaded = await input.store.readAdvancedPlan(input.scope, input.planId);
  if (!loaded) throw new Error('advanced_plan_missing');
  if (loaded.plan.state === 'completed') return 'completed';
  const completed: AdvancedStepRecord[] = [];
  for (const original of loaded.steps) {
    if (original.state === 'terminal') { completed.push(original); continue; }
    if (original.state === 'attention') return 'attention';
    await input.assertAuthority?.();
    // Persist execution ownership before handing any side effect to the adapter.
    const step = await input.store.settleAdvancedStep(input.scope, input.planId, original.order,
      { expectedState: original.state, state: 'executing' });
    let outcome: StepOutcome;
    try { outcome = await input.adapter.apply({ ...step, state: original.state }, completed); }
    catch (error) {
      // A transport/API failure can occur after committing the side effect. Keep
      // executing so replay observes its result instead of treating it as new.
      if (error instanceof Error && error.message === 'advanced_step_changed') {
        await input.store.settleAdvancedStep(input.scope, input.planId, step.order,
          { expectedState: 'executing', state: 'attention', error: error.message });
        return 'attention';
      }
      throw error;
    }
    if (outcome.state === 'waiting') return 'waiting';
    if (outcome.state === 'changed') {
      await input.store.settleAdvancedStep(input.scope, input.planId, step.order,
        { expectedState: 'executing', state: 'attention', error: safeCode(outcome.code) });
      return 'attention';
    }
    completed.push(await input.store.settleAdvancedStep(input.scope, input.planId, step.order,
      { expectedState: 'executing', state: 'terminal', evidence: outcome.evidence }));
  }
  await input.store.completeAdvancedPlan(input.scope, input.planId, (input.now ?? Date.now)());
  return 'completed';
}

function safeCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : 'advanced_step_changed';
}
