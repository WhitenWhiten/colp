import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { Readable } from 'node:stream';

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


/**
 * Node-only fetch transport that connects directly to a previously approved
 * address while retaining the URL host for Host/SNI. Resolving and connecting
 * in one transport removes the DNS-rebinding window between policy checking
 * and the socket connection. Browser/custom fetch implementations must provide
 * their own equivalent pinning boundary.
 */
export type PinnedNodeFetch = (
  url: URL,
  init: RequestInit,
  approvedAddress?: string,
) => Promise<Response>;

export function defaultPinnedNodeFetch(): PinnedNodeFetch | undefined {
  const runtime = globalThis as typeof globalThis & NodeRuntime;
  if (runtime.process?.versions?.node === undefined || runtime.process.getBuiltinModule === undefined) {
    return undefined;
  }
  const http = runtime.process.getBuiltinModule('node:http') as NodeHttpModule | undefined;
  const https = runtime.process.getBuiltinModule('node:https') as NodeHttpModule | undefined;
  const stream = runtime.process.getBuiltinModule('node:stream') as { readonly Readable?: typeof Readable } | undefined;
  if (http?.request === undefined || https?.request === undefined || stream?.Readable?.toWeb === undefined) return undefined;
  const toWeb = stream.Readable.toWeb;

  return (url, init, approvedAddress) => new Promise<Response>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const module = secure ? https : http;
    const headers = new Headers(init.headers);
    // Keep a caller-supplied Host header for virtual hosting, while defaulting
    // to the original URL authority. TLS SNI is always derived from the URL.
    if (!headers.has('host')) headers.set('Host', url.host);
    const address = approvedAddress ?? (url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname);
    const requestFn = module.request;
    if (requestFn === undefined) {
      reject(new TypeError('Node HTTP transport is unavailable.'));
      return;
    }
    const request = requestFn({
      hostname: address,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      ...(secure ? { servername: url.hostname.replace(/^\[|\]$/gu, '') } : {}),
    }, (response) => {
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = response.statusCode ?? 500;
        const noBody = init.method?.toUpperCase() === 'HEAD' || [204, 205, 304].includes(status);
        // Node's bridge propagates cancellation and applies backpressure rather
        // than eagerly queueing an unbounded response through data listeners.
        const body = noBody ? null : toWeb(response, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>;
        if (noBody) response.resume();
        resolve(new Response(body, {
          status,
          ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
          headers: responseHeaders,
        }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    const signal = init.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        request.destroy(signal.reason);
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => { request.destroy(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    const body = init.body;
    if (typeof body === 'string' || body instanceof Uint8Array) request.write(body);
    request.end();
  });
}

interface NodeHttpModule {
  readonly request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
}
