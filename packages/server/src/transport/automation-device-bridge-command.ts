import { AutomationError, type AutomationDeviceUnitOfWork } from '../modules/automation/index.js';
import type { VerifiedExtensionCredential } from '../modules/identity/index.js';
import { canonicalCommandFingerprint } from '../modules/commands/index.js';
import { AUTOMATION_CONTRACT_VERSION } from '@know-n/colp/automation';

export async function executeBridgeDeviceCommand(unitOfWork: AutomationDeviceUnitOfWork, input: {
  credential: VerifiedExtensionCredential; replicaId: string; replicaProof: string; origin: string;
  method: 'GET' | 'POST'; commandId: string; body: unknown;
}) {
  if (!unitOfWork.executeBridge) throw new AutomationError('automation_unsupported_capability', 'Installation bridge authority is unavailable.');
  return unitOfWork.executeBridge(input, async ports => {
    if (input.method === 'GET') return { body: await ports.bridge!.pending() };
    const binding = { principalId: ports.actor.accountId,
      commandScope: `/api/v1/automation-device/bridge-results:${ports.actor.deviceId}`, commandId: input.commandId };
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: '/api/v1/automation-device/bridge-results',
      mediaType: 'application/json', body: input.body, conditions: { replicaId: input.replicaId } });
    const claim = await ports.receipts.claim(binding, fingerprint);
    if (claim.kind !== 'claimed') return { claim };
    const body = await ports.bridge!.complete(input.body);
    await ports.receipts.complete(binding, fingerprint, { status: 200, body: new TextEncoder().encode(JSON.stringify(body)),
      mediaType: 'application/json', contractVersion: AUTOMATION_CONTRACT_VERSION, stableHeaders: { 'cache-control': 'private, no-store' } });
    return { body };
  });
}
