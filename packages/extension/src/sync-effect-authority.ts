import { AuthorityFencedError, type AuthorityContext } from './authority-fence.js';
import { browserMetadataSyncPolicy, containsMetadataUpload } from './metadata-sync-policy.js';
import { configuredPersonalSyncPolicy } from './personal-sync-fetch.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { SyncScope } from './sync-state-store.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { NativeWriteCheck } from './native-call-result.js';

/** One live capability for ordinary Pull and snapshot projection, including resumed work. */
export function createSyncEffectAuthority(options: {
  context: AuthorityContext; scope: SyncScope;
  assertWritable(generation: number): Promise<unknown>;
  currentScope(): Promise<SyncScope>;
  api: PullBookmarkApi; fetch?: typeof fetch;
  metadataPolicy?: Pick<ReturnType<typeof browserMetadataSyncPolicy>, 'dispatch'>;
}) {
  const admitted = configuredPersonalSyncPolicy()?.capture(options.scope);
  void admitted?.catch(() => undefined);
  async function assertCurrent() {
    await (await admitted)?.assertCurrent();
    if (options.context.signal.aborted) throw new AuthorityFencedError();
    await options.assertWritable(options.context.generation);
    const current = await options.currentScope().catch(() => { throw new AuthorityFencedError(); });
    if (scopeKey(current) !== scopeKey(options.scope) || options.context.signal.aborted) throw new AuthorityFencedError();
  }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    await assertCurrent();
    (await admitted)?.assertLive();
    return work();
  }
  function beforeWrite(check?: NativeWriteCheck): NativeWriteCheck {
    return async () => {
      await assertCurrent();
      const lease = await admitted;
      lease?.assertLive();
      await check?.();
      lease?.assertLive();
      if (options.context.signal.aborted) throw new AuthorityFencedError();
    };
  }
  const api: PullBookmarkApi = {
    ...(options.api.nativeWriteChecks ? { nativeWriteChecks: true } : {}),
    create: (input, check) => run(() => options.api.create(input, beforeWrite(check))),
    update: (id, changes, check) => run(() => options.api.update(id, changes, beforeWrite(check))),
    move: (id, destination, check) => run(() => options.api.move(id, destination, beforeWrite(check))),
    remove: (id, check) => run(() => options.api.remove(id, beforeWrite(check))),
    removeTree: (id, check) => run(() => options.api.removeTree(id, beforeWrite(check))),
    get: id => run(() => options.api.get(id)),
    getChildren: id => run(() => options.api.getChildren(id)),
  };
  const fetcher: typeof fetch = async (input, init) => {
    await assertCurrent();
    const lease = await admitted;
    const signal = AbortSignal.any([options.context.signal, ...(init?.signal ? [init.signal] : []), ...(lease ? [lease.signal] : [])]);
    const send = () => {
      lease?.assertLive();
      if (signal.aborted) throw new AuthorityFencedError();
      return (options.fetch ?? fetch)(input, { ...init, signal });
    };
    // COLP attempts have a bounded, immutable JSON string body. Retrying an old
    // attempt cannot bypass a later local-only decision. Never strip fields from
    // an already identified operation or alter its sequence/idempotency identity.
    const response = containsMetadataUpload(init?.body)
      ? await (options.metadataPolicy ?? browserMetadataSyncPolicy()).dispatch(options.scope, send)
      : await send();
    await assertCurrent();
    return response;
  };
  return { assertCurrent, run, api, fetch: fetcher };
}
