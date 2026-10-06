/**
 * Stable mapping between a Sync Root identity and the browser's local node
 * identity. Browser node IDs are installation/profile local and MUST NOT be
 * treated as constants.
 */
export interface SyncRootMapping<ServerRootId = string, BrowserRootId = string> {
  readonly serverRootId: ServerRootId;
  readonly browserRootId: BrowserRootId;
}

/** A root discovered from the browser's current tree. */
export interface SyncBrowserRoot<ServerRootId = string, BrowserRootId = string> {
  readonly browserRootId: BrowserRootId;
  readonly serverRootId?: ServerRootId;
  readonly isRoot?: boolean;
}

/** Durable boundaries required to establish a root mapping. */
export interface SyncRootMappingAdapter<ServerRootId = string, BrowserRootId = string> {
  /**
   * Required when multiple adapter handles/processes share browser state. Hold
   * an exclusive root-scoped lock through work completion and mapping persistence.
   * Invoke work exactly once and return its exact result only after releasing safely.
   * Without this port, only concurrent calls using the same adapter are coalesced.
   */
  readonly withRootMappingLock?: <Value>(serverRootId: ServerRootId, work: () => Promise<Value>) => Promise<Value>;
  /** Read the mapping persisted by this adapter, if any. */
  readonly loadRootMapping: (
    serverRootId: ServerRootId,
  ) => Promise<SyncRootMapping<ServerRootId, BrowserRootId> | undefined>;
  /** Enumerate roots from the browser; do not synthesize IDs in the adapter. */
  readonly listBrowserRoots: () => Promise<readonly SyncBrowserRoot<ServerRootId, BrowserRootId>[]>;
  /** Verify that a browser node still exists and is a root. */
  readonly readBrowserRoot: (browserRootId: BrowserRootId) => Promise<SyncBrowserRoot<ServerRootId, BrowserRootId> | undefined>;
  /**
   * Create a browser root and return its browser-assigned ID. Persist a discoverable
   * serverRootId marker so a retry can recover if saving the mapping later fails.
   */
  readonly createBrowserRoot: (serverRootId: ServerRootId) => Promise<BrowserRootId>;
  /** Persist the resolved mapping before it is returned to callers. */
  readonly saveRootMapping: (mapping: SyncRootMapping<ServerRootId, BrowserRootId>) => Promise<void>;
}

function requirePromise<Value>(candidate: unknown, operation: string): Promise<Value> {
  if ((typeof candidate !== 'object' || candidate === null) && typeof candidate !== 'function') {
    throw new TypeError(`${operation} must return a Promise.`);
  }
  if (typeof (candidate as { readonly then?: unknown }).then !== 'function') {
    throw new TypeError(`${operation} must return a Promise.`);
  }
  return candidate as Promise<Value>;
}

function validId(value: unknown, name: string): void {
  if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
    throw new TypeError(`${name} must be a non-empty identifier.`);
  }
}

const pendingMappings = new WeakMap<object, Map<unknown, Promise<SyncRootMapping<unknown, unknown>>>>();

/**
 * Resolves and durably establishes the browser root for a Sync Root.
 *
 * Resolution is intentionally marker-based: a persisted mapping is accepted
 * only after the browser confirms the node, otherwise the live root listing
 * is searched by serverRootId. A missing root is created through the browser
 * API and its assigned ID is persisted. No browser ID is assumed or supplied
 * by this contract.
 */
export async function establishSyncRootMapping<ServerRootId = string, BrowserRootId = string>(
  serverRootId: ServerRootId,
  adapter: SyncRootMappingAdapter<ServerRootId, BrowserRootId>,
): Promise<SyncRootMapping<ServerRootId, BrowserRootId>> {
  validId(serverRootId, 'Server Root ID');

  let pending = pendingMappings.get(adapter);
  if (pending === undefined) {
    pending = new Map();
    pendingMappings.set(adapter, pending);
  }
  const existing = pending.get(serverRootId);
  if (existing !== undefined) return existing as Promise<SyncRootMapping<ServerRootId, BrowserRootId>>;
  // Defer adapter callbacks until the shared pending entry is installed.
  const work = Promise.resolve().then(() => establishWithLock(serverRootId, adapter));
  pending.set(serverRootId, work);
  const clear = (): void => {
    pending.delete(serverRootId);
    if (pending.size === 0) pendingMappings.delete(adapter);
  };
  void work.then(clear, clear);
  return work;
}

async function establishWithLock<ServerRootId, BrowserRootId>(
  serverRootId: ServerRootId,
  adapter: SyncRootMappingAdapter<ServerRootId, BrowserRootId>,
): Promise<SyncRootMapping<ServerRootId, BrowserRootId>> {
  if (adapter.withRootMappingLock === undefined) return establishMapping(serverRootId, adapter);
  let active = true;
  let invoked = false;
  let completed: SyncRootMapping<ServerRootId, BrowserRootId> | undefined;
  try {
    const result = await requirePromise<SyncRootMapping<ServerRootId, BrowserRootId>>(
      adapter.withRootMappingLock(serverRootId, async () => {
        if (!active || invoked) throw new TypeError('Root mapping lock must invoke work exactly once while held.');
        invoked = true;
        completed = await establishMapping(serverRootId, adapter);
        return completed;
      }),
      'Root mapping lock boundary',
    );
    if (completed === undefined || result !== completed) {
      throw new TypeError('Root mapping lock must return the completed callback result.');
    }
    return result;
  } finally {
    active = false;
  }
}

async function establishMapping<ServerRootId, BrowserRootId>(
  serverRootId: ServerRootId,
  adapter: SyncRootMappingAdapter<ServerRootId, BrowserRootId>,
): Promise<SyncRootMapping<ServerRootId, BrowserRootId>> {

  const stored = await requirePromise<SyncRootMapping<ServerRootId, BrowserRootId> | undefined>(
    adapter.loadRootMapping(serverRootId),
    'Root mapping load boundary',
  );
  if (stored !== undefined) {
    if (stored.serverRootId !== serverRootId) {
      throw new TypeError('Persisted Root Mapping belongs to a different Sync Root.');
    }
    validId(stored.browserRootId, 'Browser Root ID');
    const current = await requirePromise<SyncBrowserRoot<ServerRootId, BrowserRootId> | undefined>(
      adapter.readBrowserRoot(stored.browserRootId),
      'Browser root read boundary',
    );
    if (current !== undefined && current.isRoot !== false) {
      const mapping = Object.freeze({ serverRootId, browserRootId: stored.browserRootId });
      if (current.serverRootId !== undefined && current.serverRootId !== serverRootId) {
        throw new TypeError('Persisted Browser Root Mapping conflicts with the browser root marker.');
      }
      return mapping;
    }
  }

  const roots = await requirePromise<readonly SyncBrowserRoot<ServerRootId, BrowserRootId>[]>(
    adapter.listBrowserRoots(),
    'Browser root listing boundary',
  );
  const matches = roots.filter((root) => root.serverRootId === serverRootId && root.isRoot !== false);
  if (matches.length > 1) throw new TypeError('Multiple Browser Roots are mapped to the same Sync Root.');

  const browserRootId = matches[0]?.browserRootId
    ?? await requirePromise<BrowserRootId>(
      adapter.createBrowserRoot(serverRootId),
      'Browser root creation boundary',
    );
  validId(browserRootId, 'Browser Root ID');
  const mapping = Object.freeze({ serverRootId, browserRootId });
  await requirePromise<void>(adapter.saveRootMapping(mapping), 'Root mapping save boundary');
  return mapping;
}

/** Alias for adapters that use "resolve" terminology. */
export const resolveSyncRootMapping = establishSyncRootMapping;
