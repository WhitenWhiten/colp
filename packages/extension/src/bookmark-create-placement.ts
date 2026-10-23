import type { StorageArea } from './credential-store.js';

export const BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX = 'known.bookmark.create-placement.v1.';
export const BOOKMARK_CREATE_RECEIPT_KEY_PREFIX = 'known.bookmark.create-receipt.v1.';
export const BOOKMARK_CREATE_PLACEMENT_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * How long a consumer-owned receipt may outlive its placement TTL. The capture
 * ledger acknowledges the identity once it reaches `local-saved`; anything left
 * is either a crash between the native commit and that durable write, or an
 * abandoned capture. This is the upper bound on the recovery window and the
 * point at which an abandoned reservation is reclaimed, so a later identical
 * create is not permanently classified `unproven`.
 */
export const BOOKMARK_CREATE_RETAIN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const RETAIN_KEY_PREFIX = 'known.bookmark.create-consumer.v1.';

const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RETAIN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TITLE_LENGTH = 4_096;
const MAX_URL_LENGTH = 8_192;
const MAX_BATCH_SIZE = 10_000;
const MAX_EXPECTED_INDEX = 1_000_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export type CreatePlacementMode = 'top' | 'bottom';
export type CreatePlacementState = 'reserved' | 'bound' | 'attention';

export interface BookmarkCreatePlacementRecord {
  readonly version: 1;
  readonly mode: CreatePlacementMode;
  readonly targetParentNativeId: string;
  readonly collectionId?: string;
  readonly batchId: string;
  readonly batchOrder: number;
  readonly batchSize: number;
  readonly intentId: string;
  readonly title: string;
  readonly url: string;
  readonly expectedIndex: number;
  readonly state: CreatePlacementState;
  readonly nativeId?: string;
  readonly createdAt: number;
}

export type BookmarkCreatePlacementInput = Omit<BookmarkCreatePlacementRecord,
  'version' | 'intentId' | 'state' | 'nativeId' | 'createdAt'>;

export interface CreatedBookmarkNode {
  readonly id: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly title: string;
  readonly url?: string;
  readonly dateAdded?: number;
}

export type CreatePlacementConsumeResult =
  | { readonly state: 'ready'; readonly intent: BookmarkCreatePlacementRecord }
  | { readonly state: 'unproven'; readonly candidates: readonly BookmarkCreatePlacementRecord[] };

export interface BookmarkCreatePlacementStoreOptions {
  readonly storage?: StorageArea;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly ttlMs?: number;
  /**
   * Consumer owns recovery lifetime until its durable receipt is acknowledged,
   * but only up to `retainTtlMs` so an abandoned capture is eventually
   * reclaimed instead of poisoning a later identical create.
   */
  readonly retainForConsumer?: boolean;
  readonly retainTtlMs?: number;
}

/**
 * Durable reservations are deliberately one storage key per intent. A shared
 * array/map would make two popup or worker contexts overwrite each other's
 * reservation between a read and a write.
 */
export function createBookmarkCreatePlacementStore(options: BookmarkCreatePlacementStoreOptions = {}) {
  const storage = options.storage ?? defaultStorage();
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const ttlMs = validateTtl(options.ttlMs ?? BOOKMARK_CREATE_PLACEMENT_TTL_MS);
  const retainTtlMs = validateRetainTtl(options.retainTtlMs ?? BOOKMARK_CREATE_RETAIN_TTL_MS, ttlMs);

  async function reserve(input: BookmarkCreatePlacementInput): Promise<BookmarkCreatePlacementRecord> {
    const createdAt = validateTimestamp(now());
    const intentId = validateUuid(randomUUID(), 'intentId');
    const record = parseBookmarkCreatePlacementRecord({ ...input, version: 1, intentId,
      state: 'reserved', createdAt });
    if (!record) throw new TypeError('bookmark_create_placement_invalid');
    await pruneExpired(createdAt);
    await storage.set({ [storageKey(intentId)]: record,
      ...(options.retainForConsumer ? { [retainKey(intentId)]: { version: 1, retainedAt: createdAt } } : {}) });
    return record;
  }

  async function bind(intentId: string, nativeId: string): Promise<BookmarkCreatePlacementRecord | undefined> {
    const id = validateUuid(intentId, 'intentId');
    const native = validateNativeId(nativeId, 'nativeId');
    const timestamp = validateTimestamp(now());
    await pruneExpired(timestamp);
    const key = storageKey(id);
    const current = parseBookmarkCreatePlacementRecord((await storage.get(key))[key]);
    if (!current) return undefined;
    if (current.state === 'attention') throw new Error('bookmark_create_placement_attention');
    if (current.state === 'bound' && current.nativeId !== native) {
      throw new Error('bookmark_create_placement_bound_conflict');
    }
    const updated = parseBookmarkCreatePlacementRecord({ ...current, state: 'bound', nativeId });
    if (!updated) throw new TypeError('bookmark_create_placement_invalid');
    await storage.set({ [key]: updated });
    return updated;
  }

  async function get(intentId: string): Promise<BookmarkCreatePlacementRecord | undefined> {
    const key = storageKey(validateUuid(intentId, 'intentId'));
    return parseBookmarkCreatePlacementRecord((await storage.get(key))[key]);
  }

  async function cancel(intentId: string): Promise<void> {
    const id = validateUuid(intentId, 'intentId');
    await pruneExpired(validateTimestamp(now()));
    // Releasing retention here keeps an explicitly abandoned reservation from
    // outliving its TTL and shadowing a later create of the same node.
    await storage.remove([storageKey(id), retainKey(id)]);
  }

  async function consumeForCreated(node: CreatedBookmarkNode): Promise<CreatePlacementConsumeResult | undefined> {
    const candidateNode = parseCreatedBookmarkNode(node);
    if (!candidateNode) throw new TypeError('bookmark_create_placement_node_invalid');
    const timestamp = validateTimestamp(now());
    await pruneExpired(timestamp);
    const records = await listRecords();

    const exact = records.filter((record) => record.state === 'bound' && record.nativeId === candidateNode.id);
    if (exact.length > 0) return consumeExact(exact);

    const matching = records.filter((record) => (record.state === 'reserved' || record.state === 'attention')
      && record.targetParentNativeId === candidateNode.parentId
      && record.title === candidateNode.title
      && record.url === candidateNode.url
      && record.expectedIndex === candidateNode.index);
    if (matching.length === 1 && matching[0]!.state === 'attention') return { state: 'unproven', candidates: matching };
    if (matching.length === 1) {
      const intent = { ...matching[0]!, state: 'bound' as const, nativeId: candidateNode.id };
      return { state: 'ready', intent };
    }
    if (matching.length > 1) return markUnproven(matching);
    return undefined;
  }

  async function getReceipt(intentId: string): Promise<BookmarkCreatePlacementRecord | undefined> {
    const id = validateUuid(intentId, 'intentId');
    const key = `${BOOKMARK_CREATE_RECEIPT_KEY_PREFIX}${id}`;
    const record = parseBookmarkCreatePlacementRecord((await storage.get(key))[key]);
    if (!record || record.state !== 'bound' || record.intentId !== id) return undefined;
    if (now() - record.createdAt < ttlMs) return record;
    const retention = parseRetention((await storage.get(retainKey(id)))[retainKey(id)]);
    return retention && now() - retention.retainedAt < retainTtlMs ? record : undefined;
  }

  async function complete(intentId: string, nativeId?: string): Promise<void> {
    await pruneExpired(validateTimestamp(now()));
    const id = validateUuid(intentId, 'intentId');
    const current = await get(id);
    const native = nativeId ?? current?.nativeId;
    if (current && native) {
      if (current.state === 'attention' || (current.nativeId && current.nativeId !== native)) {
        throw new Error('bookmark_create_placement_bound_conflict');
      }
      const receipt = parseBookmarkCreatePlacementRecord({ ...current, state: 'bound', nativeId: native });
      if (!receipt) throw new TypeError('bookmark_create_placement_invalid');
      // Commit recovery evidence before consuming the event reservation. A
      // worker can stop after onCreated stages but before create returns.
      await storage.set({ [`${BOOKMARK_CREATE_RECEIPT_KEY_PREFIX}${id}`]: receipt });
    }
    await storage.remove(storageKey(id));
  }

  async function markAttention(intentId: string): Promise<void> {
    const id = validateUuid(intentId, 'intentId');
    const timestamp = validateTimestamp(now());
    await pruneExpired(timestamp);
    const key = storageKey(id);
    const current = parseBookmarkCreatePlacementRecord((await storage.get(key))[key]);
    if (!current) return;
    const updated = parseBookmarkCreatePlacementRecord({ ...current, state: 'attention' });
    if (updated) await storage.set({ [key]: updated });
  }

  async function pruneExpired(timestamp: number): Promise<number> {
    const values = await storage.get(null);
    const removals: string[] = [];
    const liveRetention = new Set<string>();
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(RETAIN_KEY_PREFIX)) continue;
      const retention = parseRetention(value);
      if (!retention || timestamp - retention.retainedAt >= retainTtlMs) removals.push(key);
      else liveRetention.add(key.slice(RETAIN_KEY_PREFIX.length));
    }
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX) && !key.startsWith(BOOKMARK_CREATE_RECEIPT_KEY_PREFIX)) continue;
      const record = parseBookmarkCreatePlacementRecord(value);
      if (!record || (timestamp - record.createdAt >= ttlMs && !liveRetention.has(record.intentId))) removals.push(key);
    }
    if (removals.length > 0) await storage.remove(removals);
    return removals.length;
  }

  async function listRecords(): Promise<BookmarkCreatePlacementRecord[]> {
    const values = await storage.get(null);
    const records: BookmarkCreatePlacementRecord[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX)) continue;
      const record = parseBookmarkCreatePlacementRecord(value);
      if (record) records.push(record);
    }
    return records;
  }

  async function consumeExact(records: readonly BookmarkCreatePlacementRecord[]): Promise<CreatePlacementConsumeResult> {
    if (records.length === 1) {
      return { state: 'ready', intent: records[0]! };
    }
    return markUnproven(records);
  }

  async function markUnproven(records: readonly BookmarkCreatePlacementRecord[]): Promise<CreatePlacementConsumeResult> {
    const candidates = records.map((record) => ({ ...record, state: 'attention' as const }));
    await storage.set(Object.fromEntries(candidates.map((record) => [storageKey(record.intentId), record])));
    return { state: 'unproven', candidates };
  }

  async function acknowledge(intentId: string): Promise<void> {
    await storage.remove(retainKey(validateUuid(intentId, 'intentId')));
  }

  return Object.freeze({ acknowledge, reserve, get, getReceipt, bind, cancel, consumeForCreated, complete, markAttention, pruneExpired });
}

export function parseBookmarkCreatePlacementRecord(value: unknown): BookmarkCreatePlacementRecord | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(['version', 'mode', 'targetParentNativeId', 'collectionId', 'batchId', 'batchOrder', 'batchSize',
    'intentId', 'title', 'url', 'expectedIndex', 'state', 'nativeId', 'createdAt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (value.version !== 1 || (value.mode !== 'top' && value.mode !== 'bottom')
      || typeof value.targetParentNativeId !== 'string' || !SAFE_ID.test(value.targetParentNativeId)
      || (value.collectionId !== undefined && (typeof value.collectionId !== 'string' || !SAFE_ID.test(value.collectionId)))
      || typeof value.batchId !== 'string' || !UUID_V4.test(value.batchId)
      || !safeIntegerInRange(value.batchOrder, 0, MAX_BATCH_SIZE - 1)
      || !safeIntegerInRange(value.batchSize, 1, MAX_BATCH_SIZE)
      || value.batchOrder >= value.batchSize
      || typeof value.intentId !== 'string' || !UUID_V4.test(value.intentId)
      || typeof value.title !== 'string' || !validTitle(value.title)
      || typeof value.url !== 'string' || !validUrl(value.url)
      || !safeIntegerInRange(value.expectedIndex, 0, MAX_EXPECTED_INDEX)
      || (value.state !== 'reserved' && value.state !== 'bound' && value.state !== 'attention')
      || !safeIntegerInRange(value.createdAt, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  if (value.state === 'reserved' && value.nativeId !== undefined) return undefined;
  if (value.state === 'bound' && (typeof value.nativeId !== 'string' || !SAFE_ID.test(value.nativeId))) return undefined;
  if (value.state !== 'bound' && value.nativeId !== undefined && !SAFE_ID.test(String(value.nativeId))) return undefined;
  return {
    version: 1, mode: value.mode, targetParentNativeId: value.targetParentNativeId,
    ...(value.collectionId === undefined ? {} : { collectionId: value.collectionId as string }),
    batchId: value.batchId, batchOrder: value.batchOrder, batchSize: value.batchSize,
    intentId: value.intentId, title: value.title, url: value.url, expectedIndex: value.expectedIndex,
    state: value.state, ...(value.nativeId === undefined ? {} : { nativeId: value.nativeId }), createdAt: value.createdAt,
  } as BookmarkCreatePlacementRecord;
}

function defaultStorage(): StorageArea {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  throw new Error('bookmark_create_placement_storage_unavailable');
}

function storageKey(intentId: string): string { return `${BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX}${intentId}`; }
function retainKey(intentId: string): string { return `${RETAIN_KEY_PREFIX}${intentId}`; }

function validateUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError(`${label}_invalid`);
  return value;
}

function validateNativeId(value: string, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${label}_invalid`);
  return value;
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('createdAt_invalid');
  return value;
}

function validateTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_MS) throw new TypeError('ttl_invalid');
  return value;
}

/** Retention must outlive the placement TTL it protects, and stay bounded. */
function validateRetainTtl(value: number, ttlMs: number): number {
  if (!Number.isSafeInteger(value) || value < ttlMs || value > MAX_RETAIN_TTL_MS) throw new TypeError('retain_ttl_invalid');
  return value;
}

interface CreateRetention {
  readonly version: 1;
  readonly retainedAt: number;
}

function parseRetention(value: unknown): CreateRetention | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.version !== 1
      || !Number.isSafeInteger(value.retainedAt) || (value.retainedAt as number) < 0) return undefined;
  return { version: 1, retainedAt: value.retainedAt as number };
}

function safeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validTitle(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TITLE_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch { return false; }
}

function parseCreatedBookmarkNode(value: unknown): CreatedBookmarkNode | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !SAFE_ID.test(value.id)
      || typeof value.parentId !== 'string' || !SAFE_ID.test(value.parentId)
      || typeof value.title !== 'string' || !validTitle(value.title)
      || typeof value.url !== 'string' || !validUrl(value.url)
      || !safeIntegerInRange(value.index, 0, MAX_EXPECTED_INDEX)) return undefined;
  return { id: value.id, parentId: value.parentId, index: value.index, title: value.title, url: value.url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
