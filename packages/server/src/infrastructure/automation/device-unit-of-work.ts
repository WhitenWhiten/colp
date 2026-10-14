import { issueDeviceBundle, acknowledgeDeviceBundle } from './bundle-store.js';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { authorizeAutomationDevice } from './device-authority.js';
import { acceptStoredIntakeReceipt } from './intake-receipt-store.js';
import type { AutomationDeviceUnitOfWork } from '../../modules/automation/index.js';
export function createAutomationDeviceUnitOfWork(db: Kysely<DatabaseSchema>, serverUuid: string): AutomationDeviceUnitOfWork {
  return { execute: (input, work) => db.transaction().execute(async tx => {
    const actor = await authorizeAutomationDevice(tx, input);
    return work({ actor, bundle: profile => issueDeviceBundle(tx, actor, serverUuid, profile),
      acknowledge: input => acknowledgeDeviceBundle(tx, actor, input), receipts: createPostgresProductCommandReceiptPort(tx),
      accept: receipt => acceptStoredIntakeReceipt(tx, actor, serverUuid, receipt) });
  }) };
}
