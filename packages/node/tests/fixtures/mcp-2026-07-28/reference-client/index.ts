/**
 * Independent black-box reference client wrapper for the MCP 2026-07-28
 * fixture harness. Wraps the official `@modelcontextprotocol/client`
 * implementation (pinned modern era via `server/discover`) behind a small
 * COLP-owned surface used by the harness contract tests. It shares no
 * hand-written frame parser with anything under `src/` — both sides of the
 * fixture harness use the upstream SDK's transport/framing.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type DiscoverResult,
  type FetchLike,
  type Implementation,
  type RequestMethod,
  type RequestOptions,
  type SubscriptionFilter,
} from '@modelcontextprotocol/client';

import { MCP_PROTOCOL_VERSION } from '../../../../src/mcp/protocol-version.js';

export interface ReferenceMcpClientOptions {
  readonly url: URL | string;
  /** Bridge used for every HTTP exchange (typically the fixture host's fetch). */
  readonly fetchBridge: FetchLike;
  readonly clientInfo?: Implementation;
}

export interface ReferenceMcpSubscription {
  readonly honoredFilter: unknown;
  readonly closed: Promise<unknown>;
  close(): Promise<void>;
}

export interface ReferenceMcpClient {
  connect(): Promise<void>;
  discover(): Promise<DiscoverResult>;
  request(request: { method: RequestMethod; params?: Record<string, unknown> }, requestOptions?: RequestOptions): Promise<unknown>;
  listen(filter: SubscriptionFilter, options?: { signal?: AbortSignal; timeout?: number }): Promise<ReferenceMcpSubscription>;
  close(): Promise<void>;
  getDiscoverResult(): DiscoverResult | undefined;
  getProtocolEra(): 'modern' | 'legacy' | undefined;
  getNegotiatedProtocolVersion(): string | undefined;
  getServerCapabilities(): unknown;
}

export function createReferenceMcpClient(options: ReferenceMcpClientOptions): ReferenceMcpClient {
  const clientInfo: Implementation = options.clientInfo ?? {
    name: 'colp-reference-client',
    version: '0.0.0',
  };
  const client = new Client(clientInfo, {
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: options.fetchBridge,
  });

  return {
    async connect() {
      await client.connect(transport);
    },
    async discover() {
      return client.discover();
    },
    async request(request, requestOptions) {
      return client.request(request, requestOptions);
    },
    async listen(filter, listenOptions) {
      const subscription = await client.listen(filter, listenOptions);
      return {
        honoredFilter: subscription.honoredFilter,
        closed: subscription.closed,
        async close() {
          await subscription.close();
        },
      };
    },
    async close() {
      await client.close();
    },
    getDiscoverResult() {
      return client.getDiscoverResult();
    },
    getProtocolEra() {
      return client.getProtocolEra();
    },
    getNegotiatedProtocolVersion() {
      return client.getNegotiatedProtocolVersion();
    },
    getServerCapabilities() {
      return client.getServerCapabilities();
    },
  };
}
