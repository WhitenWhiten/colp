import type { BatchResponse, PublicBatchStatus } from './types.js';

/** Uses the manager's durable deletion journal so closing the popup still leaves Undo in the library. */
export async function removePopupBookmark(nativeId: string): Promise<PublicBatchStatus> {
  const preview = await chrome.runtime.sendMessage({ kind: 'known.batch.preview', operation: 'delete', nativeIds: [nativeId] }) as BatchResponse;
  if (!preview.ok || !('preview' in preview)) throw new Error('bookmark_delete_unavailable');
  const result = await chrome.runtime.sendMessage({ kind: 'known.batch.confirm', operation: 'delete', nativeIds: [nativeId],
    commandId: crypto.randomUUID(), previewDigest: preview.preview.digest, userGesture: true, secondConfirm: true }) as BatchResponse;
  if (!result.ok || !('status' in result) || result.status.applied !== 1) throw new Error('bookmark_delete_unavailable');
  return result.status;
}
export async function undoPopupBookmark(status: PublicBatchStatus) {
  const result = await chrome.runtime.sendMessage({ kind: 'known.batch.undo', planId: status.planId,
    commandId: status.commandId, userGesture: true }) as BatchResponse;
  if (!result.ok || !('status' in result) || result.status.undone !== 1) throw new Error('bookmark_undo_unavailable');
}
