import { automationDigest, taskInputDigest, type LocalReceiptInput, type ReceiptIngestResult } from '@know-n/colp/automation';
import type { VerifiedExtensionCredential } from '../../identity/index.js';
import type { ProductCommandReceiptPort } from '../../commands/index.js';
import { parseContract } from './rule-service.js';
export interface AutomationDeviceActor {
  accountId: string; subjectId: string; deviceId: string; replicaId: string; replicaGeneration: string;
  collectionId: string; sessionId: string;
}
export interface AutomationDevicePorts {
  actor: AutomationDeviceActor;
  receipts: ProductCommandReceiptPort;
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
  return taskInputDigest({ ...input.committedNode, taskId: 'classify.root', outputContract: 'placement.v1',
    revisions: { rule: input.ruleRevision, binding: input.bindingRevision }, inputFields: ['url', 'title', 'tags'], acceptedPredecessors: {} }, fields);
}
export const placementResultDigest = (destination: LocalReceiptInput['committedNode']) => automationDigest({ kind: 'placement', destination });
