import { expect } from 'vitest';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { createPullApplier } from '../src/pull-applier.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createPullBookmarkEvidence } from '../src/pull-bookmark-evidence.js';
import { parentRevisionMappingFor } from '../src/pull-child-order.js';
import { materializeRestoredNode } from '../src/pull-restore-apply.js';
import type { PullApplierOptions } from '../src/pull-applier-types.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { rejoinSession } from './rejoin-http-fixture.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

type NativeFixture = Awaited<ReturnType<typeof pullNativeWrapperFixture>>;
type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

export async function adapterRuntime(f: NativeFixture, crashAt?: string) {
  const effects = await f.effects(createChromePullBookmarkApi()), session = await rejoinSession(f.scope);
  let interrupted = false;
  const options: PullApplierOptions = { store: f.store, scope: f.scope, api: effects.api,
    assertCurrent: effects.assertCurrent,
    session: { acceptedProtocolVersion: '0.2', sessionId: session.sessionId, collectionId: f.scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${f.scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
    effectPageAuthority: f.scope.serverOrigin,
    crash(boundary) { if (!interrupted && boundary === crashAt) { interrupted = true; throw new Error('worker_crash'); } },
  };
  return { options, api: effects.api, applier: createPullApplier(options) };
}

export async function prepareRestore(f: NativeFixture, event: SyncPullEventV02) {
  const runtime = await adapterRuntime(f, 'after_intent');
  await runtime.applier.stage(pullFixtures.page({ events: [event], nextCursor: 'restored-cursor', collectionRevision: 'restored-r1' }));
  await expect(runtime.applier.resume()).rejects.toThrow('worker_crash');
  expect(f.native.calls.filter(call => call.kind === 'create')).toEqual([]);
}

/** Exercise the production restore adapter at its durable prepared boundary.
 * The actual applier created the intent; only the Chrome port can supply a result.
 * Repeated adapter dispatch must reuse its real receipt before outer cursor commit. */
export async function dispatchPreparedRestore(f: NativeFixture) {
  const runtime = await adapterRuntime(f), rows = await f.store.listPullEvents(f.scope);
  const row = rows[0];
  if (!row || !row.payload || typeof row.payload !== 'object'
      || !('kind' in row.payload) || row.payload.kind !== 'operation') throw new Error('fixture_restore_event_missing');
  const event = row.payload as unknown as OpEvent;
  const { nativeIndex } = createPullBookmarkEvidence(runtime.options, runtime.api);
  const parentRevision = parentRevisionMappingFor(runtime.options);
  return materializeRestoredNode({ store: f.store, scope: f.scope, eventId: String(row.eventId), event,
    options: runtime.options, api: runtime.api, generation: f.scope.generation,
    separatorPolicy: 'preserve_remote', now: Date.now, nativeIndex,
    parentRevisionMapping: revision => parentRevision(revision, event) });
}
