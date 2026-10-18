import { readBoundedJson, type JsonResponseReadOptions } from '../json-response.js';

const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
export const HEALTH_RECEIPT_MAX_BYTES = 16 * 1024;
export interface HealthReceipt {
  readonly replicaId: string; readonly revision: number; readonly accepted: boolean;
  readonly commands: readonly { readonly commandId: string; readonly action: string; readonly issueId?: string }[];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** A receipt binds this HTTP exchange to the target and revision. accepted=false
 * means a newer health won; the server still atomically settled command results. */
export async function readHealthReceipt(response: Response, sent: Record<string, unknown>,
  options: JsonResponseReadOptions = {}): Promise<HealthReceipt> {
  const invalid = () => new Error('health_receipt_invalid');
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '')) throw invalid();
  const value = await readBoundedJson(response, HEALTH_RECEIPT_MAX_BYTES, 'health_receipt_invalid',
    { timeoutMilliseconds: 10_000, ...options });
  if (!record(value) || Object.keys(value).some(key => !['replicaId', 'revision', 'accepted', 'commands'].includes(key))
      || value.replicaId !== sent.replicaId || typeof value.replicaId !== 'string' || !OPAQUE.test(value.replicaId)
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.accepted !== 'boolean'
      || !Number.isSafeInteger(sent.revision) || Number(sent.revision) < 0
      || (value.accepted ? value.revision !== sent.revision : Number(value.revision) < Number(sent.revision))
      || !Array.isArray(value.commands) || value.commands.length > 8) throw invalid();
  const ids = new Set<string>();
  for (const command of value.commands) {
    if (!record(command) || Object.keys(command).some(key => !['commandId', 'action', 'issueId'].includes(key))
        || typeof command.commandId !== 'string' || !OPAQUE.test(command.commandId) || ids.has(command.commandId)
        || typeof command.action !== 'string' || !CODE.test(command.action)
        || command.issueId !== undefined && (typeof command.issueId !== 'string' || !OPAQUE.test(command.issueId))) throw invalid();
    ids.add(command.commandId);
  }
  return value as unknown as HealthReceipt;
}
