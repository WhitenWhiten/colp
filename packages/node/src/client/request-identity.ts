import type { ManifestMount } from '../types/index.js';
import { abortable, type RequestBudget } from './request-budget.js';

export type CredentialProvider = (
  url: URL,
  mount: ManifestMount | undefined,
) => Readonly<Record<string, string>> | undefined | Promise<Readonly<Record<string, string>> | undefined>;

/** One captured principal. The credential callback must close over that principal. */
export interface ClientRequestIdentity {
  /** Stable principal/authorization-view key. Omit or return empty to disable caching. */
  readonly cachePartition?: string;
  /** Called after egress authorization for each URL, including redirects and pages. */
  readonly credentialProvider: CredentialProvider;
  /** Abort this identity epoch on logout/revocation to discard in-flight results. */
  readonly signal?: AbortSignal;
}

/** Called once per public invocation, within its deadline and before any cache access. */
export type ClientRequestIdentityProvider = (
  signal: AbortSignal,
) => ClientRequestIdentity | Promise<ClientRequestIdentity>;

export interface ClientRequestContext extends RequestBudget {
  readonly identity?: ClientRequestIdentity;
}

export async function withClientRequestIdentity<Value>(
  budget: RequestBudget,
  provider: ClientRequestIdentityProvider | undefined,
  work: (context: ClientRequestContext) => Promise<Value>,
): Promise<Value> {
  if (provider === undefined) return work(budget);
  const raw = await abortable(Promise.resolve(provider(budget.signal)), budget.signal);
  if (raw === null || typeof raw !== 'object') throw new TypeError('requestIdentityProvider must return an identity.');
  const { cachePartition, credentialProvider, signal: epochSignal } = raw;
  if (cachePartition !== undefined && typeof cachePartition !== 'string') {
    throw new TypeError('Request identity cachePartition must be a string.');
  }
  if (typeof credentialProvider !== 'function') throw new TypeError('Request identity credentialProvider must be a function.');
  if (epochSignal !== undefined && !(epochSignal instanceof AbortSignal)) {
    throw new TypeError('Request identity signal must be an AbortSignal.');
  }
  const signal = epochSignal === undefined ? budget.signal : AbortSignal.any([budget.signal, epochSignal]);
  signal.throwIfAborted();
  const identity = Object.freeze<ClientRequestIdentity>({
    ...(cachePartition === undefined ? {} : { cachePartition }),
    credentialProvider: (url, mount) => Reflect.apply(credentialProvider, raw, [url, mount]),
  });
  const result = await abortable(work({ ...budget, identity, signal }), signal);
  signal.throwIfAborted();
  return result;
}
