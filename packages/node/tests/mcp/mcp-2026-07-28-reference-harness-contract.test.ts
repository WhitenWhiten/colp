import { SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/core/internal';
import { describe, expect, it } from 'vitest';

import {
  createFixtureHost,
  type FixtureHost,
} from '../fixtures/mcp-2026-07-28/fixture-host/index.js';
import {
  createReferenceMcpClient,
  type ReferenceMcpClient,
} from '../fixtures/mcp-2026-07-28/reference-client/index.js';

const endpoint = 'http://fixture.invalid/mcp';

function modernBody(method: string, id: number | string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'colp-harness-probe', version: '0.0.0' },
      },
      ...params,
    },
  });
}

function postRequest(body: string, init: RequestInit = {}): Request {
  return new Request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    ...init,
  });
}
function modernPost(
  method: string,
  id: number | string,
  params: Record<string, unknown> = {},
  init: RequestInit = {},
): Request {
  return new Request(endpoint, {
    method: 'POST',
    body: modernBody(method, id, params),
    ...init,
    headers: {
      'content-type': 'application/json',
      'mcp-method': method,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(parsed).toBeDefined();
  return parsed;
}

describe('MCP 2026-07-28 reference harness contract (COLP-MCP-03)', () => {
  it('serves a modern POST JSON server/discover exchange on the fixture host', async () => {
    const host = createFixtureHost();
    try {
      const response = await host.fetch(modernPost('server/discover', 1));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/application\/json/u);

      const payload = await readJsonBody(response);
      expect(payload.jsonrpc).toBe('2.0');
      expect(payload.id).toBe(1);
      const result = payload.result as { supportedVersions?: readonly string[] };
      expect(result.supportedVersions).toContain('2026-07-28');

      const record = host.stats.requests[0];
      expect(record?.httpMethod).toBe('POST');
      expect(record?.method).toBe('server/discover');
      expect(record?.envelopeProtocolVersion).toBe('2026-07-28');
      expect(record?.responseStatus).toBe(200);
    } finally {
      await host.close();
    }
  });

  it('upgrades a subscriptions/listen POST to an SSE stream and delivers the ack', async () => {
    const host = createFixtureHost();
    const controller = new AbortController();
    try {
      const response = await host.fetch(
        modernPost('subscriptions/listen', 2, { notifications: {} }, {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/u);

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      const readUntilAck = async (): Promise<string> => {
        let text = '';
        for (;;) {
          const { done, value } = await reader!.read();
          if (done) return text;
          text += decoder.decode(value, { stream: true });
          if (text.includes('subscriptions/acknowledged')) return text;
        }
      };
      const frames = await withTimeout(readUntilAck(), 3000, 'SSE ack frame timed out');
      expect(frames).toContain('subscriptions/acknowledged');
      expect(frames).toContain('data:');

      const record = host.stats.requests[0];
      expect(record?.method).toBe('subscriptions/listen');
      expect(record?.responseContentType).toMatch(/text\/event-stream/u);
      controller.abort();
    } finally {
      controller.abort();
      await host.close();
    }
  });

  it.each([
    { label: 'GET', request: () => new Request(endpoint, { method: 'GET' }), status: 405 },
    { label: 'DELETE', request: () => new Request(endpoint, { method: 'DELETE' }), status: 405 },
  ])(
    'rejects the legacy $label HTTP verb with 405 (Legacy-negative) [evidence:mcp.legacy-semantics-rejected]',
    async ({ request, status }) => {
      const host = createFixtureHost();
      try {
        const response = await host.fetch(request());
        expect(response.status).toBe(status);
      } finally {
        await host.close();
      }
    },
  );

  it('rejects a legacy initialize POST without a modern envelope (Legacy-negative) [evidence:mcp.legacy-semantics-rejected]', async () => {
    const host = createFixtureHost();
    try {
      const response = await host.fetch(
        postRequest(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 10,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'legacy-client', version: '1.0.0' },
            },
          }),
        ),
      );
      expect(response.status).toBe(400);
      const payload = await readJsonBody(response);
      const error = payload.error as { code?: number; data?: { supported?: readonly string[] } };
      expect(error.code).toBe(-32022);
      expect(error.data?.supported).toContain('2026-07-28');
    } finally {
      await host.close();
    }
  });

  it('drops a legacy notifications/initialized POST with 202 (Legacy-negative)', async () => {
    const host = createFixtureHost();
    try {
      const response = await host.fetch(
        postRequest(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {},
          }),
        ),
      );
      expect(response.status).toBe(202);
      expect(await response.text()).toBe('');
    } finally {
      await host.close();
    }
  });

  it.each(['mcp-session-id', 'last-event-id'] as const)(
    'rejects the legacy %s header with unsupported_protocol_version (Legacy-negative) [evidence:mcp.legacy-semantics-rejected]',
    async (header) => {
      const host = createFixtureHost();
      try {
        const response = await host.fetch(
          new Request(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [header]: 'legacy-value' },
            body: modernBody('server/discover', 11),
          }),
        );
        expect(response.status).toBe(400);
        const payload = await readJsonBody(response);
        const error = payload.error as { code?: number; message?: string };
        expect(error.code).toBe(-32022);
        expect(error.message).toContain(header);
      } finally {
        await host.close();
      }
    },
  );

  it.each([
    'resources/subscribe',
    'resources/unsubscribe',
    'ping',
    'logging/setLevel',
    'initialize',
  ] as const)(
    'rejects the deleted legacy method %s with method-not-found (Legacy-negative) [evidence:mcp.legacy-semantics-rejected]',
    async (method) => {
      const host = createFixtureHost();
      try {
        const response = await host.fetch(modernPost(method, 12));
        expect(response.status).toBe(404);
        const payload = await readJsonBody(response);
        const error = payload.error as { code?: number };
        expect(error.code).toBe(-32601);
      } finally {
        await host.close();
      }
    },
  );

  it('injects faults and records aborted exchanges (fixture host abort topology)', async () => {
    const host = createFixtureHost();
    try {
      host.injectFault({ kind: 'fail', status: 503, body: '{"error":"injected"}' });
      const failed = await host.fetch(postRequest(modernBody('server/discover', 20)));
      expect(failed.status).toBe(503);
      expect(await failed.text()).toContain('injected');
      expect(host.stats.injectedFaults).toBe(1);

      host.injectFault({ kind: 'malformed-json' });
      const malformed = await host.fetch(postRequest(modernBody('server/discover', 21)));
      expect(malformed.status).toBe(200);
      expect(malformed.headers.get('content-type')).toMatch(/application\/json/u);
      await expect(malformed.json()).rejects.toThrow();

      host.injectFault({ kind: 'hold' });
      const controller = new AbortController();
      const held = host.fetch(
        modernPost('server/discover', 22, {}, { signal: controller.signal }),
      );
      controller.abort();
      await expect(held).rejects.toBeDefined();
      expect(host.stats.requests.at(-1)?.aborted).toBe(true);
      expect(host.stats.requests.at(-1)?.held).toBe(true);
    } finally {
      await host.close();
    }
  });

  it('enforces a bounded FIFO dispatch queue for backpressure', async () => {
    const host = createFixtureHost({ maxConcurrent: 1 });
    try {
      host.injectFault({ kind: 'delay', ms: 25 });
      host.injectFault({ kind: 'delay', ms: 25 });
      const responses = await Promise.all([
        host.fetch(modernPost('server/discover', 30)),
        host.fetch(modernPost('server/discover', 31)),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
      const [first, second] = host.stats.requests;
      expect(first?.completedAt).toBeLessThanOrEqual(second?.dispatchedAt ?? Number.POSITIVE_INFINITY);
      expect(second?.queued).toBe(true);
    } finally {
      await host.close();
    }
  });

  it('shuts down and restarts the fixture host', async () => {
    const host = createFixtureHost();
    try {
      const before = await host.fetch(modernPost('server/discover', 40));
      expect(before.status).toBe(200);

      await host.close();
      await expect(host.fetch(modernPost('server/discover', 41))).rejects.toThrow(
        /closed/u,
      );

      await host.restart();
      const after = await host.fetch(modernPost('server/discover', 42));
      expect(after.status).toBe(200);
      expect(host.stats.generation).toBeGreaterThanOrEqual(1);
    } finally {
      await host.close();
    }
  });

  it('completes a stateless server/discover smoke with the independent official client', async () => {
    const host = createFixtureHost();
    const client = createReferenceMcpClient({
      url: endpoint,
      fetchBridge: async (input, init) => host.fetch(new Request(input, init)),
    });
    try {
      await client.connect();
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

      const discover = client.getDiscoverResult();
      expect(discover).toBeDefined();
      expect(discover?.supportedVersions).toContain('2026-07-28');

      const probe = host.stats.requests.find((record) => record.method === 'server/discover');
      expect(probe?.envelopeProtocolVersion).toBe('2026-07-28');
      expect(probe?.headerMethod).toBe('server/discover');

      const explicit = await client.discover();
      expect(explicit.supportedVersions).toContain('2026-07-28');

      const read = await client.request(
        { method: 'resources/read', params: { uri: 'fixture://ping' } },
        undefined,
      );
      expect(read).toMatchObject({ contents: [{ uri: 'fixture://ping', text: 'pong' }] });
    } finally {
      await client.close();
      await host.close();
    }
  });

  it('opens and closes a subscriptions/listen SSE stream with the official client', async () => {
    const host = createFixtureHost();
    const client = createReferenceMcpClient({
      url: endpoint,
      fetchBridge: async (input, init) => host.fetch(new Request(input, init)),
    });
    try {
      await client.connect();
      const subscription = await withTimeout(
        client.listen({}),
        3000,
        'listen ack timed out',
      );
      expect(subscription.honoredFilter).toBeDefined();
      expect(typeof subscription.honoredFilter).toBe('object');

      const listenRecord = host.stats.requests.find(
        (record) => record.method === 'subscriptions/listen',
      );
      expect(listenRecord?.responseContentType).toMatch(/text\/event-stream/u);

      await subscription.close();
      await expect(subscription.closed).resolves.toBeDefined();
      expect(SUBSCRIPTION_ID_META_KEY.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await host.close();
    }
  });
});
