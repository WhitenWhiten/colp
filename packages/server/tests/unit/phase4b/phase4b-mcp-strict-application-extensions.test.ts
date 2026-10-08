import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  McpOauthVerificationError,
  PHASE4B_MCP_READ_TOOL_CATALOG,
  type McpApplicationFacade,
  type McpOauthVerifier,
} from '../../../src/modules/mcp/index.js';
import {
  hostToolSurface,
  modernBody,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  injectStrictPost,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function descriptor(name: string, requiredScopes: readonly string[], compatOnly = false) {
  return Object.freeze({
    name,
    description: `${name} test tool`,
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false }),
    requiredScopes: Object.freeze([...requiredScopes]),
    ...(compatOnly ? { compatOnly: true as const } : {}),
  });
}

function createFacade(calls: string[]): McpApplicationFacade {
  const reportsRead = descriptor('reports.get', ['reports:read']);
  const reportsWrite = descriptor('reports.plan', ['reports:write']);
  const compatOnly = descriptor('known.community.compat', [], true);
  return Object.freeze({
    async listTools(context) {
      const tools = [compatOnly];
      if (context.scopes.includes('mcp:read:public')) {
        tools.push(PHASE4B_MCP_READ_TOOL_CATALOG[0]!);
      }
      if (context.scopes.includes('reports:read')) tools.push(reportsRead);
      if (context.scopes.includes('reports:write')) tools.push(reportsWrite);
      return Object.freeze({ tools: Object.freeze(tools) });
    },
    async callTool(_context, name, args) {
      calls.push(name);
      if (name === 'reports.get') {
        return Object.freeze({
          kind: 'complete' as const,
          content: Object.freeze([{ type: 'text', text: '{"report":"ok"}' }]),
          structuredContent: Object.freeze({ report: 'ok' }),
        });
      }
      if (name === 'reports.plan') {
        if (Array.isArray(args.operations) && args.operations.length > 0) {
          return Object.freeze({
            kind: 'awaiting_approval' as const,
            planId: 'plan-1',
            approvalUri: 'https://approval.example/plan-1',
            expiresAt: '2026-09-19T09:00:00.000Z',
            bindingSummary: 'authenticated',
          });
        }
        return Object.freeze({
          kind: 'complete' as const,
          content: Object.freeze([{ type: 'text', text: '{"plan":"ok"}' }]),
          structuredContent: Object.freeze({ plan: 'ok' }),
        });
      }
      return Object.freeze({
        kind: 'rejected' as const,
        stableCode: 'unknown_tool',
        safeMessage: 'Unknown tool.',
        retryable: false,
      });
    },
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async listResourceTemplates() {
      return Object.freeze({ resourceTemplates: Object.freeze([]) });
    },
    async readResource() {
      return Object.freeze({ contents: Object.freeze([]) });
    },
  });
}

function createVerifier(requiredScopes: string[]): McpOauthVerifier {
  return {
    async verify(input) {
      const authorization = typeof input.authorization === 'string'
        ? input.authorization
        : '';
      const scopes = authorization === 'Bearer reports-read'
        ? ['reports:read']
        : authorization === 'Bearer reports-write'
          ? ['reports:write']
          : authorization === 'Bearer core-read'
            ? ['mcp:read:public']
            : [];
      requiredScopes.push(...(input.requiredScopes ?? []));
      if (!(input.requiredScopes ?? []).every((scope) => scopes.includes(scope))) {
        throw new McpOauthVerificationError('missing_scope');
      }
      return {
        binding: Object.freeze({
          kind: 'authenticated' as const,
          principalId: 'account-1',
          clientId: 'client-1',
          credentialBindingId: 'credential-1',
          resourceAudience: 'https://collections.example.test/collections/-/mcp',
          securityEpoch: 'epoch-1',
        }),
        accountSubjectId: 'subject-1',
        scopes: Object.freeze(scopes),
      } as never;
    },
  };
}

function startStrict(calls: string[], requiredScopes: string[]) {
  const toolSurface = hostToolSurface();
  const server = startCompatApp({
    compatEnabled: false,
    env: {
      KNOWN_FEATURE_REPORTS: 'true',
      KNOWN_FEATURE_REPORTS_MCP: 'true',
      MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own,reports:read,reports:write,reports:publish',
    },
    mcpReadTransport: {
      oauthVerifier: createVerifier(requiredScopes),
      applicationFacade: createFacade(calls),
      readToolAdapter: toolSurface.adapter,
      readToolParamDeclarations: toolSurface.paramDeclarations,
    },
  });
  apps.push(server.app);
  return server;
}

test('strict Modern routes Reports extensions through the facade using Reports scopes', async () => {
  const calls: string[] = [];
  const requiredScopes: string[] = [];
  const server = startStrict(calls, requiredScopes);

  const listed = await injectStrictPost(server.app, 'tools/list', 1, {
    authorization: 'Bearer reports-read',
  });
  assert.equal(listed.statusCode, 200);
  const listedPayload = JSON.parse(listed.payload) as { result?: { tools?: readonly { name: string }[] } };
  assert.deepEqual(listedPayload.result?.tools?.map((tool) => tool.name), ['reports.get']);

  const called = await injectStrictPost(server.app, 'tools/call', 2, {
    authorization: 'Bearer reports-read',
    'mcp-name': 'reports.get',
  }, modernBody('tools/call', 2, {
    name: 'reports.get',
    arguments: { slug: 'report-one' },
  }));
  assert.equal(called.statusCode, 200);
  const callPayload = JSON.parse(called.payload) as { result?: Record<string, unknown> };
  assert.equal(callPayload.result?.resultType, 'complete');
  assert.deepEqual(callPayload.result?.structuredContent, { report: 'ok' });
  assert.deepEqual(calls, ['reports.get']);
  assert.deepEqual(requiredScopes, ['reports:read']);
});

test('strict Reports write scope is independent from core read scope and missing Reports scope is rejected', async () => {
  const calls: string[] = [];
  const requiredScopes: string[] = [];
  const server = startStrict(calls, requiredScopes);

  const listed = await injectStrictPost(server.app, 'tools/list', 3, {
    authorization: 'Bearer reports-write',
  });
  assert.equal(listed.statusCode, 200);
  const listedPayload = JSON.parse(listed.payload) as { result?: { tools?: readonly { name: string }[] } };
  assert.deepEqual(listedPayload.result?.tools?.map((tool) => tool.name), ['reports.plan']);

  const called = await injectStrictPost(server.app, 'tools/call', 4, {
    authorization: 'Bearer reports-write',
    'mcp-name': 'reports.plan',
  }, modernBody('tools/call', 4, {
    name: 'reports.plan',
    arguments: { operations: [], reportRevision: 'r1' },
  }));
  assert.equal(called.statusCode, 200);
  assert.equal((JSON.parse(called.payload) as { result?: Record<string, unknown> }).result?.resultType, 'complete');
  assert.deepEqual(calls, ['reports.plan']);

  const awaiting = await injectStrictPost(server.app, 'tools/call', 41, {
    authorization: 'Bearer reports-write',
    'mcp-name': 'reports.plan',
  }, modernBody('tools/call', 41, {
    name: 'reports.plan',
    arguments: { operations: [{ type: 'report' }], reportRevision: 'r1' },
  }));
  assert.equal(awaiting.statusCode, 200);
  const awaitingResult = (JSON.parse(awaiting.payload) as { result?: Record<string, unknown> }).result;
  assert.equal(awaitingResult?.resultType, 'complete');
  assert.deepEqual(awaitingResult?.structuredContent, {
    status: 'awaiting_approval',
    planId: 'plan-1',
    approvalUri: 'https://approval.example/plan-1',
    expiresAt: '2026-09-19T09:00:00.000Z',
  });
  assert.deepEqual(calls, ['reports.plan', 'reports.plan']);

  const missing = await injectStrictPost(server.app, 'tools/call', 5, {
    authorization: 'Bearer core-read',
    'mcp-name': 'reports.get',
  }, modernBody('tools/call', 5, {
    name: 'reports.get',
    arguments: { slug: 'report-one' },
  }));
  assert.notEqual(missing.statusCode, 200);
  assert.match(missing.payload, /insufficient_permission/iu);
  assert.deepEqual(calls, ['reports.plan', 'reports.plan']);
});

test('strict dispatch keeps core adapter calls and hides compat-only tools', async () => {
  const calls: string[] = [];
  const requiredScopes: string[] = [];
  const server = startStrict(calls, requiredScopes);

  const listed = await injectStrictPost(server.app, 'tools/list', 6, {
    authorization: 'Bearer core-read',
  });
  assert.equal(listed.statusCode, 200);
  const listedPayload = JSON.parse(listed.payload) as { result?: { tools?: readonly { name: string }[] } };
  assert.deepEqual(listedPayload.result?.tools?.map((tool) => tool.name), ['collections.get']);

  const core = await injectStrictPost(server.app, 'tools/call', 7, {
    authorization: 'Bearer core-read',
    'mcp-name': 'collections.get',
    'mcp-param-x-collection-id': 'collection-1',
  }, modernBody('tools/call', 7, {
    name: 'collections.get',
    arguments: { collectionId: 'collection-1' },
  }));
  assert.equal(core.statusCode, 200);
  assert.equal((JSON.parse(core.payload) as { result?: Record<string, unknown> }).result?.resultType, 'complete');
  assert.deepEqual(calls, []);

  const compatOnly = await injectStrictPost(server.app, 'tools/call', 8, {
    authorization: 'Bearer core-read',
    'mcp-name': 'known.community.compat',
  }, modernBody('tools/call', 8, {
    name: 'known.community.compat',
    arguments: {},
  }));
  assert.match(compatOnly.payload, /Unknown tool/iu);
  assert.deepEqual(calls, []);
});
