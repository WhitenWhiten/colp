export const AUTHORITY_GENERATION_KEY = 'known.auth.authority-generation.v1';

export type WorkLane = 'auth' | 'session' | 'engine' | 'bookmark' | 'local-bookmark' | 'native-bookmark' | 'root' | 'import' | 'classification'
  | 'local-classification';

export interface AuthorityGenerationRecord {
  readonly generation: number;
  readonly revoked: boolean;
}

export interface AuthorityContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export class AuthorityFencedError extends Error {
  readonly code = 'authority_fenced';
  constructor() {
    super('authority_fenced');
    this.name = 'AuthorityFencedError';
  }
}

export interface GenerationStorage {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function createAuthorityFence(storage: GenerationStorage) {
  let abort = new AbortController();

  async function read(): Promise<AuthorityGenerationRecord> {
    const raw = (await storage.get(AUTHORITY_GENERATION_KEY))[AUTHORITY_GENERATION_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { generation: 0, revoked: false };
    const record = raw as { generation?: unknown; revoked?: unknown };
    const generation = Number.isSafeInteger(record.generation) ? Number(record.generation) : 0;
    return { generation, revoked: record.revoked === true };
  }

  async function write(next: AuthorityGenerationRecord): Promise<AuthorityGenerationRecord> {
    abort.abort();
    abort = new AbortController();
    await storage.set({ [AUTHORITY_GENERATION_KEY]: next });
    return next;
  }

  async function capture(): Promise<AuthorityContext> {
    const current = await read();
    return { generation: current.generation, signal: abort.signal };
  }

  async function assertWritable(expected?: number): Promise<AuthorityGenerationRecord> {
    const current = await read();
    if (current.revoked || (expected !== undefined && current.generation !== expected)) {
      throw new AuthorityFencedError();
    }
    return current;
  }

  return Object.freeze({
    read, capture, assertWritable,
    signal: () => abort.signal,
    async activate(): Promise<AuthorityContext> {
      const prior = await read();
      const next = await write({ generation: prior.generation + 1, revoked: false });
      return { generation: next.generation, signal: abort.signal };
    },
    async revoke(): Promise<AuthorityContext> {
      const prior = await read();
      const next = await write({ generation: prior.generation + 1, revoked: true });
      return { generation: next.generation, signal: abort.signal };
    },
  });
}

export type AuthorityFence = ReturnType<typeof createAuthorityFence>;

export function createExtensionWorkCoordinator(fence: AuthorityFence) {
  const tails = new Map<WorkLane, Promise<void>>();
  const inflight = new Map<Promise<unknown>, WorkLane>();
  const pending = new Map<WorkLane, number>();

  function hasInFlight(lane?: WorkLane): boolean {
    if (lane) return (pending.get(lane) ?? 0) > 0;
    return [...pending.values()].some((count) => count > 0);
  }

  function run<T>(lane: WorkLane, work: (context: AuthorityContext) => Promise<T>): Promise<T> {
    pending.set(lane, (pending.get(lane) ?? 0) + 1);
    // Native batches share serialization with captures and other native edits,
    // while their admission remains independent of account authority.
    const queueLane = lane === 'native-bookmark' ? 'local-bookmark' : lane;
    const previous = tails.get(queueLane) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    tails.set(queueLane, previous.then(() => gate, () => gate));
    const task = (async () => {
      const enqueued = lane === 'native-bookmark' ? { generation: 0, signal: LOCAL_SIGNAL } : await fence.capture();
      await previous;
      return execute(lane, fence, enqueued, work);
    })();
    inflight.set(task, lane);
    return task.finally(() => {
      inflight.delete(task);
      pending.set(lane, Math.max(0, (pending.get(lane) ?? 1) - 1));
      release();
    });
  }

  async function drain(excludeLane?: WorkLane): Promise<void> {
    const pending = [...inflight.entries()]
      .filter(([, lane]) => lane !== excludeLane)
      .map(([task]) => task);
    await Promise.allSettled(pending);
  }

  return Object.freeze({ run, drain, hasInFlight, fence });
}

export type ExtensionWorkCoordinator = ReturnType<typeof createExtensionWorkCoordinator>;

const LOCAL_SIGNAL = new AbortController().signal;

async function execute<T>(
  lane: WorkLane,
  fence: AuthorityFence,
  enqueued: AuthorityContext,
  work: (context: AuthorityContext) => Promise<T>,
): Promise<T> {
  if (lane === 'auth') return work(await fence.capture());
  // Profile-owned native journals carry no account commands or credentials.
  if (lane === 'native-bookmark') return work(enqueued);
  // The user's own provider over this browser's folders: no Know-N account is
  // involved, so sign-in, sign-out and account switches neither fence nor abort it.
  if (lane === 'local-classification') return work({ generation: (await fence.read()).generation, signal: LOCAL_SIGNAL });
  if (enqueued.signal.aborted) throw new AuthorityFencedError();
  const current = await fence.read();
  if ((current.revoked && lane !== 'local-bookmark') || current.generation !== enqueued.generation) {
    throw new AuthorityFencedError();
  }
  return work(enqueued);
}
