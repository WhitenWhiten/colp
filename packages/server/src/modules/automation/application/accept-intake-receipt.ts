import { automationDigest, taskInputDigest, type LocalReceiptInput, type ReceiptIngestResult } from '@know-n/colp/automation';
import type { VerifiedExtensionCredential } from '../../identity/index.js';
import type { ProductCommandReceiptPort } from '../../commands/index.js';
import { parseContract } from './rule-service.js';
export interface AutomationDeviceActor {
  accountId: string; subjectId: string; deviceId: string; replicaId: string; replicaGeneration: string;
  collectionId: string; sessionId: string;
}
export interface AutomationDevicePorts {
  bridge?: import('./device-bridge.js').DeviceBridgeDevicePort;
  actor: AutomationDeviceActor;
  receipts: ProductCommandReceiptPort;
  bundle(profile: string): Promise<import('@know-n/colp/automation').RuleBundle>;
  acknowledge(input: import('@know-n/colp/automation').BundleAckInput): Promise<import('@know-n/colp/automation').OperationReceipt>;
  accept(input: LocalReceiptInput): Promise<ReceiptIngestResult>;
}
export interface AutomationDeviceUnitOfWork {
  execute<T>(input: { credential: VerifiedExtensionCredential; sessionId: string; origin: string }, work: (ports: AutomationDevicePorts) => Promise<T>): Promise<T>;
}
export async function acceptIntakeReceipt(ports: AutomationDevicePorts, body: unknown): Promise<ReceiptIngestResult> {
  return ports.accept(parseContract('LocalReceiptInput', body));
}
/** Canonical identity and relevant rule/input pins; parent changes do not disguise a stale URL/title/tag input. */
export function placementInputDigest(input: Pick<LocalReceiptInput, 'committedNode' | 'ruleRevision' | 'bindingRevision'>,
  fields: { url: string | null; title: string | null; tags: readonly string[] }): string {
  return taskInputDigest({ ...input.committedNode, taskId: 'intake', outputContract: 'placement.subtree.v1',
    revisions: { rule: input.ruleRevision, binding: input.bindingRevision }, inputFields: ['url', 'title', 'tags'], acceptedPredecessors: {} }, fields);
}
export const placementResultDigest = (destination: LocalReceiptInput['committedNode']) => automationDigest({ kind: 'placement', destination });
