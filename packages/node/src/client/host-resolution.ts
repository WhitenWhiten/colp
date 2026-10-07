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
  if (http?.request === undefined || https?.request === undefined) return undefined;

  return (url, init, approvedAddress) => new Promise<Response>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const module = secure ? https : http;
    const headers = new Headers(init.headers);
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
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', (chunk: Buffer | Uint8Array | string) => {
            controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
          });
          response.on('end', () => controller.close());
          response.on('error', error => controller.error(error));
        },
        cancel() { response.destroy(); },
      });
      resolve(new Response(body, {
        status: response.statusCode ?? 500,
        ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
        headers: responseHeaders,
      }));
    });
    request.once('error', reject);
    const signal = init.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        request.destroy(signal.reason);
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => request.destroy(signal.reason), { once: true });
    }
    const body = init.body;
    if (typeof body === 'string' || body instanceof Uint8Array) request.write(body);
    request.end();
  });
}

interface NodeHttpModule {
  readonly request?: (
    options: Record<string, unknown>,
    callback: (response: NodeHttpResponse) => void,
  ) => NodeHttpRequest;
}
interface NodeHttpRequest {
  readonly once: (event: string, listener: (...args: any[]) => void) => NodeHttpRequest;
  readonly on: (event: string, listener: (...args: any[]) => void) => NodeHttpRequest;
  readonly write: (body: string | Uint8Array) => void;
  readonly end: () => void;
  readonly destroy: (error?: unknown) => void;
}
interface NodeHttpResponse {
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly on: (event: string, listener: (...args: any[]) => void) => NodeHttpResponse;
  readonly destroy: () => void;
}
