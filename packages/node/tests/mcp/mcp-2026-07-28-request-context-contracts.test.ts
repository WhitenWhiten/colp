/**
 * COLP-MCP-08: Modern MCP 2026-07-28 per-request context contracts.
 *
 * The adapter layer (`src/mcp/2026-07-28/request-context.ts`) maps wire facts
 * (HTTP headers + JSON body `_meta` envelope) into exactly one trusted
 * token-free `Mcp20260728RequestContext` that application/shared ports can
 * consume. This suite is a pure adapter unit suite: no real HTTP server, no
 * JSON-RPC engine — it feeds raw header fields and parsed body facts through
 * `createMcp20260728RequestContext` and asserts stable rejection semantics:
 *
 * - missing / duplicate / conflicting standard headers (`Mcp-Method`,
 *   `Mcp-Name`, `MCP-Protocol-Version`, `Mcp-Param-*`) -> -32020
 * - legacy session headers (`Mcp-Session-Id`, `Last-Event-ID`) -> -32022
 * - missing `_meta` envelope / `protocolVersion` field -> -32602 (upstream
 *   `_meta` contract; MCP-U-07); unsupported version value -> -32022;
 *   missing version header or header/body conflict -> -32020
 * - plain / encoded / sentinel `Mcp-Name` and `Mcp-Param-*` values
 * - header/body mismatch and illegal `x-mcp-header` schema names
 * - unknown extensions/capabilities stay inert; trace context is budgeted
 * - per-request log level opt-in (no opt-in -> no log notifications)
 * - -32020/-32021/-32022 stable wire codes, proxy/mutation rejection
 */
import { describe, expect, it } from 'vitest';

import { createAnonymousPublicBinding } from '../../src/mcp/shared/authorization.js';
import type { McpAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import type { McpResourceReadBudget } from '../../src/mcp/shared/resources.js';
import {
  MCP_WIRE_HEADER_MISMATCH_ERROR_CODE,
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
  MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
  Mcp20260728RequestError,
  createMcp20260728RequestContext,
  decodeMcp20260728ParamValue,
  encodeMcp20260728ParamValue,
  isMcp20260728Rfc9110Token,
  mayEmitMcp20260728LogNotification,
  needsMcp20260728Base64Encoding,
  parseMcp20260728RequestHeaders,
  requireMcp20260728ClientCapability,
  requireMcp20260728RequestContext,
  scanMcp20260728XMcpHeaderDeclarations,
  validateMcp20260728ParamHeaders,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
  type Mcp20260728XMcpHeaderDeclaration,
} from '../../src/mcp/2026-07-28/request-context.js';

const binding: McpAuthorizationBinding = createAnonymousPublicBinding({
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
});

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel';

function meta(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

function header(name: string, value: string): Mcp20260728HeaderField {
  return { name, value };
}

function contextInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Mcp20260728RequestContextInput {
  return {
    headers: [
      header('mcp-protocol-version', '2026-07-28'),
      header('mcp-method', 'server/discover'),
    ],
    httpMethod: 'POST',
    body: { method: 'server/discover', params: { _meta: meta() } },
    binding,
    ...overrides,
  } as Mcp20260728RequestContextInput;
}

function createContext(
  overrides: Readonly<Record<string, unknown>> = {},
): Mcp20260728RequestContext {
  return requireMcp20260728RequestContext(createMcp20260728RequestContext(contextInput(overrides)));
}

/**
 * An asymmetric matcher for one wire error. It is typed as the matcher the
 * assertion accepts rather than `unknown`: vitest's `toThrowError` parameter is
 * `string | RegExp | Error | Constructable`, so returning `unknown` does not
 * type-check.
 */
function expectWire(kind: 'header_mismatch' | 'unsupported_protocol_version' | 'invalid_params' | 'invalid_request' | 'missing_required_client_capability', code: number): Error {
  return expect.objectContaining({ kind, wireCode: code }) as unknown as Error;
}

describe('MCP 2026-07-28 request context: wire error codes', () => {
  it('pins the stable -32020/-32021/-32022 codes with the SDK and decision doc', () => {
    expect(MCP_WIRE_HEADER_MISMATCH_ERROR_CODE).toBe(-32020);
    expect(MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE).toBe(-32021);
    expect(MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE).toBe(-32022);
    expect(MCP_WIRE_INVALID_PARAMS_ERROR_CODE).toBe(-32602);
  });

  it('exposes kind/wireCode/data on the typed request error', () => {
    const error = new Mcp20260728RequestError('header_mismatch', 'boom', { mismatch: { header: 'mcp-method', body: 'x' } });
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('header_mismatch');
    expect(error.wireCode).toBe(-32020);
    expect(error.data).toEqual({ mismatch: { header: 'mcp-method', body: 'x' } });
  });
});

describe('MCP 2026-07-28 request context: header parsing [evidence:mcp.headers-contract]', () => {
  it('parses standard headers and Mcp-Param-* fields case-insensitively', () => {
    const parsed = parseMcp20260728RequestHeaders([
      header('MCP-Protocol-Version', '2026-07-28'),
      header('Mcp-Method', 'server/discover'),
      header('Mcp-Name', '=?base64?aGVsbG8=?='),
      header('Mcp-Param-X-Request-Id', 'abc'),
      header('content-type', 'application/json'),
    ]);
    expect(parsed.protocolVersion).toBe('2026-07-28');
    expect(parsed.method).toBe('server/discover');
    expect(parsed.name).toBe('=?base64?aGVsbG8=?=');
    expect(parsed.params.get('x-request-id')).toBe('abc');
  });

  it('rejects duplicate Mcp-Method / Mcp-Name headers as -32020', () => {
    expect(() => parseMcp20260728RequestHeaders([
      header('mcp-method', 'server/discover'),
      header('mcp-method', 'ping'),
    ])).toThrowError(expectWire('header_mismatch', -32020));
    expect(() => parseMcp20260728RequestHeaders([
      header('mcp-name', 'a'),
      header('Mcp-Name', 'b'),
    ])).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects conflicting MCP-Protocol-Version pairs as -32020', () => {
    expect(() => parseMcp20260728RequestHeaders([
      header('mcp-protocol-version', '2026-07-28'),
      header('mcp-protocol-version', '2025-11-25'),
    ])).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects duplicate Mcp-Param-* and empty suffixes as -32020', () => {
    expect(() => parseMcp20260728RequestHeaders([
      header('mcp-param-x-id', 'a'),
      header('Mcp-Param-X-ID', 'b'),
    ])).toThrowError(expectWire('header_mismatch', -32020));
    expect(() => parseMcp20260728RequestHeaders([header('mcp-param-', 'x')]))
      .toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects legacy Mcp-Session-Id and Last-Event-ID headers as -32022 [evidence:mcp.legacy-semantics-rejected]', () => {
    for (const name of ['mcp-session-id', 'last-event-id']) {
      expect(() => parseMcp20260728RequestHeaders([
        header('mcp-method', 'server/discover'),
        header(name, 's'),
      ])).toThrowError(expectWire('unsupported_protocol_version', -32022));
    }
  });

  it('enforces raw field, aggregate, and decoded sentinel budgets before normalization', () => {
    expect(() => parseMcp20260728RequestHeaders(
      [header('x-one', '1'), header('x-two', '2')],
      { maxFields: 1 },
    )).toThrowError(expectWire('header_mismatch', -32020));
    expect(() => parseMcp20260728RequestHeaders(
      [header('x', '12345')],
      { maxValueBytes: 4 },
    )).toThrowError(expectWire('header_mismatch', -32020));
    expect(() => parseMcp20260728RequestHeaders(
      [header('mcp-param-x', encodeMcp20260728ParamValue('12345'))],
      { maxDecodedValueBytes: 4 },
    )).toThrowError(expectWire('header_mismatch', -32020));
  });
});

describe('MCP 2026-07-28 request context: envelope version [evidence:mcp.request-context-meta]', () => {
  it('accepts a valid 2026-07-28 envelope and exposes protocol facts', () => {
    const context = createContext({
      headers: [header('mcp-method', 'server/discover'), header('mcp-protocol-version', '2026-07-28')],
    });
    expect(context.protocolVersion).toBe('2026-07-28');
    expect(context.clientCapabilities).toEqual({});
    expect(context.transportEvidence.httpMethod).toBe('POST');
  });

  it('rejects a missing _meta / protocolVersion key as -32602 with a repair hint (MCP-U-06/07)', () => {
    expect(() => createContext({ body: { method: 'server/discover', params: {} } }))
      .toThrowError(expectWire('invalid_params', -32602));
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: { [CLIENT_CAPABILITIES_META_KEY]: {} } } },
    })).toThrowError(expectWire('invalid_params', -32602));

    let caught: Mcp20260728RequestError | undefined;
    try {
      createContext({ body: { method: 'server/discover', params: {} } });
    } catch (error) {
      caught = error as Mcp20260728RequestError;
    }
    const data = caught?.data as {
      readonly expected?: { readonly params?: { readonly _meta?: Readonly<Record<string, unknown>> } };
      readonly requiredHeaders?: readonly string[];
    } | undefined;
    expect(data?.expected?.params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBe('2026-07-28');
    expect(data?.expected?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY]).toEqual({});
    expect(data?.requiredHeaders?.some((line) => line.startsWith('MCP-Protocol-Version: 2026-07-28'))).toBe(true);
  });

  it('rejects a non-2026-07-28 protocol version without a conflicting header as -32022', () => {
    expect(() => createContext({
      headers: [header('mcp-method', 'server/discover')],
      body: { method: 'server/discover', params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: '2025-11-25' }) } },
    })).toThrowError(expectWire('unsupported_protocol_version', -32022));
  });

  it('rejects a missing MCP-Protocol-Version header as -32020 (MCP-U-07)', () => {
    expect(() => createContext({
      headers: [header('mcp-method', 'server/discover')],
    })).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects an unsupported MCP-Protocol-Version header without a body conflict as -32022', () => {
    expect(() => createContext({
      headers: [
        header('mcp-method', 'server/discover'),
        header('mcp-protocol-version', '2025-11-25'),
      ],
      body: { method: 'server/discover', params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: '2025-11-25' }) } },
    })).toThrowError(expectWire('unsupported_protocol_version', -32022));
  });

  it('rejects a header/body protocol version conflict as -32020', () => {
    expect(() => createContext({
      headers: [header('mcp-method', 'server/discover'), header('mcp-protocol-version', '2026-07-28')],
      body: { method: 'server/discover', params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: '2025-11-25' }) } },
    })).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects a header/body conflict even when the header version is unsupported as -32020', () => {
    expect(() => createContext({
      headers: [
        header('mcp-method', 'server/discover'),
        header('mcp-protocol-version', '2025-11-25'),
      ],
      body: { method: 'server/discover', params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: '2026-07-28' }) } },
    })).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects a missing/non-object clientCapabilities as invalid params', () => {
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: undefined }) } },
    })).toThrowError(expectWire('invalid_params', -32602));
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: 'nope' }) } },
    })).toThrowError(expectWire('invalid_params', -32602));
  });

  it('rejects an invalid clientInfo shape as invalid params', () => {
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ [CLIENT_INFO_META_KEY]: { name: 42 } }) } },
    })).toThrowError(expectWire('invalid_params', -32602));
  });

  it('snapshots clientInfo name/version and strips foreign keys', () => {
    const context = createContext({
      body: {
        method: 'server/discover',
        params: { _meta: meta({ [CLIENT_INFO_META_KEY]: { name: 'probe', version: '1.0', extra: 'stripped' } }) },
      },
    });
    expect(context.clientInfo).toEqual({ name: 'probe', version: '1.0' });
  });
});

describe('MCP 2026-07-28 request context: Mcp-Method / Mcp-Name [evidence:mcp.headers-contract]', () => {
  it('rejects a missing Mcp-Method header as -32020', () => {
    expect(() => createContext({ headers: [header('mcp-protocol-version', '2026-07-28')] }))
      .toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects an Mcp-Method header disagreeing with the body as -32020', () => {
    expect(() => createContext({
      headers: [header('mcp-protocol-version', '2026-07-28'), header('mcp-method', 'ping')],
    }))
      .toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects a missing Mcp-Name header when the body names a tool as -32020', () => {
    expect(() => createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'tools/call'),
      ],
      body: { method: 'tools/call', params: { name: 'collections.get', _meta: meta() } },
    })).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('accepts a plain Mcp-Name header matching the body name', () => {
    const context = createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'tools/call'),
        header('mcp-name', 'collections.get'),
      ],
      body: { method: 'tools/call', params: { name: 'collections.get', _meta: meta() } },
    });
    expect(context.protocolVersion).toBe('2026-07-28');
  });

  it('decodes an encoded (sentinel) Mcp-Name header and matches the body', () => {
    const context = createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'prompts/get'),
        header('mcp-name', encodeMcp20260728ParamValue('名字')),
      ],
      body: { method: 'prompts/get', params: { name: '名字', _meta: meta() } },
    });
    expect(context.protocolVersion).toBe('2026-07-28');
  });

  it('rejects an invalid Base64 sentinel in Mcp-Name as -32020', () => {
    expect(() => createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'tools/call'),
        header('mcp-name', '=?base64?%%%?='),
      ],
      body: { method: 'tools/call', params: { name: 'collections.get', _meta: meta() } },
    })).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects an Mcp-Name header disagreeing with the body as -32020', () => {
    expect(() => createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'tools/call'),
        header('mcp-name', 'other.tool'),
      ],
      body: { method: 'tools/call', params: { name: 'collections.get', _meta: meta() } },
    })).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('mirrors resources/read via the uri field', () => {
    const context = createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'resources/read'),
        header('mcp-name', 'fixture://ping'),
      ],
      body: { method: 'resources/read', params: { uri: 'fixture://ping', _meta: meta() } },
    });
    expect(context.protocolVersion).toBe('2026-07-28');
  });
});

describe('MCP 2026-07-28 request context: Base64 sentinel codec', () => {
  it('keeps plain ASCII field values unchanged', () => {
    expect(needsMcp20260728Base64Encoding('plain-value')).toBe(false);
    expect(encodeMcp20260728ParamValue('plain-value')).toBe('plain-value');
  });

  it('wraps non-ASCII, whitespace-padded and sentinel-looking values', () => {
    expect(needsMcp20260728Base64Encoding('名字')).toBe(true);
    expect(needsMcp20260728Base64Encoding(' padded ')).toBe(true);
    expect(needsMcp20260728Base64Encoding('=?base64?x?=')).toBe(true);
    expect(encodeMcp20260728ParamValue('名字')).toBe('=?base64?5ZCN5a2X?=');
  });

  it('decodes plain values as-is and sentinel values to UTF-8', () => {
    expect(decodeMcp20260728ParamValue('plain')).toBe('plain');
    expect(decodeMcp20260728ParamValue('=?base64?5ZCN5a2X?=')).toBe('名字');
  });

  it('rejects invalid Base64 and invalid UTF-8 sentinel payloads', () => {
    expect(decodeMcp20260728ParamValue('=?base64?%%%?=')).toBeUndefined();
    expect(decodeMcp20260728ParamValue('=?base64?!!!!?=')).toBeUndefined();
  });

  it('enforces RFC 9110 token syntax for x-mcp-header names', () => {
    expect(isMcp20260728Rfc9110Token('X-Request-Id')).toBe(true);
    expect(isMcp20260728Rfc9110Token('')).toBe(false);
    expect(isMcp20260728Rfc9110Token('bad name')).toBe(false);
    expect(isMcp20260728Rfc9110Token('bad,name')).toBe(false);
  });
});

describe('MCP 2026-07-28 request context: x-mcp-header and Mcp-Param-* [evidence:mcp.headers-contract]', () => {
  const declarations: readonly Mcp20260728XMcpHeaderDeclaration[] = [
    { path: ['requestId'], headerName: 'X-Request-Id', type: 'string' },
    { path: ['retryCount'], headerName: 'X-Retry-Count', type: 'integer' },
  ];

  it('scans valid x-mcp-header declarations', () => {
    const scan = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: {
        requestId: { type: 'string', 'x-mcp-header': 'X-Request-Id' },
        retryCount: { type: 'integer', 'x-mcp-header': 'X-Retry-Count' },
        enabled: { type: 'boolean', 'x-mcp-header': 'X-Enabled' },
      },
    });
    expect(scan.valid).toBe(true);
    if (scan.valid) {
      expect(scan.declarations.map((d) => d.headerName)).toEqual([
        'X-Request-Id',
        'X-Retry-Count',
        'X-Enabled',
      ]);
    }
  });

  it('rejects number x-mcp-header declarations', () => {
    const scan = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: {
        rate: { type: 'number', 'x-mcp-header': 'X-Rate' },
      },
    });
    expect(scan.valid).toBe(false);
    if (!scan.valid) expect(scan.reason).toMatch(/primitive-typed/u);
  });

  it('rejects number declarations even when manually supplied to the param validator', () => {
    expect(() => validateMcp20260728ParamHeaders(
      [{ path: ['rate'], headerName: 'X-Rate', type: 'number' }],
      { rate: 1.5 },
      new Map([['x-rate', '1.5']]),
    )).toThrow(TypeError);
  });

  it('rejects illegal (non-token) or non-reachable x-mcp-header names', () => {
    const illegal = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: { requestId: { type: 'string', 'x-mcp-header': 'bad name' } },
    });
    expect(illegal.valid).toBe(false);
    const nonReachable = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: { nested: { type: 'object', properties: { value: { type: 'string' } } } },
      items: { type: 'string', 'x-mcp-header': 'X-Illegal' },
    });
    expect(nonReachable.valid).toBe(false);
  });

  it('rejects a missing Mcp-Param header when the body carries the value', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { requestId: 'abc', retryCount: 3 },
      new Map([['x-retry-count', '3']]),
    )).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('accepts matching plain and sentinel Mcp-Param values', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { requestId: 'abc', retryCount: 3 },
      new Map([
        ['x-request-id', 'abc'],
        ['x-retry-count', '3'],
      ]),
    )).not.toThrow();
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { requestId: '名字' },
      new Map([['x-request-id', encodeMcp20260728ParamValue('名字')]]),
    )).not.toThrow();
  });

  it('rejects an Mcp-Param header with invalid sentinel encoding', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { requestId: 'abc' },
      new Map([['x-request-id', '=?base64?%%%?=']]),
    )).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('rejects an Mcp-Param header that disagrees with the body', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { requestId: 'abc' },
      new Map([['x-request-id', 'different']]),
    )).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('compares integer declarations numerically', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { retryCount: 42 },
      new Map([['x-retry-count', '42.0']]),
    )).not.toThrow();
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { retryCount: 42 },
      new Map([['x-retry-count', '41']]),
    )).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('ignores a present Mcp-Param header when the body value is null/absent', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      { requestId: null },
      new Map([['x-request-id', 'abc']]),
    )).not.toThrow();
  });

  it('rejects an Mcp-Param header not declared by the schema', () => {
    expect(() => validateMcp20260728ParamHeaders(
      declarations,
      {},
      new Map([['x-undeclared', 'value']]),
    )).toThrowError(expectWire('header_mismatch', -32020));
  });

  it('validates tool declarations against the JSON-RPC params.arguments root', () => {
    expect(() => createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'tools/call'),
        header('mcp-name', 'fixture.tool'),
        header('mcp-param-x-request-id', 'abc'),
      ],
      body: {
        method: 'tools/call',
        params: { name: 'fixture.tool', arguments: { requestId: 'abc' }, _meta: meta() },
      },
      paramDeclarations: [{ path: ['requestId'], headerName: 'X-Request-Id', type: 'string' }],
    })).not.toThrow();

    expect(() => createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'tools/call'),
        header('mcp-name', 'fixture.tool'),
        header('mcp-param-x-request-id', 'abc'),
      ],
      body: {
        method: 'tools/call',
        params: { name: 'fixture.tool', requestId: 'abc', _meta: meta() },
      },
      paramDeclarations: [{ path: ['requestId'], headerName: 'X-Request-Id', type: 'string' }],
    })).toThrowError(expectWire('invalid_request', -32600));
  });
});

describe('MCP 2026-07-28 request context: capabilities and -32021', () => {
  it('requires a declared client capability and rejects a missing one with -32021', () => {
    const context = createContext({
      headers: [
        header('mcp-protocol-version', '2026-07-28'),
        header('mcp-method', 'subscriptions/listen'),
      ],
      body: { method: 'subscriptions/listen', params: { notifications: {}, _meta: meta() } },
    });
    expect(() => requireMcp20260728ClientCapability(context, ['resources', 'subscribe']))
      .toThrowError(expectWire('missing_required_client_capability', -32021));
  });

  it('passes when the capability is declared', () => {
    const context = createContext({
      body: {
        method: 'server/discover',
        params: { _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: { resources: { subscribe: true } } }) },
      },
    });
    expect(() => requireMcp20260728ClientCapability(context, ['resources', 'subscribe'])).not.toThrow();
  });

  it('keeps unknown capabilities inert (never in authorization)', () => {
    const context = createContext({
      body: {
        method: 'server/discover',
        params: { _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: { weird: { x: 1 } } }) },
      },
    });
    expect(context.clientCapabilities).toEqual({ weird: { x: 1 } });
    expect(context.authorization).toEqual({});
  });
});

describe('MCP 2026-07-28 request context: extensions and trace budgets', () => {
  it('carries unknown _meta extension keys inertly and freezes them', () => {
    const context = createContext({
      body: {
        method: 'server/discover',
        params: { _meta: meta({ 'vendor/extension': { flag: true } }) },
      },
    });
    expect(context.extensions).toEqual({ 'vendor/extension': { flag: true } });
    expect(Object.isFrozen(context.extensions)).toBe(true);
    expect(context.authorization).toEqual({});
  });

  it('rejects extension over-budget key counts', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) many[`ext/${i}`] = 1;
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta(many) } },
    })).toThrowError(expectWire('invalid_params', -32602));
  });

  it('accepts a valid W3C traceparent and rejects a malformed one', () => {
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }) } },
    })).not.toThrow();
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ traceparent: 'not-a-trace' }) } },
    })).toThrowError(expectWire('invalid_params', -32602));
  });

  it('rejects an over-budget tracestate', () => {
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ tracestate: `v=${'a'.repeat(6000)}` }) } },
    })).toThrowError(expectWire('invalid_params', -32602));
  });

  it('exposes a bounded trace context for tracing only', () => {
    const context = createContext({
      body: {
        method: 'server/discover',
        params: {
          _meta: meta({
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            baggage: 'userId=alice,serverRegion=us-east-1',
          }),
        },
      },
    });
    expect(context.trace?.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(context.trace?.baggage).toBe('userId=alice,serverRegion=us-east-1');
  });
});

describe('MCP 2026-07-28 request context: per-request log level', () => {
  it('never emits log notifications without an opt-in', () => {
    const context = createContext();
    expect(context.logLevel).toBeUndefined();
    expect(mayEmitMcp20260728LogNotification(context, 'error')).toBe(false);
  });

  it('emits only at or above the opted-in level', () => {
    const context = createContext({
      body: { method: 'server/discover', params: { _meta: meta({ [LOG_LEVEL_META_KEY]: 'warning' }) } },
    });
    expect(context.logLevel).toBe('warning');
    expect(mayEmitMcp20260728LogNotification(context, 'info')).toBe(false);
    expect(mayEmitMcp20260728LogNotification(context, 'warning')).toBe(true);
    expect(mayEmitMcp20260728LogNotification(context, 'error')).toBe(true);
  });

  it('rejects an unknown log level as invalid params', () => {
    expect(() => createContext({
      body: { method: 'server/discover', params: { _meta: meta({ [LOG_LEVEL_META_KEY]: 'loud' }) } },
    })).toThrowError(expectWire('invalid_params', -32602));
  });
});

describe('MCP 2026-07-28 request context: trusted boundary', () => {
  it('rejects Proxy/accessor host evidence and invalid budgets', () => {
    expect(() => createContext({ binding: new Proxy(binding, {}) })).toThrow(TypeError);
    expect(() => createContext({ budget: { maxNodes: -1 } as unknown as McpResourceReadBudget }))
      .toThrow(TypeError);
  });

  it('returns a deeply frozen context that re-validates', () => {
    const context = createContext();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.clientCapabilities)).toBe(true);
    expect(Object.isFrozen(context.extensions)).toBe(true);
    expect(() => {
      (context as { protocolVersion: string }).protocolVersion = '2025-11-25';
    }).toThrow(TypeError);
  });

  it('re-validates the trusted context shape on every call', () => {
    const context = createContext();
    expect(requireMcp20260728RequestContext(context).protocolVersion).toBe('2026-07-28');
    expect(() => requireMcp20260728RequestContext({ ...context, protocolVersion: '2025-11-25' }))
      .toThrowError(expectWire('unsupported_protocol_version', -32022));
  });
});
