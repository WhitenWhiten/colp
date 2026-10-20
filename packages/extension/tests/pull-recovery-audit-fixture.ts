import { createPullApplier } from '../src/pull-applier.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { rejoinSession } from './rejoin-http-fixture.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

export type NativeFixture = Awaited<ReturnType<typeof pullNativeWrapperFixture>>;

/** The production credential, Session, policy and native wrapper remain live.
 * The crash hook stops at an existing durable boundary, never fabricates a receipt. */
export async function recoveryAuditApplier(f: NativeFixture, crashAt?: string) {
  const effects = await f.effects(createChromePullBookmarkApi());
  const session = await rejoinSession(f.scope);
  let interrupted = false;
  return createPullApplier({ store: f.store, scope: f.scope, api: effects.api,
    assertCurrent: effects.assertCurrent,
    session: { acceptedProtocolVersion: '0.2', sessionId: session.sessionId,
      collectionId: f.scope.collectionId, conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${f.scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
    effectPageAuthority: f.scope.serverOrigin,
    crash(boundary) {
      if (!interrupted && boundary === crashAt) { interrupted = true; throw new Error('worker_crash'); }
    } });
}
