import { automationDigest, taskInputDigest, validateAutomation,
  type FolderRef, type LocalReceiptInput, type ReceiptIngestResult } from '@know-n/colp/automation';
import type { AutomationStateArea } from './bundle-store.js';
import type { DeviceResult } from './device-client.js';
import { AUTOMATION_RECEIPTS_KEY } from './messages.js';
import { RECEIPT_MAX_AGE_MS } from './receipt-limits.js';
export { RECEIPT_MAX_AGE_MS } from './receipt-limits.js';

/**
 * Placement receipts: what a rule did to a bookmark in this browser, told to
 * the server in canonical terms only.
 *
 * A receipt is written before anything touches the network. The native
 * observation (native ids, the destination's native folder, when the move was
 * seen) stays in this record and never leaves the browser: the server receipt
 * names the canonical Sync create, the optional corrective move, the
 * committed node and the pinned rule, binding and bundle revisions. Until the
 * Sync operations exist the receipt waits locally; an observed correction
 * waits for both. The server's answer (waitingForSync, accepted, review,
 * rejected) is recorded as given. Only the rule's own `classify.root`
 * declaration is ever claimed, and the server decides whether it holds.
 */
export type ReceiptState = 'local' | 'waitingForSync' | 'accepted' | 'review' | 'rejected' | 'attention';
export type ReceiptAttention = 'staleGeneration' | 'identityUnknown' | 'invalid' | 'conflict' | 'expired';

export interface PlacementReceipt {
  readonly version: 1;
  readonly localReceiptId: string;
  readonly ownerKey: string;
  readonly collectionId: string;
  readonly replicaId: string;
  /** The device's replica binding generation when the placement happened. */
  readonly generation: number;
  readonly path: 'preSave' | 'observed';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly rule: { readonly id: string; readonly name: string; readonly revision: string; readonly bindingRevision: string; readonly bundleRevision: string };
  readonly destination: FolderRef;
  readonly destinationTitle: string;
  readonly satisfies: readonly 'classify.root'[];
  /** Observed path: the canonical root folder the bookmark was moved out of. */
  readonly beforeFolder?: FolderRef;
  /** Local display only. */
  readonly page: { readonly title: string; readonly url: string };
  /** Native observation. Never serialized into a server receipt. */
  readonly native: { readonly nativeId: string; readonly destinationNativeId: string; readonly movedAt?: number };
  readonly canonical?: { readonly nodeId: string; readonly operationId: string; readonly placementOperationId?: string };
  readonly state: ReceiptState;
  readonly attention?: ReceiptAttention;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

/** Canonical evidence the local Sync engine holds for a native bookmark. */
export interface CanonicalCreate { readonly nodeId: string; readonly operationId: string; readonly parentNodeId: string | null;
  readonly url: string; readonly title: string; readonly tags?: readonly string[] }
export interface ReceiptEvidence {
  /** The applied Sync create of this native bookmark, once its push was acknowledged. */
  create(nativeId: string): Promise<CanonicalCreate | null>;
  /** The applied Sync move of this bookmark into `destinationNativeId` observed after `since`. */
  move(nativeId: string, destinationNativeId: string, since: number): Promise<string | null>;
  /** Whether the native bookmark still exists. */
  present?(nativeId: string): Promise<boolean>;
}

const MAX_RECEIPTS = 300;
const KEEP_SETTLED_MS = 30 * 86_400_000;
/** A bookmark gone this long without its create ever reaching the server can no longer be joined. */
export const ORPHAN_AFTER_MS = 3_600_000;
export const settled = (state: ReceiptState) => state === 'accepted' || state === 'review' || state === 'rejected' || state === 'attention';

/** Exponential backoff from 30 seconds to one hour. */
export function nextAttempt(now: number, attempts: number): number {
  return now + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7));
}

/** The server document. Throws instead of sending anything the contract would not accept. */
export function serializeReceipt(receipt: PlacementReceipt, created: CanonicalCreate, device: { readonly deviceId: string; readonly replicaGeneration: number }): LocalReceiptInput {
  const canonical = receipt.canonical;
  if (!canonical) throw new Error('receipt_canonical_missing');
  const committedNode = { serverUuid: receipt.destination.serverUuid, collectionId: receipt.collectionId, nodeId: canonical.nodeId };
  const inputDigest = taskInputDigest({ ...committedNode, taskId: 'intake', outputContract: 'placement.subtree.v1',
    revisions: { rule: receipt.rule.revision, binding: receipt.rule.bindingRevision }, inputFields: ['url', 'title', 'tags'], acceptedPredecessors: {} },
  { url: created.url, title: created.title, tags: [...(created.tags ?? [])] });
  const input: LocalReceiptInput = {
    deviceId: device.deviceId, replicaGeneration: device.replicaGeneration, localReceiptId: receipt.localReceiptId,
    operationId: canonical.operationId, ruleId: receipt.rule.id, ruleRevision: receipt.rule.revision,
    bindingRevision: receipt.rule.bindingRevision, bundleRevision: receipt.rule.bundleRevision, inputDigest,
    satisfiedTaskTypes: [...receipt.satisfies], committedNode,
    resultDigests: [automationDigest({ kind: 'placement', destination: receipt.destination })],
    ...(canonical.placementOperationId ? { placementOperationId: canonical.placementOperationId,
      ...(receipt.beforeFolder ? { beforeFolder: receipt.beforeFolder } : {}) } : {}),
  };
  if (!validateAutomation('LocalReceiptInput', input).valid) throw new Error('receipt_invalid');
  return input;
}

function parse(value: unknown): PlacementReceipt[] {
  return Array.isArray(value) ? value.filter((item): item is PlacementReceipt => !!item && typeof item === 'object'
    && (item as PlacementReceipt).version === 1 && typeof (item as PlacementReceipt).localReceiptId === 'string') : [];
}

let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export function createReceiptStore(area: AutomationStateArea) {
  const read = async () => parse(await area.get(AUTOMATION_RECEIPTS_KEY));
  /** Newest first; settled receipts age out, and the list never grows past its bound. */
  const write = async (receipts: readonly PlacementReceipt[], now: number) => {
    const kept = [...receipts].sort((a, b) => b.createdAt - a.createdAt)
      .filter((receipt) => !settled(receipt.state) || now - receipt.updatedAt < KEEP_SETTLED_MS).slice(0, MAX_RECEIPTS);
    await area.set(AUTOMATION_RECEIPTS_KEY, kept);
  };
  return {
    list: read,
    /**
     * Durable before any network work is scheduled. Add-if-absent: a placement is
     * recorded once, so a repeated acknowledgement never resets a receipt in progress.
     */
    add(receipt: PlacementReceipt, now: number): Promise<boolean> {
      return exclusive(async () => {
        const receipts = await read();
        if (receipts.some((item) => item.localReceiptId === receipt.localReceiptId)) return false;
        await write([receipt, ...receipts], now); return true;
      });
    },
    update(localReceiptId: string, change: (receipt: PlacementReceipt) => PlacementReceipt, now: number): Promise<PlacementReceipt | null> {
      return exclusive(async () => {
        const receipts = await read(); let next: PlacementReceipt | null = null;
        await write(receipts.map((receipt) => receipt.localReceiptId === localReceiptId ? (next = change(receipt)) : receipt), now);
        return next;
      });
    },
  };
}
export type ReceiptStore = ReturnType<typeof createReceiptStore>;

export interface ReceiptSyncContext {
  readonly ownerKey: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly generation: number;
  /** The server's device id for this replica, when known; receipts wait without it. */
  readonly deviceId: string | null;
  /** The Sync lease generation the server fences receipts with. */
  readonly replicaGeneration: number;
  readonly now: number;
  readonly evidence: ReceiptEvidence;
  post(input: LocalReceiptInput): Promise<DeviceResult>;
}

const answered = (body: unknown): ReceiptIngestResult | null =>
  validateAutomation('ReceiptIngestResult', body).valid ? body as ReceiptIngestResult : null;

/**
 * One pass over this account's due receipts. Other accounts' receipts are never
 * read for sending; a receipt from an earlier replica generation needs
 * attention instead of being re-associated with whatever the bookmark is now.
 */
export async function syncReceipts(store: ReceiptStore, context: ReceiptSyncContext): Promise<{ readonly sent: number; readonly pending: number }> {
  let sent = 0, pending = 0;
  for (const receipt of await store.list()) {
    if (receipt.ownerKey !== context.ownerKey || settled(receipt.state) || receipt.nextAttemptAt > context.now) continue;
    const settle = (state: ReceiptState, extra: Partial<PlacementReceipt> = {}) => store.update(receipt.localReceiptId,
      (current) => ({ ...current, ...extra, state, updatedAt: context.now }), context.now);
    const retry = (extra: Partial<PlacementReceipt> = {}) => store.update(receipt.localReceiptId, (current) => ({ ...current, ...extra,
      attempts: current.attempts + 1, nextAttemptAt: nextAttempt(context.now, current.attempts), updatedAt: context.now }), context.now);
    if (receipt.collectionId !== context.collectionId) continue;
    if (receipt.replicaId !== context.replicaId || receipt.generation !== context.generation) {
      await settle('attention', { attention: 'staleGeneration' }); continue;
    }
    if (context.now - receipt.createdAt > RECEIPT_MAX_AGE_MS) { await settle('attention', { attention: 'expired' }); continue; }
    const created = await context.evidence.create(receipt.native.nativeId);
    if (!created) {
      // Removed before its create reached the server: no identity to join, so it needs attention, never a guess.
      if (context.now - receipt.createdAt > ORPHAN_AFTER_MS && context.evidence.present && !await context.evidence.present(receipt.native.nativeId)) {
        await settle('attention', { attention: 'identityUnknown' }); continue;
      }
      pending += 1; await retry(); continue;
    }
    if (receipt.canonical && receipt.canonical.nodeId !== created.nodeId) { await settle('attention', { attention: 'identityUnknown' }); continue; }
    // An observed correction is joined to its move. A create the queue already placed in the
    // destination (the move folded into it) needs no move.
    const needsMove = receipt.path === 'observed' && created.parentNodeId !== receipt.destination.nodeId;
    const placementOperationId = needsMove ? await context.evidence.move(receipt.native.nativeId, receipt.native.destinationNativeId, receipt.native.movedAt ?? receipt.createdAt) : undefined;
    const canonical = { nodeId: created.nodeId, operationId: created.operationId, ...(placementOperationId ? { placementOperationId } : {}) };
    if ((needsMove && !placementOperationId) || !context.deviceId) { pending += 1; await retry({ canonical }); continue; }
    let input: LocalReceiptInput;
    try { input = serializeReceipt({ ...receipt, canonical }, created, { deviceId: context.deviceId, replicaGeneration: context.replicaGeneration }); }
    catch { await settle('attention', { attention: 'invalid', canonical }); continue; }
    const response = await context.post(input);
    sent += 1;
    const result = response.ok ? answered(response.body) : null;
    if (result) {
      if (result.state === 'waitingForSync') { pending += 1; await retry({ canonical, state: 'waitingForSync' }); }
      else await settle(result.state, { canonical });
    } else if (!response.ok && (response.code === 'automation_command_conflict' || response.code === 'invalid_request')) {
      await settle('attention', { attention: response.code === 'invalid_request' ? 'invalid' : 'conflict', canonical });
    } else { pending += 1; await retry({ canonical }); }
  }
  return { sent, pending };
}

/** A new receipt for a placement that just happened; it waits locally until its Sync operations exist. */
export function newPlacementReceipt(input: Omit<PlacementReceipt, 'version' | 'localReceiptId' | 'createdAt' | 'updatedAt'
  | 'state' | 'attempts' | 'nextAttemptAt' | 'canonical' | 'attention'>, now: number, id: string = crypto.randomUUID()): PlacementReceipt {
  return { ...input, version: 1, localReceiptId: id, createdAt: now, updatedAt: now, state: 'local', attempts: 0, nextAttemptAt: now };
}
