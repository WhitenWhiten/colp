import { canonicalCommandFingerprint, type ProductCommandReceiptPort } from '../../commands/index.js';
import type { ActivityReadRequest, ActivityReadResult } from '../domain/activity.js';

export class ActivityCommandError extends Error {
  constructor(readonly code: 'command_id_reused' | 'command_in_progress' | 'command_result_expired',
    message: string, readonly retryAfterSeconds: number | null = null) { super(message); }
}

/** The receipt and read state must commit together in the caller's transaction. */
export async function executeActivityReadCommand(input: {
  receipts: ProductCommandReceiptPort; accountId: string; commandId: string; request: ActivityReadRequest;
  apply: () => Promise<ActivityReadResult>;
}): Promise<ActivityReadResult> {
  const binding = { principalId: input.accountId, commandScope: 'activity-read', commandId: input.commandId };
  const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: '/api/v1/me/activity/read',
    mediaType: 'application/json', body: input.request });
  const claim = await input.receipts.claim(binding, fingerprint);
  switch (claim.kind) {
    case 'replay': return JSON.parse(new TextDecoder().decode(claim.result.body)) as ActivityReadResult;
    case 'reused': throw new ActivityCommandError('command_id_reused', 'This command id was already used for another activity read.');
    case 'expired': throw new ActivityCommandError('command_result_expired', 'The original activity read result has expired.');
    case 'in_progress': throw new ActivityCommandError('command_in_progress', 'This activity read is still in progress.', claim.retryAfterSeconds);
    case 'claimed': break;
  }
  const result = await input.apply();
  await input.receipts.complete(binding, fingerprint, { status: 200,
    body: new TextEncoder().encode(JSON.stringify(result)), mediaType: 'application/json', contractVersion: '1.0.0',
    stableHeaders: { 'cache-control': 'private, no-store' } });
  return result;
}
