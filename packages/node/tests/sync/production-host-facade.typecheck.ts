/**
 * Compile-fail coverage for the production Sync host façade (SYNC-Q-019).
 *
 * Dual owner, missing Session, and bare coordinator imports from `./sync`
 * must not type-check. Runtime negatives live in production-host-facade.test.ts.
 */
// Bare coordinators are not on the production barrel.
// @ts-expect-error bare Sequence coordinator is not a production ./sync export
import { coordinateSequenceOperation } from '../../src/sync/index.js';
// @ts-expect-error bare Push coordinator is not a production ./sync export
import { coordinatePushTransaction } from '../../src/sync/index.js';
// @ts-expect-error bare Pull coordinator is not a production ./sync export
import { coordinateSyncPull } from '../../src/sync/index.js';
import { createSyncHost } from '../../src/sync/index.js';
import type { PushSyncHost, SequenceSyncHost, VerifiedSyncSession } from '../../src/sync/index.js';

declare const session: VerifiedSyncSession;

const sequenceHost = createSyncHost({ owner: 'sequence', session });
// Sequence host has no Push dispatcher.
// @ts-expect-error sequence host cannot dispatch push
void sequenceHost.push;

const pushHost = createSyncHost({ owner: 'push', session });
// Push host has no Sequence dispatcher.
// @ts-expect-error push host cannot dispatch sequence
void pushHost.sequence;

// Session is required.
// @ts-expect-error createSyncHost requires a branded session
createSyncHost({ owner: 'sequence' });

// Owner is required.
// @ts-expect-error createSyncHost requires an exclusive owner
createSyncHost({ session });

function requireSequenceHost(host: SequenceSyncHost): void {
  void host.sequence;
}
function requirePushHost(host: PushSyncHost): void {
  void host.push;
}

// @ts-expect-error a Push host is not a Sequence host
requireSequenceHost(pushHost);
// @ts-expect-error a Sequence host is not a Push host
requirePushHost(sequenceHost);

void coordinateSequenceOperation;
void coordinatePushTransaction;
void coordinateSyncPull;
void sequenceHost;
void pushHost;
