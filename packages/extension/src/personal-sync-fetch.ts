import type { PersonalSyncIdentity, createPersonalSyncPolicyStore } from './personal-sync-policy.js';
import { createSyncBoundaryFetch, dispatchSyncFetch } from './sync-fetch-boundary.js';
type Policy = ReturnType<typeof createPersonalSyncPolicyStore>;
let configured: Policy | undefined;
/** Composition-root wiring: domain tests supply their own ports; shipped worker entry installs this before consumers. */
export function configurePersonalSyncTransport(policy: Policy): void {
  if (configured && configured !== policy) throw new Error('personal_sync_transport_already_configured');
  configured = policy;
}
export function configuredPersonalSyncPolicy(): Policy | undefined { return configured; }
/** Eager capability capture prevents work created before Pause from reviving after a quick Resume. */
export function personalSyncFetch(identity: PersonalSyncIdentity, fetcher: typeof fetch = fetch,
  dispatch?: (send: (assertDispatchLive?: () => void) => Promise<Response>) => Promise<Response>): typeof fetch {
  if (!configured && !dispatch) return fetcher;
  const admitted = configured?.capture(identity); void admitted?.catch(() => undefined);
  return createSyncBoundaryFetch(async (input, init, boundary) => {
    const current = await admitted;
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const run = (signal?: AbortSignal) => {
      const request = signal ? { ...init, signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal } : init;
      const send = (assertDispatchLive?: () => void) => dispatchSyncFetch(fetcher, input, request, {
        check: boundary?.check,
        started: () => {
          // Other gates and the caller's final content proof may await storage.
          current?.assertLive(); assertDispatchLive?.(); boundary?.started();
        },
      });
      return dispatch ? dispatch(send) : send();
    };
    const response = await (current ? current.dispatch(run) : run());
    await current?.assertCurrent(); return response;
  });
}
/** Capability-wrap the native port, including reads between which a pause may arrive. */
export async function personalSyncNativeApi<T extends object>(identity: PersonalSyncIdentity, api: T,
  assertAttempt?: () => Promise<void>): Promise<T> {
  if (!configured && !assertAttempt) return api;
  const lease = await configured?.capture(identity);
  return new Proxy(api, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        await assertAttempt?.();
        await lease?.assertCurrent(); lease?.assertLive();
        const checkIndex = ({ createNative: 1, updateNative: 2, moveNative: 2, removeNative: 2,
          ...(Reflect.get(target, 'nativeWriteChecks') === true ? { create: 1, update: 2, move: 2, remove: 1, removeTree: 1 } : {}),
        } as Record<string, number>)[String(property)];
        const finalCheck = checkIndex === undefined ? undefined : args[checkIndex];
        if (checkIndex !== undefined) args[checkIndex] = async () => {
          // Subscription/folder admission inside the native adapter may yield
          // after the outer attempt check. Revalidate that same lease first,
          // then run the caller's frozen-preimage check last.
          await assertAttempt?.(); await lease?.assertCurrent(); lease?.assertLive();
          if (typeof finalCheck === 'function') await finalCheck();
          lease?.assertLive();
        };
        return Reflect.apply(member, target, args);
      };
    },
  });
}
