/**
 * COLP-MCP-08: Modern MCP 2026-07-28 discovery, result and error contracts.
 *
 * Covers the adapter modules `src/mcp/2026-07-28/discovery.ts` and
 * `src/mcp/2026-07-28/results.ts`:
 *
 * - `server/discover` advertises exactly `2026-07-28` and the host-provided
 *   real capabilities; serverInfo is stamped; the result is deeply frozen and
 *   validates against the pinned `DiscoverResultSchema`.
 * - Modern results always carry `resultType` and, for cacheable operations,
 *   `ttlMs` / `cacheScope`; `input_required` is confined to the methods whose
 *   spec vocabulary allows it.
 * - Errors normalize to the stable `-32020/-32021/-32022` wire codes, and
 *   unknown upstream errors collapse to a low-sensitivity `-32603`.
 * - A discover smoke cross-checks the adapter result against the real SDK
 *   server over the test-only fixture host.
 */
import { describe, expect, it } from 'vitest';

import { DiscoverResultSchema } from '@modelcontextprotocol/core';

import {
  MCP_WIRE_HEADER_MISMATCH_ERROR_CODE,
  MCP_WIRE_INTERNAL_ERROR_CODE,
  MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
  MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
  Mcp20260728RequestError,
} from '../../src/mcp/2026-07-28/request-context.js';
import {
  createMcp20260728DiscoverResult,
  validateMcp20260728DiscoverRequest,
} from '../../src/mcp/2026-07-28/discovery.js';
import {
  createMcp20260728Result,
  normalizeMcp20260728Error,
  type Mcp20260728Result,
} from '../../src/mcp/2026-07-28/results.js';
import { createFixtureHost } from '../fixtures/mcp-2026-07-28/fixture-host/index.js';

const endpoint = 'http://fixture.invalid/mcp';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const serverInfo = Object.freeze({ name: 'colp-test-server', version: '0.0.0' });
const capabilities = Object.freeze({
  resources: Object.freeze({ subscribe: false, listChanged: false }),
});

describe('MCP 2026-07-28 discovery contracts [evidence:mcp.discovery-contract]', () => {
  it('advertises exactly the pinned protocol version and real capabilities', () => {
    const result = createMcp20260728DiscoverResult({
      serverInfo,
      capabilities,
      instructions: 'COLP test server',
    });
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual(['2026-07-28']);
    expect(result.capabilities).toEqual(capabilities);
    expect(result.instructions).toBe('COLP test server');
    expect(result._meta?.[SERVER_INFO_META_KEY]).toEqual(serverInfo);
    expect(DiscoverResultSchema.safeParse(result).success).toBe(true);
  });

  it('pinned SDK schema preserves resultType on discover results', () => {
    const parsed = DiscoverResultSchema.safeParse({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { resultType?: string }).resultType).toBe('complete');
    }
  });

  it('stamps serverInfo into result _meta and deep-freezes the snapshot', () => {
    const result = createMcp20260728DiscoverResult({ serverInfo, capabilities });
    expect(result._meta?.[SERVER_INFO_META_KEY]).toEqual(serverInfo);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result._meta)).toBe(true);
    expect(() => {
      (result as { supportedVersions: readonly string[] }).supportedVersions = ['2025-11-25'];
    }).toThrow(TypeError);
  });

  it('rejects invalid serverInfo and non-object capabilities', () => {
    expect(() => createMcp20260728DiscoverResult({ serverInfo: { name: 42 } as never, capabilities }))
      .toThrow(TypeError);
    expect(() => createMcp20260728DiscoverResult({ serverInfo, capabilities: null as never }))
      .toThrow(TypeError);
  });

  it('validates a server/discover request against the pinned schema', () => {
    expect(validateMcp20260728DiscoverRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
    }).ok).toBe(true);
    expect(validateMcp20260728DiscoverRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    }).ok).toBe(false);
  });

  it('discover smoke: adapter result matches the SDK server contract over the fixture host', async () => {
    const host = createFixtureHost();
    try {
      const response = await host.fetch(new Request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-method': 'server/discover' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      }));
      const payload = JSON.parse(await response.text()) as { result?: { supportedVersions?: readonly string[]; capabilities?: Record<string, unknown> } };
      expect(payload.result?.supportedVersions).toContain('2026-07-28');
      const adapterResult = createMcp20260728DiscoverResult({
        serverInfo,
        capabilities: payload.result?.capabilities ?? {},
      });
      expect(adapterResult.supportedVersions).toEqual(['2026-07-28']);
      expect(DiscoverResultSchema.safeParse(adapterResult).success).toBe(true);
    } finally {
      await host.close();
    }
  });
});

describe('MCP 2026-07-28 result contracts [evidence:mcp.result-contract]', () => {
  it('stamps resultType complete by default', () => {
    const result = createMcp20260728Result({
      method: 'server/discover',
      serverInfo,
      fields: { supportedVersions: ['2026-07-28'] },
    });
    expect(result.resultType).toBe('complete');
  });

  it('confines input_required to the extended result-type methods', () => {
    for (const method of ['tools/call', 'prompts/get', 'resources/read']) {
      const result = createMcp20260728Result({ method, resultType: 'input_required', fields: {} });
      expect(result.resultType).toBe('input_required');
    }
    expect(() => createMcp20260728Result({ method: 'server/discover', resultType: 'input_required' }))
      .toThrow(TypeError);
  });

  it('stamps ttlMs/cacheScope defaults on cacheable results', () => {
    const result = createMcp20260728Result({ method: 'resources/read', fields: { contents: [] } });
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
  });

  it('honors explicit cache metadata on cacheable results', () => {
    const result = createMcp20260728Result({
      method: 'resources/list',
      cache: { ttlMs: 60_000, cacheScope: 'public' },
      fields: { resources: [] },
    });
    expect(result.ttlMs).toBe(60_000);
    expect(result.cacheScope).toBe('public');
  });

  it('rejects invalid ttlMs and cacheScope', () => {
    expect(() => createMcp20260728Result({
      method: 'resources/read',
      cache: { ttlMs: -1, cacheScope: 'private' },
    })).toThrow(TypeError);
    expect(() => createMcp20260728Result({
      method: 'resources/read',
      cache: { ttlMs: 1.5, cacheScope: 'private' },
    })).toThrow(TypeError);
    expect(() => createMcp20260728Result({
      method: 'resources/read',
      cache: { ttlMs: 0, cacheScope: 'shared' as never },
    })).toThrow(TypeError);
  });

  it('does not stamp cache fields on non-cacheable results', () => {
    const result = createMcp20260728Result({
      method: 'tools/call',
      cache: { ttlMs: 10, cacheScope: 'public' },
      fields: { structuredContent: { ok: true } },
    });
    expect(result.ttlMs).toBeUndefined();
    expect(result.cacheScope).toBeUndefined();
  });

  it('stamps serverInfo into result _meta', () => {
    const result = createMcp20260728Result({ method: 'ping', serverInfo, fields: {} });
    expect(result._meta?.[SERVER_INFO_META_KEY]).toEqual(serverInfo);
  });

  it('deep-freezes results so mutation after call cannot leak', () => {
    const result = createMcp20260728Result({
      method: 'resources/read',
      cache: { ttlMs: 5, cacheScope: 'public' },
      serverInfo,
      fields: { contents: [{ uri: 'fixture://ping', text: 'pong' }] },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.contents)).toBe(true);
    expect(Object.isFrozen(result._meta)).toBe(true);
    expect(() => {
      (result as unknown as { resultType: string }).resultType = 'input_required';
    }).toThrow(TypeError);
  });

  it('rejects Proxy and accessor result inputs', () => {
    const proxy = new Proxy({ ok: true }, {});
    expect(() => createMcp20260728Result({ method: 'tools/call', fields: proxy as never }))
      .toThrow(TypeError);
  });

  it('rejects adapter-owned keys smuggled through fields', () => {
    expect(() => createMcp20260728Result({ method: 'ping', fields: { resultType: 'input_required' } }))
      .toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', fields: { ttlMs: 5 } }))
      .toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'ping', fields: { _meta: {} } }))
      .toThrow(TypeError);
  });

  it('returns an exact resultType union at runtime', () => {
    const result: Mcp20260728Result = createMcp20260728Result({ method: 'ping' });
    expect(['complete', 'input_required']).toContain(result.resultType);
  });
});

describe('MCP 2026-07-28 error normalization', () => {
  it('normalizes typed adapter errors to their stable wire codes', () => {
    const error = new Mcp20260728RequestError('header_mismatch', 'headers disagree');
    expect(normalizeMcp20260728Error(error)).toEqual({
      code: -32020,
      message: 'headers disagree',
    });
    expect(normalizeMcp20260728Error(
      new Mcp20260728RequestError('missing_required_client_capability', 'cap', { requiredCapabilities: { resources: {} } }),
    )).toEqual({
      code: -32021,
      message: 'cap',
      data: { requiredCapabilities: { resources: {} } },
    });
    expect(normalizeMcp20260728Error(
      new Mcp20260728RequestError('unsupported_protocol_version', 'version', { supported: ['2026-07-28'], requested: '2025-11-25' }),
    )).toEqual({
      code: -32022,
      message: 'version',
      data: { supported: ['2026-07-28'], requested: '2025-11-25' },
    });
  });

  it('normalizes upstream SDK-shaped errors without importing SDK types', () => {
    const sdkShaped = {
      code: MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
      message: 'Unsupported protocol version: 2025-11-25',
      data: { supported: ['2026-07-28'], requested: '2025-11-25' },
    };
    expect(normalizeMcp20260728Error(sdkShaped)).toEqual(sdkShaped);
    const headerShaped = { code: MCP_WIRE_HEADER_MISMATCH_ERROR_CODE, message: 'mismatch' };
    expect(normalizeMcp20260728Error(headerShaped)).toEqual(headerShaped);
  });

  it('collapses unknown errors to a low-sensitivity -32603', () => {
    expect(normalizeMcp20260728Error(new Error('leak me: secret'))).toEqual({
      code: MCP_WIRE_INTERNAL_ERROR_CODE,
      message: 'Internal error',
    });
    expect(normalizeMcp20260728Error('not-an-error')).toEqual({
      code: MCP_WIRE_INTERNAL_ERROR_CODE,
      message: 'Internal error',
    });
    expect(normalizeMcp20260728Error(undefined)).toEqual({
      code: MCP_WIRE_INTERNAL_ERROR_CODE,
      message: 'Internal error',
    });
  });

  it('keeps -32021 stable through normalization', () => {
    expect(MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE).toBe(-32021);
    const normalized = normalizeMcp20260728Error(
      new Mcp20260728RequestError('missing_required_client_capability', 'capability'),
    );
    expect(normalized.code).toBe(-32021);
  });
});

