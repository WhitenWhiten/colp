import { bindUnownedLocalTransfers } from './local-unbound-transfers.js';
import { createLocalTransferQueue } from './local-transfer-queue.js';
import { siteLedger } from './source-runtime.js';
import { attachLocalAssociation } from './local-association.js';
import { assertTransferCurrent } from './local-transfer-authority.js';
import { registerLocalTransfer } from './local-registration-runtime.js';
export { registerLocalTransfer } from './local-registration-runtime.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
const run = createLocalTransferQueue(siteLedger.db, { register: registerLocalTransfer, schedule: scheduleSourceAlarm, attach: attachLocalAssociation });
let running: Promise<void> | undefined;
export function flushLocalTransfers() {
  return running ??= (async () => {
    const scope = await currentSyncScope().catch(() => null);
    if (scope) await bindUnownedLocalTransfers(siteLedger.db, { schedule: scheduleSourceAlarm, ownerFor: async local => {
      const owner = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
      const { native } = await assertTransferCurrent({ ...local, owner });
      const mapping = await syncState.getMappingByNativeId(scope, native.id);
      return mapping && !mapping.quarantine && !mapping.colpId.startsWith('pending-') ? owner : null;
    } });
    await run();
  })().finally(() => { running = undefined; });
}
