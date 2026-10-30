import type { PlacementIntent } from './indexeddb-store.js';
import type { NativeBookmark } from './observed-create.js';
import { RECEIPT_MAX_AGE_MS } from './receipt-sync.js';
import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';

/**
 * Closes the gap a crash can leave between an observed move and its receipt.
 * The native bookmark decides, by its id and creation time:
 *
 * - **In the rule's folder.** The move happened, so its receipt is written
 *   under the intent's id. That is idempotent if it already was.
 * - **Still where it was.** The move never happened, and it is not made late:
 *   the Owner's intent is no longer known.
 * - **Gone, reused, or moved elsewhere.** It is not the extension's to touch.
 *
 * Nothing is matched by title or URL. Another account's intents wait for that
 * account, up to the receipt lifetime.
 */
export interface IntentRecoveryPorts {
  readonly ownerKey: string | null;
  readonly now: number;
  list(): Promise<readonly PlacementIntent[]>;
  remove(intentId: string): Promise<void>;
  node(nativeId: string): Promise<NativeBookmark | null>;
  record(intent: PlacementIntent): Promise<void>;
  defer?(intent: PlacementIntent, problem: NonNullable<PlacementIntent['recoveryProblem']>): Promise<void>;
}

export async function recoverPlacementIntents(ports: IntentRecoveryPorts): Promise<{ readonly recorded: number; readonly dropped: number }> {
  let recorded = 0, dropped = 0;
  for (const intent of await ports.list()) {
    const expired = ports.now - intent.createdAt > RECEIPT_MAX_AGE_MS;
    if (intent.ownerKey !== ports.ownerKey && !expired) continue;
    let node: NativeBookmark | null;
    try { node = expired ? null : await ports.node(intent.native.nativeId); }
    catch (error) {
      await ports.defer?.(intent, classifyBookmarkApiFailure(error) === 'permission_denied' ? 'permission_required' : 'bookmark_unavailable').catch(() => undefined);
      continue;
    }
    const same = node && node.url !== undefined && (intent.dateAdded === null || node.dateAdded === intent.dateAdded);
    if (node && same && node.parentId === intent.native.destinationNativeId) {
      try { await ports.record(intent); recorded += 1; }
      catch { await ports.defer?.(intent, 'receipt_unavailable').catch(() => undefined); continue; }
    }
    else dropped += 1;
    await ports.remove(intent.intentId);
  }
  return { recorded, dropped };
}
