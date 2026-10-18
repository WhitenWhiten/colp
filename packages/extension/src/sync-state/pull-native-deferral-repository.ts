import { validateIntent } from './pull-validate.js';
import { pullDeferral, validatedPullDeferral } from '../pull-deferral.js';
import { projectUnresolvedNativeWait } from '../native-wait-open.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import { SyncStateError, type IntentRecord, type SyncScope, type UnknownRecord } from './types.js';

export function createPullNativeDeferralRepository(ctx: SyncStoreRuntime) {
  async function deferPullForNativeWait(input: SyncScope, eventId: string, intentId: string) {
    const key = scopeKey(validateScope(input)); ctx.assertWritable();
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.intents, STORES.pullEvents], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const events = tx.objectStore(STORES.pullEvents);
      const event = await requestValue<UnknownRecord | undefined>(events.get([key, eventId]));
      const intent = await requestValue<IntentRecord | undefined>(tx.objectStore(STORES.intents).get([key, intentId]));
      const original = intent?.eventId ? await requestValue<UnknownRecord | undefined>(events.get([key, intent.eventId])) : undefined;
      if (!event || event.state !== 'staged' || intent?.generation !== input.generation
          || !projectUnresolvedNativeWait(intent, original?.state) || original?.deferredNativeIntentId !== intentId) {
        throw new SyncStateError('pull_event_state_invalid');
      }
      events.put({ ...event, state: 'awaiting_confirmation', deferredNativeIntentId: intentId });
    });
  }
  async function resumeNativeWaitDependents(input: SyncScope) {
    const key = scopeKey(validateScope(input)); ctx.assertWritable();
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.intents, STORES.pullEvents], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const events = tx.objectStore(STORES.pullEvents);
      for (const event of await cursorPage<UnknownRecord>(events.index(INDEXES.pullEventByState), IDBKeyRange.bound([key, 'awaiting_confirmation'], [key, 'awaiting_confirmation', []]), Number.MAX_SAFE_INTEGER)) {
        const binding = pullDeferral(event);
        // Reopen waits persisted before page deferrals existed. Enroll only an
        // original, generation-bound unknown invocation; never invent a receipt.
        if (!binding && typeof event.intentId === 'string') {
          const intent = await requestValue<IntentRecord | undefined>(tx.objectStore(STORES.intents).get([key, event.intentId]));
          if (intent && intent.eventId === event.eventId && intent.generation === input.generation && projectUnresolvedNativeWait(intent, event.state)) {
            const { scopeKey: _scopeKey, ...prior } = intent;
            tx.objectStore(STORES.intents).put(validateIntent(key, { ...prior,
              suspendedCorrelationId: intent.suspendedCorrelationId ?? intent.correlationId,
              correlationId: `native-wait:${intent.intentId}` }, ctx.maxRecordBytes));
            events.put({ ...event, deferredNativeIntentId: intent.intentId });
          }
          continue;
        }
        if (event.state !== 'awaiting_confirmation' || binding?.kind !== 'native_result'
            || event.intentId === binding.id || !await validatedPullDeferral(tx, key, event, input.generation)) continue;
        const intent = await requestValue<IntentRecord>(tx.objectStore(STORES.intents).get([key, binding.id]));
        const original = await requestValue<UnknownRecord>(events.get([key, intent.eventId!]));
        if (original.state === 'page_complete' && intent.nativeWaitDecision?.action !== 'cancel') events.put({ ...event, state: 'staged' });
      }
    });
  }
  async function isPullDeferral(input: SyncScope, eventId: string): Promise<boolean> {
    const key = scopeKey(validateScope(input));
    let valid = false;
    await runTransaction(await ctx.open(), [STORES.pullEvents, STORES.intents, STORES.remoteDeleteDecisions], 'readonly', async tx => {
      const event = await requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.pullEvents).get([key, eventId]));
      valid = !!event && await validatedPullDeferral(tx, key, event, input.generation);
    });
    return valid;
  }
  return { deferPullForNativeWait, resumeNativeWaitDependents, isPullDeferral };
}
