import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  McpAuthorizationBindingError,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  encodeMcp20260728ParamValue,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContextInput,
  type Mcp20260728WireErrorKind,
} from '@know-n/colp/mcp';
import {
  Mcp20260728RequestError,
  PHASE4B_MCP_DISCOVERY_CAPABILITIES,
  PHASE4B_MCP_SERVER_INFO,
  PHASE4B_MCP_LEGACY_BODY_METHODS,
  createPhase4bMcpDiscoverResult,
  createPhase4bMcpResult,
  createPhase4bMcpRequestContext,
  mayEmitPhase4bMcpLogNotification,
  normalizePhase4bMcpError,
  requirePhase4bMcpClientCapability,
  scanPhase4bMcpParamHeaders,
  validatePhase4bMcpDiscoverRequest,
} from '../../../src/modules/mcp/index.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';

const ANONYMOUS_BINDING = createAnonymousPublicBinding({
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

const AUTHENTICATED_BINDING = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-binding-id',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

const VALID_PARAM_SCHEMA = {
  type: 'object',
  properties: {
    collectionId: {
      type: 'string',
      'x-mcp-header': 'X-Collection-Id',
    },
  },
  required: ['collectionId'],
  additionalProperties: false,
} as const;

function meta(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    ...overrides,
  };
}

function toolBody(
  overrides: Readonly<Record<string, unknown>> = {},
): Mcp20260728RequestContextInput['body'] {
  return {
    method: 'tools/call',
    params: {
      _meta: meta(),
      name: 'collections.get',
      arguments: { collectionId: 'collection-1' },
      ...overrides,
    },
  };
}

function contextInput(
  overrides: Partial<Mcp20260728RequestContextInput> = {},
): Mcp20260728RequestContextInput {
  return {
    headers: [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Name', value: 'collections.get' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
    httpMethod: 'POST',
    body: toolBody(),
    binding: ANONYMOUS_BINDING,
    scope: ['mcp:read:public'],
    authorization: {},
    ...overrides,
  };
}

function expectRequestError(
  action: () => unknown,
  kind: Mcp20260728WireErrorKind,
  wireCode: number,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Mcp20260728RequestError);
    const requestError = error as Mcp20260728RequestError;
    assert.equal(requestError.kind, kind);
    assert.equal(requestError.wireCode, wireCode);
    return true;
  });
}

test('concurrent calls produce distinct frozen contexts and never retain protocol state', async () => {
  const contexts = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      await Promise.resolve();
      return createPhase4bMcpRequestContext(contextInput({
        authorization: { requestIndex: index },
      }));
    }),
  );

  assert.equal(contexts.length, 24);
  for (const [index, context] of contexts.entries()) {
    assert.equal(context.binding.kind, 'anonymous');
    assert.equal(
      (context.authorization as Readonly<Record<string, number>>).requestIndex,
      index,
    );
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.binding));
    assert.ok(Object.isFrozen(context.scope));
    assert.ok(Object.isFrozen(context.clientCapabilities));
    assert.ok(Object.isFrozen(context.extensions));
  }
  assert.notStrictEqual(contexts[0], contexts[1]);
  assert.notStrictEqual(contexts[0].binding, contexts[1].binding);
  assert.notStrictEqual(contexts[0].authorization, contexts[1].authorization);
});

test('missing _meta/version fails with -32602, unsupported version value with -32022, missing header with -32020', () => {
  const headers: readonly Mcp20260728HeaderField[] = [
    { name: 'Mcp-Method', value: 'tools/call' },
    { name: 'Mcp-Name', value: 'collections.get' },
    { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
  ];

  // Missing `_meta` envelope / missing protocolVersion field: upstream
  // Invalid Params (-32602), MCP-U-07 (2026-08-27 MCP usability audit).
  const missingEnvelope: readonly Mcp20260728RequestContextInput['body'][] = [
    {
      method: 'tools/call',
      params: {
        name: 'collections.get',
        arguments: { collectionId: 'collection-1' },
      },
    },
    toolBody({
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    }),
  ];
  for (const body of missingEnvelope) {
    expectRequestError(
      () => createPhase4bMcpRequestContext(contextInput({ body, headers })),
      'invalid_params',
      -32602,
    );
  }

  // A string version value the server does not support stays -32022.
  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2025-11-25',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }),
      headers,
    })),
    'unsupported_protocol_version',
    -32022,
  );

  // A valid body envelope without the MCP-Protocol-Version header is a
  // header fault (-32020).
  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({ headers })),
    'header_mismatch',
    -32020,
  );
});

test('duplicate or conflicting MCP fields fail with -32020', () => {
  const missingHeaders: readonly (readonly Mcp20260728HeaderField[])[] = [
    [{ name: 'MCP-Protocol-Version', value: '2026-07-28' }],
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Name', value: 'collections.get' },
    ],
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
    ],
  ];
  for (const headers of missingHeaders) {
    expectRequestError(
      () => createPhase4bMcpRequestContext(contextInput({ headers })),
      'header_mismatch',
      -32020,
    );
  }

  const duplicates: readonly (readonly Mcp20260728HeaderField[])[] = [
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
    ],
    [
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Method', value: 'tools/call' },
    ],
    [
      { name: 'Mcp-Name', value: 'collections.get' },
      { name: 'Mcp-Name', value: 'collections.get' },
    ],
    [
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
  ];

  for (const headers of duplicates) {
    expectRequestError(
      () => createPhase4bMcpRequestContext(contextInput({ headers })),
      'header_mismatch',
      -32020,
    );
  }

  const conflicts: readonly (readonly Mcp20260728HeaderField[])[] = [
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Name', value: 'collections.get' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/list' },
      { name: 'Mcp-Name', value: 'collections.get' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Name', value: 'collections.other' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
    [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Name', value: 'collections.get' },
      { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
    ],
  ];

  for (const headers of conflicts.slice(0, 4)) {
    expectRequestError(
      () => createPhase4bMcpRequestContext(contextInput({ headers })),
      'header_mismatch',
      -32020,
    );
  }

  const versionConflictBody = toolBody({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2025-11-25',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  });
  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      headers: conflicts[4],
      body: versionConflictBody,
    })),
    'header_mismatch',
    -32020,
  );
});

test('invalid _meta client info and capability shapes fail closed with -32602', () => {
  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          'io.modelcontextprotocol/clientInfo': { name: 42 },
        }),
      }),
    })),
    'invalid_params',
    -32602,
  );

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          'io.modelcontextprotocol/clientCapabilities': [],
        }),
      }),
    })),
    'invalid_params',
    -32602,
  );
});

test('plain, encoded, and sentinel MCP header values are accepted after exact decode', () => {
  const scan = scanPhase4bMcpParamHeaders(VALID_PARAM_SCHEMA);
  if (!scan.valid) throw new Error('expected valid x-mcp-header schema');

  const plain = createPhase4bMcpRequestContext(contextInput({
    paramDeclarations: scan.declarations,
  }));
  assert.ok(plain);

  const encodedName = encodeMcp20260728ParamValue('collections.get 公共');
  const encodedParam = encodeMcp20260728ParamValue('collection-1 公共');
  const encoded = createPhase4bMcpRequestContext(contextInput({
    headers: [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Name', value: encodedName },
      { name: 'Mcp-Param-X-Collection-Id', value: encodedParam },
    ],
    body: toolBody({
      name: 'collections.get 公共',
      arguments: { collectionId: 'collection-1 公共' },
    }),
    paramDeclarations: scan.declarations,
  }));
  assert.ok(encoded);

  const sentinel = createPhase4bMcpRequestContext(contextInput({
    headers: [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Name', value: '=?base64?Y29sbGVjdGlvbnMuZ2V0?=' },
      { name: 'Mcp-Param-X-Collection-Id', value: '=?base64?Y29sbGVjdGlvbi0x?=' },
    ],
    paramDeclarations: scan.declarations,
  }));
  assert.ok(sentinel);
});

test('invalid Base64 and UTF-8 sentinels fail with -32020', () => {
  const scan = scanPhase4bMcpParamHeaders(VALID_PARAM_SCHEMA);
  if (!scan.valid) throw new Error('expected valid x-mcp-header schema');

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      headers: [
        { name: 'MCP-Protocol-Version', value: '2026-07-28' },
        { name: 'Mcp-Method', value: 'tools/call' },
        { name: 'Mcp-Name', value: '=?base64?***?=' },
        { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
      ],
    })),
    'header_mismatch',
    -32020,
  );

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      headers: [
        { name: 'MCP-Protocol-Version', value: '2026-07-28' },
        { name: 'Mcp-Method', value: 'tools/call' },
        { name: 'Mcp-Name', value: 'collections.get' },
        { name: 'Mcp-Param-X-Collection-Id', value: '=?base64?***?=' },
      ],
      paramDeclarations: scan.declarations,
    })),
    'header_mismatch',
    -32020,
  );

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      headers: [
        { name: 'MCP-Protocol-Version', value: '2026-07-28' },
        { name: 'Mcp-Method', value: 'tools/call' },
        { name: 'Mcp-Name', value: '=?base64?/w==?=' },
        { name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' },
      ],
    })),
    'header_mismatch',
    -32020,
  );
});

test('invalid x-mcp-header declarations fail closed', () => {
  const cases: readonly { readonly schema: unknown; readonly reason: RegExp }[] = [
    {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-mcp-header': 'Bad Header' },
        },
      },
      reason: /RFC 9110 token/u,
    },
    {
      schema: {
        type: 'object',
        properties: {
          nested: { type: 'object', 'x-mcp-header': 'X-Object' },
        },
      },
      reason: /primitive-typed/u,
    },
    {
      schema: {
        type: 'object',
        properties: {
          nested: {
            type: 'array',
            items: { type: 'string', 'x-mcp-header': 'X-Nested' },
          },
        },
      },
      reason: /only permitted on properties/u,
    },
    {
      schema: {
        type: 'object',
        properties: {
          a: { type: 'string', 'x-mcp-header': 'X-Trace' },
          b: { type: 'string', 'x-mcp-header': 'x-trace' },
        },
      },
      reason: /case-insensitively unique/u,
    },
  ];

  for (const { schema, reason } of cases) {
    const result = scanPhase4bMcpParamHeaders(schema);
    if (result.valid) throw new Error('expected invalid x-mcp-header schema');
    assert.match(result.reason, reason);
  }

  const valid = scanPhase4bMcpParamHeaders(VALID_PARAM_SCHEMA);
  if (!valid.valid) throw new Error('expected valid x-mcp-header schema');
  assert.deepEqual(valid.declarations, [
    { path: ['collectionId'], headerName: 'X-Collection-Id', type: 'string' },
  ]);
});

test('client capability snapshots are frozen and missing required capability maps to -32021', () => {
  const capabilities: Record<string, Record<string, boolean>> = {
    tools: { call: true },
  };
  const context = createPhase4bMcpRequestContext(contextInput({
    body: toolBody({
      _meta: meta({
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      }),
    }),
  }));

  capabilities.tools.call = false;
  capabilities.tools.extra = true;
  const tools = (context.clientCapabilities as { readonly tools?: { readonly call?: boolean } }).tools;
  assert.equal(tools?.call, true);
  assert.equal('extra' in (tools ?? {}), false);
  assert.ok(Object.isFrozen(context.clientCapabilities));
  requirePhase4bMcpClientCapability(context, ['tools', 'call']);

  const empty = createPhase4bMcpRequestContext(contextInput());
  expectRequestError(
    () => requirePhase4bMcpClientCapability(empty, ['tools', 'call']),
    'missing_required_client_capability',
    -32021,
  );
});

test('extension and trace budgets fail closed with -32602', () => {
  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          'x-vendor-a': true,
          'x-vendor-b': true,
        }),
      }),
      extensionBudget: { maxKeys: 1 },
    })),
    'invalid_params',
    -32602,
  );

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          'x-vendor-tool-extension': true,
        }),
      }),
      extensionBudget: { maxKeyBytes: 8 },
    })),
    'invalid_params',
    -32602,
  );

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          'x-vendor-value': '12345678',
        }),
      }),
      extensionBudget: { maxValueBytes: 4 },
    })),
    'invalid_params',
    -32602,
  );

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          tracestate: 'k=1234567890',
        }),
      }),
      traceBudget: { maxValueBytes: 4 },
    })),
    'invalid_params',
    -32602,
  );
});

test('log notifications require an exact _meta opt-in at or above severity', () => {
  const none = createPhase4bMcpRequestContext(contextInput());
  assert.equal(mayEmitPhase4bMcpLogNotification(none, 'error'), false);

  const error = createPhase4bMcpRequestContext(contextInput({
    body: toolBody({
      _meta: meta({
        'io.modelcontextprotocol/logLevel': 'error',
      }),
    }),
  }));
  assert.equal(mayEmitPhase4bMcpLogNotification(error, 'error'), true);
  assert.equal(mayEmitPhase4bMcpLogNotification(error, 'critical'), true);
  assert.equal(mayEmitPhase4bMcpLogNotification(error, 'warning'), false);

  expectRequestError(
    () => createPhase4bMcpRequestContext(contextInput({
      body: toolBody({
        _meta: meta({
          'io.modelcontextprotocol/logLevel': 'verbose',
        }),
      }),
    })),
    'invalid_params',
    -32602,
  );
});

test('scope is per-call frozen and revocation/security epoch mismatch rejects the request', () => {
  const scope = ['mcp:read:public'];
  const input = contextInput({ scope });
  const context = createPhase4bMcpRequestContext(input);
  scope.push('mcp:read:own');
  assert.deepEqual(context.scope, ['mcp:read:public']);
  assert.ok(Object.isFrozen(context.scope));

  const next = createPhase4bMcpRequestContext(contextInput({
    scope: ['mcp:read:own'],
  }));
  assert.deepEqual(next.scope, ['mcp:read:own']);
  assert.notStrictEqual(context, next);

  // Revocation is represented by a stale security epoch; the host must fail closed.
  const ok = createPhase4bMcpRequestContext(contextInput(), {
    expectedResourceAudience: AUDIENCE,
    expectedSecurityEpoch: 'epoch-1',
  });
  assert.equal(ok.binding.securityEpoch, 'epoch-1');

  assert.throws(
    () => createPhase4bMcpRequestContext(contextInput(), {
      expectedResourceAudience: 'https://other.example.test/collections/-/mcp',
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpAuthorizationBindingError);
      assert.equal((error as McpAuthorizationBindingError).code, 'resource_audience_mismatch');
      return true;
    },
  );

  assert.throws(
    () => createPhase4bMcpRequestContext(contextInput(), {
      expectedSecurityEpoch: 'epoch-2',
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpAuthorizationBindingError);
      assert.equal((error as McpAuthorizationBindingError).code, 'security_epoch_mismatch');
      return true;
    },
  );
});

test('error normalization keeps exact reserved wire codes and hides internal errors', () => {
  const cases: readonly { readonly kind: Mcp20260728WireErrorKind; readonly code: number }[] = [
    { kind: 'header_mismatch', code: -32020 },
    { kind: 'missing_required_client_capability', code: -32021 },
    { kind: 'unsupported_protocol_version', code: -32022 },
  ];
  for (const { kind, code } of cases) {
    const normalized = normalizePhase4bMcpError(new Mcp20260728RequestError(kind, `${kind} message`));
    assert.equal(normalized.code, code);
    assert.equal(normalized.message, `${kind} message`);
  }

  const internal = normalizePhase4bMcpError(new Error('database secret'));
  assert.equal(internal.code, -32603);
  assert.doesNotMatch(internal.message, /database secret/u);
});

test('anonymous and authenticated discovery return the same fixed stateless result', () => {
  const anonymousContext = createPhase4bMcpRequestContext(contextInput({
    binding: ANONYMOUS_BINDING,
  }));
  const authenticatedContext = createPhase4bMcpRequestContext(contextInput({
    binding: AUTHENTICATED_BINDING,
  }));
  assert.equal(anonymousContext.binding.kind, 'anonymous');
  assert.equal(authenticatedContext.binding.kind, 'authenticated');

  const anonymous = createPhase4bMcpDiscoverResult();
  const authenticated = createPhase4bMcpDiscoverResult();
  assert.deepEqual(anonymous, authenticated);
  assert.deepEqual(anonymous.supportedVersions, ['2026-07-28']);
  assert.deepEqual(anonymous.capabilities, {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
  });
  assert.deepEqual(anonymous._meta?.['io.modelcontextprotocol/serverInfo'], PHASE4B_MCP_SERVER_INFO);
  assert.notStrictEqual(anonymous, authenticated);
  assert.notStrictEqual(anonymous.supportedVersions, authenticated.supportedVersions);
  assert.notStrictEqual(anonymous.capabilities, authenticated.capabilities);
  assert.notStrictEqual(anonymous._meta, authenticated._meta);
  assert.notStrictEqual(
    anonymous._meta?.['io.modelcontextprotocol/serverInfo'],
    authenticated._meta?.['io.modelcontextprotocol/serverInfo'],
  );
});

test('discovery only declares the mounted 2026-07-28 candidate and validates requests', () => {
  const result = createPhase4bMcpDiscoverResult();
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.supportedVersions));
  assert.ok(Object.isFrozen(result.capabilities));
  assert.ok(Object.isFrozen(result._meta));
  assert.ok(Object.isFrozen(result._meta?.['io.modelcontextprotocol/serverInfo']));
  assert.deepEqual(result.capabilities, PHASE4B_MCP_DISCOVERY_CAPABILITIES);
  assert.deepEqual(result._meta?.['io.modelcontextprotocol/serverInfo'], PHASE4B_MCP_SERVER_INFO);
  assert.deepEqual(validatePhase4bMcpDiscoverRequest({ method: 'server/discover' }), { ok: true });

  const invalid = validatePhase4bMcpDiscoverRequest({ method: 42 });
  assert.equal(invalid.ok, false);
  assert.equal(typeof invalid.issue, 'string');

  const first = createPhase4bMcpDiscoverResult();
  const second = createPhase4bMcpDiscoverResult();
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, second);
});

test('results always attach the fixed Phase 4B server info and normalize errors', () => {
  const result = createPhase4bMcpResult({
    method: 'server/discover',
    fields: { capabilities: {} },
  });
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result._meta?.['io.modelcontextprotocol/serverInfo'], PHASE4B_MCP_SERVER_INFO);
  assert.ok(Object.isFrozen(result));

  const overridden = createPhase4bMcpResult({
    method: 'tools/call',
    serverInfo: {
      name: 'request-derived-name',
      version: '9.9.9',
    },
    fields: { content: [] },
  });
  assert.deepEqual(overridden._meta?.['io.modelcontextprotocol/serverInfo'], PHASE4B_MCP_SERVER_INFO);

  const normalized = normalizePhase4bMcpError(
    new Mcp20260728RequestError('unsupported_protocol_version', 'legacy method'),
  );
  assert.equal(normalized.code, -32022);
  assert.equal(normalized.message, 'legacy method');
});

test('legacy initialize, initialized, Session, and Last-Event-ID fail as unsupported protocol version', () => {
  for (const method of PHASE4B_MCP_LEGACY_BODY_METHODS) {
    expectRequestError(
      () => createPhase4bMcpRequestContext(contextInput({
        headers: [{ name: 'Mcp-Method', value: method }],
        body: {
          method,
          params: { _meta: meta() },
        },
      })),
      'unsupported_protocol_version',
      -32022,
    );
  }

  for (const legacyHeader of ['Mcp-Session-Id', 'Last-Event-ID'] as const) {
    expectRequestError(
      () => createPhase4bMcpRequestContext(contextInput({
        headers: [
          { name: 'Mcp-Method', value: 'tools/call' },
          { name: legacyHeader, value: 'legacy-session' },
        ],
      })),
      'unsupported_protocol_version',
      -32022,
    );
  }
});

test('contexts are fresh snapshots and never retain a raw token or earlier request facts', () => {
  const authorization: Record<string, string> = { requestId: 'req-1' };
  const input = contextInput({
    authorization,
    body: toolBody({
      _meta: meta({
        'io.modelcontextprotocol/clientInfo': {
          name: 'client-a',
          version: '1.0.0',
        },
      }),
    }),
  });
  const first = createPhase4bMcpRequestContext(input);
  assert.equal(first.authorization.requestId, 'req-1');
  assert.equal(first.clientInfo?.name, 'client-a');

  const metaRecord = input.body.params?._meta as Record<string, unknown>;
  metaRecord['io.modelcontextprotocol/clientInfo'] = {
    name: 'client-b',
    version: '2.0.0',
  };
  authorization.requestId = 'req-2';

  const second = createPhase4bMcpRequestContext(input);
  assert.equal(second.authorization.requestId, 'req-2');
  assert.equal(second.clientInfo?.name, 'client-b');
  assert.equal(first.authorization.requestId, 'req-1');
  assert.equal(first.clientInfo?.name, 'client-a');
  assert.notStrictEqual(first, second);

  assert.equal('rawToken' in first.authorization, false);
  assert.doesNotMatch(JSON.stringify(first), /Bearer |sk-|eyJ/u);
});
