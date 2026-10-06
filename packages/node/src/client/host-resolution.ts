import { abortable } from './request-budget.js';

/**
 * Resolves a request hostname to all of its addresses. The resolver is an
 * injected transport capability so browser bundles and custom fetch
 * implementations do not acquire a Node DNS dependency.
 */
export type ClientHostResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

interface NodeDnsPromises {
  readonly lookup?: (
    hostname: string,
    options: { readonly all: true; readonly verbatim: true },
  ) => Promise<readonly { readonly address: string }[]>;
}

interface NodeRuntime {
  readonly process?: {
    readonly versions?: { readonly node?: unknown };
    readonly getBuiltinModule?: (specifier: string) => unknown;
  };
}

/**
 * Gets Node's DNS promises module without a static `node:dns` import. This
 * keeps the client entry consumable by browser bundlers; browser and custom
 * fetch callers can provide their own resolver when the transport exposes one.
 */
export function defaultClientHostResolver(): ClientHostResolver | undefined {
  const runtime = globalThis as typeof globalThis & NodeRuntime;
  if (runtime.process?.versions?.node === undefined || runtime.process.getBuiltinModule === undefined) {
    return undefined;
  }
  const dns = runtime.process.getBuiltinModule('node:dns/promises') as NodeDnsPromises | undefined;
  if (dns?.lookup === undefined) return undefined;
  return async (hostname, signal) => {
    // WHATWG URL.hostname retains IPv6 brackets; Node lookup expects the
    // unbracketed address literal.
    const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    const result = await abortable(
      Promise.resolve(dns.lookup!(host, { all: true, verbatim: true })),
      signal,
    );
    if (!Array.isArray(result)) throw new TypeError('DNS resolver returned an invalid address list.');
    return result.map((entry) => {
      if (typeof entry?.address !== 'string' || entry.address.length === 0) {
        throw new TypeError('DNS resolver returned an invalid address.');
      }
      return entry.address;
    });
  };
}
