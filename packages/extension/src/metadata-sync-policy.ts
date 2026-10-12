/** A user choice, not a remote-field binding. Stored per server/account/collection. */
export interface MetadataPolicyScope {
  readonly serverOrigin: string;
  readonly accountId: string;
  readonly collectionId: string;
}
export interface MetadataPolicyStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
export interface MetadataSyncPolicy {
  readonly mode: 'sync' | 'local-only';
  readonly revision: string;
}
export const METADATA_POLICY_PREFIX = 'known.metadata-sync-policy.v1:';

export function metadataPolicyKey(scope: MetadataPolicyScope): string {
  const parts = [scope.serverOrigin, scope.accountId, scope.collectionId];
  if (parts.some(value => typeof value !== 'string' || !value || value.length > 2048)) {
    throw new Error('metadata_scope_invalid');
  }
  return METADATA_POLICY_PREFIX + JSON.stringify(parts);
}

/** Absence cannot prove consent: older keep-local choices were not recorded. */
export function parseMetadataPolicy(value: unknown): MetadataSyncPolicy {
  if (value === undefined) return { mode: 'local-only', revision: 'unconfigured' };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length === 2 && (row.mode === 'sync' || row.mode === 'local-only')
      && typeof row.revision === 'string' && /^[0-9a-f-]{36}$/u.test(row.revision)) {
      return { mode: row.mode, revision: row.revision };
    }
  }
  // Corruption or a future schema is never permission to upload.
  return { mode: 'local-only', revision: 'invalid' };
}

export function createMetadataSyncPolicyStore(storage: MetadataPolicyStorage) {
  const tails = new Map<string, Promise<void>>();
  const denied = new Map<string, number>();
  let intentVersion = 0;
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(key, settled);
    void settled.then(() => { if (tails.get(key) === settled) tails.delete(key); });
    return result;
  }
  async function read(scope: MetadataPolicyScope): Promise<MetadataSyncPolicy> {
    const key = metadataPolicyKey(scope);
    const refusal = (): MetadataSyncPolicy | undefined => denied.has(key)
      ? { mode: 'local-only', revision: `denied:${denied.get(key)}` } : undefined;
    const pending = refusal();
    if (pending) return pending;
    const value = (await storage.get(key))[key];
    return refusal() ?? parseMetadataPolicy(value);
  }
  async function write(scope: MetadataPolicyScope, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('metadata_policy_invalid');
    const key = metadataPolicyKey(scope);
    const version = ++intentVersion;
    // An off intent denies immediately, even if persistence fails. Only a newer
    // successful affirmative choice can reopen this worker's admission gate.
    if (!enabled) denied.set(key, version);
    await serialized(key, async () => {
      await storage.set({ [key]: { mode: enabled ? 'sync' : 'local-only', revision: crypto.randomUUID() } });
      if (enabled && (denied.get(key) ?? -1) < version) denied.delete(key);
    });
  }
  async function capture(scope: MetadataPolicyScope) {
    const policy = await read(scope);
    if (policy.mode !== 'sync') throw new Error('metadata_sync_disabled');
    return Object.assign(async () => {
      const live = await read(scope);
      if (live.mode !== 'sync' || live.revision !== policy.revision) throw new Error('metadata_sync_disabled');
    }, { revision: policy.revision });
  }
  async function dispatch<T>(scope: MetadataPolicyScope, send: () => Promise<T>, expectedRevision?: string): Promise<T> {
    // Serialize admission, NOT the response: a stalled server cannot hold the off switch.
    const key = metadataPolicyKey(scope);
    const admitted = await serialized(key, async () => {
      const permission = await read(scope);
      // read() can resolve one microtask before an off intent is received. The
      // final synchronous check closes that read-to-dispatch admission race.
      if (permission.mode !== 'sync' || denied.has(key)
        || expectedRevision !== undefined && permission.revision !== expectedRevision) throw new Error('metadata_sync_disabled');
      const response = send();
      // Attach immediately even when an already-rejected promise was returned.
      void response.catch(() => undefined);
      return { response };
    });
    return admitted.response;
  }
  return Object.freeze({ read, write, capture, dispatch });
}

/** Inspect the immutable COLP body without rewriting its idempotency identity or bytes. */
export function containsMetadataUpload(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  let document: unknown;
  try { document = JSON.parse(body); } catch { return false; }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  const operations = (document as Record<string, unknown>).operations;
  if (!Array.isArray(operations)) return false;
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
    const record = operation as Record<string, unknown>;
    // A new server-selected identity with empty optional defaults is ordinary
    // bookmark creation, not copying local metadata. Clears on existing nodes
    // still require consent, and immutable attempt bytes are never rewritten.
    if (payloadHasMetadata(record.payload, record.type === 'create_node')) return true;
  }
  return false;
}

function payloadHasMetadata(payload: unknown, newIdentity: boolean): boolean {
  const pending: unknown[] = [payload];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const record = value as Record<string, unknown>;
    for (const key of ['tags', 'description']) {
      if (!Object.hasOwn(record, key)) continue;
      const field = record[key];
      const empty = key === 'tags' ? Array.isArray(field) && field.length === 0 : field === null || field === '';
      if (!newIdentity || !empty) return true;
    }
    pending.push(...Object.values(record));
  }
  return false;
}

let browserPolicy: ReturnType<typeof createMetadataSyncPolicyStore> | undefined;
export function browserMetadataSyncPolicy() {
  return browserPolicy ??= createMetadataSyncPolicyStore(chrome.storage.local);
}
