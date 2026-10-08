import {
  Client,
  StreamableHTTPClientTransport,
  type Implementation,
  type RequestMethod,
} from '@modelcontextprotocol/client';
import type { FetchImplementation } from '@know-n/colp/client';
import { PHASE4B_MCP_PROTOCOL_VERSION } from './phase4b-mcp-entry-contract.js';

export interface Phase4bMcpOfficialClientOptions {
  readonly url: string | URL;
  readonly authorization?: string;
  readonly fetch?: FetchImplementation;
  readonly clientInfo?: Implementation;
}

export interface Phase4bMcpOfficialClient {
  connect(): Promise<void>;
  discover(): Promise<unknown>;
  request(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Small shared official-client wrapper for the evidence and W08 real-stack
 * fixtures. It pins the 2026-07-28 era, streams through the official
 * Streamable HTTP transport, and uses the official AuthProvider seam when a
 * Bearer credential is supplied.
 */
export function createPhase4bMcpOfficialClient(
  options: Phase4bMcpOfficialClientOptions,
): Phase4bMcpOfficialClient {
  const clientInfo: Implementation = options.clientInfo ?? {
    name: 'known-phase4b-mcp-official-client',
    version: '1.0.0',
  };
  const client = new Client(clientInfo, {
    versionNegotiation: { mode: { pin: PHASE4B_MCP_PROTOCOL_VERSION } },
    capabilities: { tools: { call: true } } as never,
  });
  const token = options.authorization?.match(/^Bearer\s+(\S+)$/iu)?.[1];
  const rawResultsByMethod = new Map<string, unknown>();
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const captureFetch: FetchImplementation = async (input, init) => {
    const response = await fetchImplementation(input, init);
    const method = init?.method?.toUpperCase() ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    if (method !== 'POST' || bodyText.length === 0 || bodyText.includes('"subscriptions/listen"')) {
      return response;
    }
    let requestMethod: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as { readonly method?: unknown };
      requestMethod = typeof parsed.method === 'string' ? parsed.method : undefined;
    } catch {
      return response;
    }
    const originalBody = response.body;
    if (originalBody === null) return response;
    const decoder = new TextDecoder();
    let buffer = '';
    const captureResult = (text: string): void => {
      try {
        const message = JSON.parse(text) as { readonly result?: unknown };
        if (requestMethod !== undefined && message.result !== undefined) {
          rawResultsByMethod.set(requestMethod, message.result);
        }
      } catch {
        // Keep the transport stream intact even if a chunk is not complete JSON.
      }
    };
    const consumeEvents = (): void => {
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const dataLine = block.split('\n')
          .find((line) => line.startsWith('data: '));
        if (dataLine !== undefined) captureResult(dataLine.slice('data: '.length));
        separator = buffer.indexOf('\n\n');
      }
    };
    const transformed = originalBody.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        consumeEvents();
        controller.enqueue(chunk);
      },
      flush() {
        buffer += decoder.decode();
        consumeEvents();
        captureResult(buffer);
      },
    }));
    // Rebuild the Response around the transformed stream instead of
    // redefining `.body`: `pipeThrough` consumes the original body, so a
    // property override keeps `.json()`/`.text()` pointed at the drained
    // internal stream ("Body is unusable"). SSE reads went through `.body`
    // and never noticed; JSON responses (the MCP-U-09 Accept tie-break) do.
    return new Response(transformed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: captureFetch,
    ...(token === undefined ? {} : {
      authProvider: {
        token: async () => token,
      },
    }),
  });
  return Object.freeze({
    async connect() {
      await client.connect(transport);
    },
    async discover() {
      return mergeRawResult(await client.discover(), 'server/discover', rawResultsByMethod);
    },
    async request(method: string, params: Readonly<Record<string, unknown>> = {}) {
      const result = await client.request({
        method: method as RequestMethod,
        params,
      } as never, { allowInputRequired: true } as never);
      return mergeRawResult(result, method, rawResultsByMethod);
    },
    async close() {
      await client.close();
    },
  });
}

function mergeRawResult(
  result: unknown,
  method: string,
  rawResultsByMethod: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const raw = rawResultsByMethod.get(method);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result;
  const merged: Record<string, unknown> = { ...result as Record<string, unknown> };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in merged)) merged[key] = value;
  }
  return merged;
}
