/** Account-scoped personal sync policy. It is not an authentication or subscription switch. */
export interface PersonalSyncIdentity {
  readonly serverOrigin: string;
  readonly accountId: string;
  readonly collectionId?: string;
}
export type PersonalSyncMode = 'enabled' | 'paused' | 'disconnected' | 'target-unavailable';
export type PersonalSyncReason = 'user' | 'signed-out' | 'target-unavailable' | 'metadata-consent' | 'invalid';
export interface PersonalSyncPolicy {
  readonly version: 1;
  readonly mode: PersonalSyncMode;
  readonly collectionId: string | null;
  readonly revision: string;
  readonly reason: PersonalSyncReason;
}
export interface PersonalSyncStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
export const PERSONAL_SYNC_PREFIX = 'known.personal-sync.v1:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const modes = new Set<unknown>(['enabled', 'paused', 'disconnected', 'target-unavailable']);
const reasons = new Set<unknown>(['user', 'signed-out', 'target-unavailable', 'metadata-consent', 'invalid']);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048;
export class PersonalSyncStopped extends Error {
  readonly code = 'personal_sync_stopped';
  constructor() { super('personal_sync_stopped'); this.name = 'PersonalSyncStopped'; }
}
export function personalSyncKey(identity: PersonalSyncIdentity): string {
  if (!id(identity.serverOrigin) || !id(identity.accountId)
    || identity.collectionId !== undefined && !id(identity.collectionId)) throw new Error('personal_sync_identity_invalid');
  return PERSONAL_SYNC_PREFIX + JSON.stringify([identity.serverOrigin, identity.accountId]);
}
export function parsePersonalSyncPolicy(raw: unknown): PersonalSyncPolicy {
  // Existing configured replicas remain enabled on upgrade. Absence does not create a binding.
  if (raw === undefined) return { version: 1, mode: 'enabled', collectionId: null, revision: 'legacy', reason: 'user' };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).length === 5 && row.version === 1 && modes.has(row.mode) && reasons.has(row.reason)
      && (row.collectionId === null || id(row.collectionId)) && typeof row.revision === 'string' && uuid.test(row.revision)) {
      return { version: 1, mode: row.mode as PersonalSyncMode, collectionId: row.collectionId as string | null,
        revision: row.revision, reason: row.reason as PersonalSyncReason };
    }
  }
  return { version: 1, mode: 'paused', collectionId: null, revision: 'invalid', reason: 'invalid' };
}
export function personalSyncAllowed(policy: PersonalSyncPolicy, identity: PersonalSyncIdentity): boolean {
  return policy.mode === 'enabled' && (identity.collectionId === undefined || policy.collectionId === null
    || policy.collectionId === identity.collectionId);
}

/** The only writer is the worker. Reads in other extension contexts still consult durable policy. */
export function createPersonalSyncPolicyStore(storage: PersonalSyncStorage) {
  const tails = new Map<string, Promise<void>>();
  const blocked = new Map<string, PersonalSyncMode>();
  const epochs = new Map<string, number>();
  const intents = new Map<string, number>();
  const controllers = new Map<string, AbortController>();
  const epoch = (key: string) => epochs.get(key) ?? 0;
  function invalidate(key: string): void {
    epochs.set(key, epoch(key) + 1);
    controllers.get(key)?.abort(new PersonalSyncStopped());
    controllers.delete(key);
  }
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  async function read(identity: PersonalSyncIdentity): Promise<PersonalSyncPolicy> {
    const key = personalSyncKey(identity), raw = (await storage.get(key))[key];
    const value = parsePersonalSyncPolicy(raw);
    return blocked.has(key) ? { ...value, mode: blocked.get(key) === 'disconnected' || value.mode === 'disconnected'
      ? 'disconnected' : 'paused' } : value;
  }
  function write(identity: PersonalSyncIdentity, mode: PersonalSyncMode, reason: PersonalSyncReason = 'user', expectedRevision?: string): Promise<PersonalSyncPolicy> {
    if (!modes.has(mode) || !reasons.has(reason)) return Promise.reject(new Error('personal_sync_policy_invalid'));
    const key = personalSyncKey(identity);
    // Fence before awaiting storage or queued work. A failed write never reopens this worker.
    const pendingDisconnect = blocked.get(key) === 'disconnected';
    blocked.set(key, pendingDisconnect && mode !== 'enabled' ? 'disconnected' : mode); invalidate(key);
    const intent = (intents.get(key) ?? 0) + 1; intents.set(key, intent);
    return serial(key, async () => {
      const current = parsePersonalSyncPolicy((await storage.get(key))[key]);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        if (intents.get(key) === intent) blocked.delete(key);
        throw new Error('personal_sync_preview_stale');
      }
      // Other off states cannot erase unfinished retirement, including a failed durable write.
      const nextMode = mode !== 'enabled' && (current.mode === 'disconnected' || pendingDisconnect) ? 'disconnected' : mode;
      const value: PersonalSyncPolicy = { version: 1, mode: nextMode, collectionId: identity.collectionId ?? null,
        reason, revision: crypto.randomUUID() };
      await storage.set({ [key]: value });
      if (intents.get(key) === intent) blocked.delete(key);
      return value;
    });
  }
  function withRevision<T>(identity: PersonalSyncIdentity, revision: string, effect: () => Promise<T>): Promise<T> {
    const key = personalSyncKey(identity), started = epoch(key);
    return serial(key, async () => {
      const current = await read(identity);
      if (blocked.has(key) || epoch(key) !== started || current.revision !== revision) throw new Error('personal_sync_preview_stale');
      // Local publication and later policy writes share this lane. Off intent still
      // invalidates network capabilities immediately; no HTTP runs in this effect.
      return effect();
    });
  }
  async function capture(identity: PersonalSyncIdentity) {
    const key = personalSyncKey(identity), started = epoch(key);
    const value = await read(identity);
    if (!personalSyncAllowed(value, identity) || blocked.has(key) || epoch(key) !== started) throw new PersonalSyncStopped();
    let controller = controllers.get(key);
    if (!controller) { controller = new AbortController(); controllers.set(key, controller); }
    const signal = controller.signal;
    const check = () => { if (blocked.has(key) || epoch(key) !== started || signal.aborted) throw new PersonalSyncStopped(); };
    async function assertCurrent(): Promise<void> {
      check(); const current = await read(identity); check();
      if (!personalSyncAllowed(current, identity) || current.revision !== value.revision) throw new PersonalSyncStopped();
    }
    async function dispatch<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
      // Serialize admission only. HTTP completion must never keep Pause waiting.
      const admitted = await serial(key, async () => {
        await assertCurrent(); check();
        const response = send(signal); void response.catch(() => undefined);
        return { response };
      });
      return admitted.response;
    }
    return Object.freeze({ signal, revision: value.revision, assertCurrent, assertLive: check, dispatch });
  }
  return Object.freeze({ read, write, capture, withRevision,
    async allowed(identity: PersonalSyncIdentity) { return personalSyncAllowed(await read(identity), identity); },
    changed(keys: readonly string[]) { for (const key of keys) if (key.startsWith(PERSONAL_SYNC_PREFIX)) invalidate(key); },
  });
}
let singleton: ReturnType<typeof createPersonalSyncPolicyStore> | undefined;
export function browserPersonalSyncPolicy() {
  if (!singleton) {
    singleton = createPersonalSyncPolicyStore(chrome.storage.local);
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local') singleton?.changed(Object.keys(changes));
    });
  }
  return singleton;
}
