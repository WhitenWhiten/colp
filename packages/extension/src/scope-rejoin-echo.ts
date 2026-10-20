import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Standalone rejoin intents have no Pull event. Their native receipt owns only that exact callback. */
export async function isRejoinEcho(input: { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope;
  kind: string; nativeId: string; correlationId: string; allowCompleted?: boolean; fields?: JsonObject }): Promise<boolean> {
  for (const intent of await input.store.listApplyIntents(input.scope)) {
    if (intent.liveWorkKind !== 'rejoin' || intent.generation !== input.scope.generation
      || intent.expiresAt <= Date.now() || intent.expected.kind !== input.kind
      || !['browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete'].includes(intent.state ?? '')) continue;
    if (intent.state === 'page_complete' && input.allowCompleted === false) continue;
    if (input.kind === 'create') {
      const nativeId = intent.apiResultEvidence?.nativeId ?? intent.nativeResultConfirmation?.nativeId;
      if (nativeId !== input.nativeId) continue;
      const mapping = await input.store.getMappingByNativeId(input.scope, input.nativeId);
      if (mapping && mapping.colpId !== intent.colpId) continue;
      return true;
    }
    if (intent.nativeTargetId !== input.nativeId) continue;
    if (intent.correlationId === input.correlationId) return true;
    const expected = intent.expectedPostState?.nativeContent;
    if (input.kind === 'change' && expected && typeof expected === 'object' && !Array.isArray(expected)
      && input.fields && Object.entries(input.fields).every(([key, value]) => expected[key] === value)) return true;
  }
  return false;
}
