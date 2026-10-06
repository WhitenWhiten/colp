import { requirePromise } from './internal-guards.js';

/**
 * Durable local state maintained by a Sync adapter when a native browser
 * cannot represent protocol sidecar fields directly.
 *
 * Protocol Node IDs are the authoritative key. `nativeId` is only an index
 * back into the browser tree and must never replace `nodeId` as the key.
 */
export interface SyncSidecarRecord<
  Browser = string,
  Profile = string,
  CollectionId = string,
  NodeId = string,
  NativeId = string,
  Generation = number,
  Data = unknown,
> {
  readonly browser: Browser;
  readonly profile: Profile;
  readonly collectionId: CollectionId;
  readonly nodeId: NodeId;
  readonly nativeId: NativeId;
  readonly generation: Generation;
  readonly data?: Data;
}

/** Adapter-owned durable boundaries for one local Sidecar record. */
export interface SyncSidecarAdapter<Record extends SyncSidecarRecord = SyncSidecarRecord> {
  /** Read the record addressed by the protocol Node ID, if present. */
  readonly loadSidecar: (nodeId: Record['nodeId']) => Promise<Record | undefined>;
  /** Atomically replace or create the complete record before resolving. */
  readonly writeSidecar?: (record: Record) => Promise<void>;
  /** Compatibility spelling used by adapters that call the boundary "save". */
  readonly saveSidecar?: (record: Record) => Promise<void>;
}

/**
 * Adapter-owned boundaries used to offer a complete Sidecar export before
 * the extension is removed. The export value is deliberately generic so a
 * browser adapter can return a download descriptor, serialized bytes, or a
 * platform-specific hand-off without changing the Sync contract.
 */
export interface SyncSidecarExportAdapter<
  Record extends SyncSidecarRecord = SyncSidecarRecord,
  Exported = readonly Record[],
> {
  /** Enumerate every locally persisted Sidecar record for this adapter. */
  readonly listSidecars: () => Promise<readonly Record[]>;
  /** Optional adapter-owned export sink used when no sink is supplied. */
  readonly exportSidecars?: (records: readonly Record[]) => Promise<Exported>;
}

/** Generic asynchronous export sink usable by browser and non-browser adapters. */
export type SyncSidecarExporter<Record extends SyncSidecarRecord, Exported> = (
  records: readonly Record[],
) => Promise<Exported>;

function requireIdentifier(value: unknown, name: string): void {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
    throw new TypeError(`${name} must be a non-empty identifier.`);
  }
}

function validateSidecar<Record extends SyncSidecarRecord>(record: Record): void {
  if (record === null || typeof record !== 'object') {
    throw new TypeError('Sync Sidecar must be an object.');
  }
  requireIdentifier(record.browser, 'Sidecar browser');
  requireIdentifier(record.profile, 'Sidecar profile');
  requireIdentifier(record.collectionId, 'Sidecar collection ID');
  requireIdentifier(record.nodeId, 'Sidecar Node ID');
  requireIdentifier(record.nativeId, 'Sidecar native ID');
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0) {
    throw new RangeError('Sidecar generation must be a non-negative safe integer.');
  }
}

function sameIdentity<Record extends SyncSidecarRecord>(left: Record, right: Record): boolean {
  return left.browser === right.browser
    && left.profile === right.profile
    && left.collectionId === right.collectionId
    && left.nodeId === right.nodeId
    && left.nativeId === right.nativeId
    && left.generation === right.generation;
}

/**
 * Persist one local Sidecar record through an adapter-owned atomic write.
 *
 * The write is awaited and followed by a durable read-back. Adapters MUST
 * resolve only after their atomic commit is known; a synchronous return,
 * missing read-back, or identity mismatch is rejected.
 *
 * Record identity is keyed by protocol `nodeId` (never `nativeId` alone).
 */
export async function persistSyncSidecar<Record extends SyncSidecarRecord>(
  record: Record,
  adapter: SyncSidecarAdapter<Record>,
): Promise<Record> {
  validateSidecar(record);
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('Sidecar adapter must be an object.');
  }
  if (typeof adapter.loadSidecar !== 'function') {
    throw new TypeError('Sidecar adapter must provide loadSidecar.');
  }
  const write = adapter.writeSidecar ?? adapter.saveSidecar;
  if (typeof write !== 'function') {
    throw new TypeError('Sidecar adapter must provide a write boundary (writeSidecar or saveSidecar).');
  }
  await requirePromise(write(record) as Promise<void>, 'Sidecar write boundary');
  const stored = await requirePromise(
    adapter.loadSidecar(record.nodeId) as Promise<Record | undefined>,
    'Sidecar read-back boundary',
  );
  if (stored === undefined) throw new TypeError('Sidecar write was not durably persisted.');
  validateSidecar(stored);
  // nodeId is the authoritative durable key; nativeId is only an index.
  if (!sameIdentity(stored, record)) {
    throw new TypeError('Sidecar read-back does not match the persisted record.');
  }
  return stored;
}

/**
 * Enumerate and export all local Sidecars as one pre-uninstall operation.
 * Every record is validated before the exporter is called; a malformed or
 * non-Promise adapter boundary fails closed without offering partial output.
 */
export async function exportSyncSidecars<Record extends SyncSidecarRecord, Exported>(
  adapter: SyncSidecarExportAdapter<Record, Exported> & {
    readonly exportSidecars: (records: readonly Record[]) => Promise<Exported>;
  },
): Promise<Exported>;
export async function exportSyncSidecars<Record extends SyncSidecarRecord>(
  adapter: SyncSidecarExportAdapter<Record>,
): Promise<readonly Record[]>;
export async function exportSyncSidecars<Record extends SyncSidecarRecord, Exported>(
  adapter: SyncSidecarExportAdapter<Record, any>,
  exporter: SyncSidecarExporter<Record, Exported>,
): Promise<Exported>;
export async function exportSyncSidecars<Record extends SyncSidecarRecord, Exported>(
  adapter: SyncSidecarExportAdapter<Record, Exported>,
  exporter?: SyncSidecarExporter<Record, Exported>,
): Promise<Exported | readonly Record[]> {
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('Sidecar export adapter must be an object.');
  }
  if (typeof adapter.listSidecars !== 'function') {
    throw new TypeError('Sidecar export adapter must provide listSidecars.');
  }
  const listed = await requirePromise(
    adapter.listSidecars() as Promise<readonly Record[]>,
    'Sidecar list boundary',
  );
  if (!Array.isArray(listed)) throw new TypeError('Sidecar list boundary must return an array.');
  for (const record of listed) validateSidecar(record);

  const snapshot = Object.freeze([...listed]) as readonly Record[];
  const sink = exporter ?? adapter.exportSidecars;
  if (sink === undefined) return snapshot;
  if (typeof sink !== 'function') {
    throw new TypeError('Sidecar export boundary must be a function.');
  }
  return requirePromise(sink(snapshot) as Promise<Exported>, 'Sidecar export boundary');
}
