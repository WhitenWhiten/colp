import { describe, expect, it, vi } from 'vitest';

import {
  redactApiKeyToolResult,
  redactCommitStructuredContent,
  structuredContentContainsSecret,
  McpSecretRedactionError,
  type McpFlatApiKeyApplicationResult,
} from '../../src/mcp/secret-redaction.js';
import {
  createMcpWriteToolGateway,
  toRedactedKeyToolResult,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type { ApiKeyMetadata } from '../../src/types/generated.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import {
  canonicalApiKeyCreateResultFixture,
  canonicalApiKeyMetadataFixture,
  canonicalApiKeyRotateResultFixture,
} from './canonical-api-key-fixture.js';

const allowAllUriPolicy = Object.freeze({ allow: () => true });

it('withholds arbitrary transform data even when it impersonates an already-redacted key', () => {
  const redacted = redactCommitStructuredContent({
    operations: [{ transform: {
      keyId: 'key-safe', secretAvailable: true,
      revealUri: 'https://attacker.example/reveal',
      value: 'plaintext-hidden-under-value',
    } }],
  }, {
    revealUriForKey: keyId => `https://alice.example/keys/${keyId}/reveal`,
    uriPolicy: allowAllUriPolicy,
  });
  expect(redacted).toEqual({ operations: [{ transform: {
    keyId: 'key-safe', secretAvailable: true, revealUri: 'https://alice.example/keys/key-safe/reveal',
  } }] });
  expect(JSON.stringify(redacted)).not.toContain('plaintext-hidden-under-value');
});

it('withholds arbitrary fields attached to a flat key transform', () => {
  expect(redactCommitStructuredContent({ operations: [{ transform: {
    keyId: 'key-safe', secret: 'plaintext-secret', value: 'plaintext-hidden-under-value',
  } }] }, {
    revealUriForKey: keyId => `https://alice.example/keys/${keyId}/reveal`,
    uriPolicy: allowAllUriPolicy,
  })).toEqual({ operations: [{ transform: {
    keyId: 'key-safe', secretAvailable: true, revealUri: 'https://alice.example/keys/key-safe/reveal',
  } }] });
});

const canonicalKeyMetadata = canonicalApiKeyMetadataFixture({
  id: 'key_01JZ',
  name: 'Feed reader',
  type: 'read_key',
  scopes: ['collections:read', 'feed:read'],
  collections: ['collection-alpha', 'collection-beta'],
  createdAt: '2026-07-16T07:00:00Z',
  expiresAt: '2026-10-16T00:00:00Z',
  lastUsedAt: '2026-07-20T09:30:00Z',
  lastUsedIp: '192.0.2.44',
  status: 'active',
});

function apiKeyCreateResult(key = canonicalKeyMetadata, secret?: string) {
  return canonicalApiKeyCreateResultFixture(key, secret);
}

function apiKeyRotateResult(
  key: ApiKeyMetadata = canonicalApiKeyMetadataFixture({
    ...canonicalKeyMetadata,
    id: 'key_rotate',
    name: 'Rotated publisher',
    type: 'publisher_key',
    scopes: ['collections:read', 'collections:write'] as [
      'collections:read',
      'collections:write',
    ],
    collections: [],
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    status: 'rotating',
  }),
  secret?: string,
) {
  return canonicalApiKeyRotateResultFixture(key, secret);
}

function expectedRedactedKey(
  key: ApiKeyMetadata,
  revealUri = `https://alice.example/collections/keys/${key.id}/reveal`,
): Readonly<Record<string, unknown>> {
  const { id: keyId, ...metadata } = key;
  return {
    keyId,
    ...metadata,
    secretAvailable: true,
    revealUri,
  };
}

function trustedContext(
  principalId = 'user-a',
  clientId = 'client-a',
  credentialBindingId = 'credential-binding-a',
): McpTrustedWriteRequestContext {
  return Object.freeze({
    binding: authenticatedBinding({ principalId, clientId, credentialBindingId }),
    scope: Object.freeze(['keys:write', 'access:write']),
    budget: Object.freeze({
      maxDepth: 32,
      maxNodes: 10_000,
      maxBytes: 1_048_576,
      maxOperations: 1_000,
    }),
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({
      subjectId: principalId,
      clientId,
      scopes: Object.freeze(['keys:write']),
    }),
  });
}

describe('MCP-0005 secret redaction [evidence:mcp.secret-redaction]', () => {
  it('uses generated types and canonical schemas for create and rotate fixtures [evidence:mcp.secret-redaction]', () => {
    const validators = createValidatorRegistry();

    expect(validators.validate('apiKeyCreateResult', apiKeyCreateResult())).toEqual({
      valid: true,
      errors: [],
    });
    expect(validators.validate('apiKeyRotateResult', apiKeyRotateResult())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('keeps redaction helpers importable from their modules [evidence:mcp.secret-redaction]', () => {
    expect(typeof redactApiKeyToolResult).toBe('function');
    expect(typeof structuredContentContainsSecret).toBe('function');
    expect(typeof toRedactedKeyToolResult).toBe('function');
    expect(typeof redactCommitStructuredContent).toBe('function');
  });

  it.each([
    ['apiKeyCreateResult', apiKeyCreateResult()],
    ['apiKeyRotateResult', apiKeyRotateResult()],
  ] as const)(
    'adapts canonical %s to complete safe metadata [evidence:mcp.secret-redaction]',
    (_definition, canonical) => {
      const revealUri = `https://alice.example/collections/keys/${canonical.key.id}/reveal`;
      const redacted = redactApiKeyToolResult(canonical, {
        revealUri,
        uriPolicy: allowAllUriPolicy,
      });

      expect(redacted).toEqual(expectedRedactedKey(canonical.key, revealUri));
      expect(redacted).not.toHaveProperty('key');
      expect(redacted).not.toHaveProperty('secret');
      expect(JSON.stringify(redacted)).not.toContain(canonical.secret);
      expect(structuredContentContainsSecret(redacted)).toBe(false);
    },
  );

  it('redacts nested secret fields in the explicit flat application DTO [evidence:mcp.secret-redaction]', () => {
    const internalFlatResult = {
      keyId: 'key_nested',
      metadata: {
        name: 'nested',
        secret: 'nested-secret',
        token: 'tok',
      },
    } satisfies McpFlatApiKeyApplicationResult;
    const redacted = redactApiKeyToolResult(
      internalFlatResult,
      {
        revealUri: 'https://alice.example/collections/keys/key_nested/reveal',
        uriPolicy: allowAllUriPolicy,
      },
    );

    expect(redacted.metadata).toEqual({ name: 'nested' });
    expect(structuredContentContainsSecret(redacted)).toBe(false);
  });

  it.each([
    ['missing key', { secret: 'colp_live_missing_key' }],
    ['non-object key', { key: 'key_1', secret: 'colp_live_invalid_key' }],
    ['missing canonical key.id', {
      key: { ...canonicalKeyMetadata, id: undefined },
      secret: 'colp_live_missing_id',
    }],
    ['missing canonical secret', { key: canonicalKeyMetadata }],
  ])('fails closed for malformed canonical result: %s [evidence:mcp.secret-redaction]', (_case, raw) => {
    expect(() =>
      redactApiKeyToolResult(
        raw as never,
        {
          revealUri: 'https://alice.example/collections/keys/key_1/reveal',
          uriPolicy: allowAllUriPolicy,
        },
      ),
    ).toThrow(McpSecretRedactionError);
  });

  it('fails closed for ambiguous canonical and flat result [evidence:mcp.secret-redaction]', () => {
    const canonical = apiKeyCreateResult();
    expect(() =>
      redactApiKeyToolResult(
        { ...canonical, keyId: 'different-flat-id' } as never,
        {
          revealUri: 'https://alice.example/collections/keys/key_01JZ/reveal',
          uriPolicy: allowAllUriPolicy,
        },
      ),
    ).toThrow(McpSecretRedactionError);
  });

  it('fails closed when revealUri is missing [evidence:mcp.secret-redaction]', () => {
    expect(() =>
      redactApiKeyToolResult(
        apiKeyCreateResult(),
        { revealUri: '', uriPolicy: allowAllUriPolicy },
      ),
    ).toThrow(McpSecretRedactionError);
  });

  it('detects secret-bearing structured content [evidence:mcp.secret-redaction]', () => {
    expect(structuredContentContainsSecret({ keyId: 'k', secret: 's' })).toBe(true);
    expect(structuredContentContainsSecret({ keyId: 'k', secretAvailable: true })).toBe(false);
  });

  it('toRedactedKeyToolResult never returns secrets to model context [evidence:mcp.secret-redaction]', () => {
    const canonical = apiKeyRotateResult();
    const revealUri = 'https://alice.example/collections/keys/key_rotate/reveal';
    const result = toRedactedKeyToolResult(canonical, revealUri, allowAllUriPolicy);

    expect(result).toEqual(expectedRedactedKey(canonical.key, revealUri));
    expect(JSON.stringify(result)).not.toContain(canonical.secret);
    expect(structuredContentContainsSecret(result)).toBe(false);
  });

  it('write gateway rejects one-shot canonical create and rotate without leaking secrets [evidence:mcp.secret-redaction]', async () => {
    const createCanonical = apiKeyCreateResult(
      Object.freeze({ ...canonicalKeyMetadata, id: 'key_gw_create', name: 'Gateway create' }),
      'colp_live_gateway_create_secret',
    );
    const rotateCanonical = apiKeyRotateResult(
      Object.freeze({ ...canonicalKeyMetadata, id: 'key_gw_rotate', name: 'Gateway rotate' }),
      'colp_live_gateway_rotate_secret',
    );
    const createKey = vi.fn(async () => createCanonical);
    const rotateKey = vi.fn(async () => rotateCanonical);
    const planStore = createInMemoryPlanStore();
    const approvalStore = createInMemoryApprovalStore();
    const executor = { execute: async () => [] };

    const gateway = createMcpWriteToolGateway({
      changePlan: {
        planStore,
        approvalStore,
        impact: {
          assessImpact: async () => ({
            collections: 0,
            nodes: 0,
            annotations: 0,
            attachments: 0,
            relations: 0,
            privateFieldsExcluded: [] as string[],
          }),
        },
        revisions: {
          resolveBaseRevisions: async (operation) => resolveFixtureBaseRevisions(operation),
          currentRevisions: async (_transaction, base) => ({ ...base }),
        },
        scopes: { hasScopes: async () => true },
        authorizationPolicy: { requiredScopesForOperation: async () => [] },
        commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
        rateLimit: { allow: async () => true },
        approvalBaseUri: 'https://alice.example/collections/approvals',
        uriPolicy: { allow: () => true },
      },
      apiKeys: { createKey, rotateKey },
      revealUriForKey: (keyId) => `https://alice.example/collections/keys/${keyId}/reveal`,
    });

    const toolNames = gateway.listTools().map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['keys.create', 'keys.rotate']));

    const createResult = await gateway.callTool(
      'keys.create',
      {
        name: 'Gateway publisher',
        type: 'publisher_key',
        scopes: ['collections:write'],
        collections: ['collection-1'],
        expiresAt: null,
      },
      trustedContext(),
    );
    const rotateResult = await gateway.callTool(
      'keys.rotate',
      { overlapSeconds: 30 },
      trustedContext(),
    );

    expect(createResult.isError).toBe(true);
    expect(rotateResult.isError).toBe(true);
    expect(JSON.stringify([createResult, rotateResult])).not.toContain(createCanonical.secret);
    expect(JSON.stringify([createResult, rotateResult])).not.toContain(rotateCanonical.secret);
    expect(createKey).not.toHaveBeenCalled();
    expect(rotateKey).not.toHaveBeenCalled();
  });

  it('redactCommitStructuredContent adapts canonical create and rotate metadata [evidence:mcp.secret-redaction]', () => {
    const createCanonical = apiKeyCreateResult(
      Object.freeze({ ...canonicalKeyMetadata, id: 'key_commit_create' }),
      'colp_live_commit_create_secret',
    );
    const rotateCanonical = apiKeyRotateResult(
      Object.freeze({ ...canonicalKeyMetadata, id: 'key_commit_rotate', status: 'rotating' }),
      'colp_live_commit_rotate_secret',
    );
    const redacted = redactCommitStructuredContent(
      {
        planId: 'plan_1',
        committedAt: '2026-07-16T07:00:00.000Z',
        operations: [
          {
            opId: 'op-1',
            result: createCanonical,
          },
          {
            opId: 'op-2',
            result: rotateCanonical,
            diagnostics: {
              label: 'safe diagnostic',
              nested: { secret: 'nested-commit-secret', token: 'nested-token' },
            },
          },
        ],
      },
      {
        revealUriForKey: (keyId) => `https://alice.example/collections/keys/${keyId}/reveal`,
        uriPolicy: allowAllUriPolicy,
      },
    );
    const json = JSON.stringify(redacted);
    expect(redacted).toMatchObject({
      operations: [
        { result: expectedRedactedKey(createCanonical.key) },
        {
          result: expectedRedactedKey(rotateCanonical.key),
          diagnostics: { label: 'safe diagnostic', nested: {} },
        },
      ],
    });
    expect(json).not.toContain(createCanonical.secret);
    expect(json).not.toContain(rotateCanonical.secret);
    expect(json).not.toContain('nested-commit-secret');
    expect(json).not.toContain('nested-token');
    expect(json).not.toContain('"secret"');
    expect(structuredContentContainsSecret(redacted)).toBe(false);
  });

  it.each([
    ['malformed canonical', { key: { ...canonicalKeyMetadata, id: '' }, secret: 'colp_live_bad_id_value' }],
    ['ambiguous canonical/flat', { ...apiKeyCreateResult(), keyId: 'flat-id' }],
  ])('Commit redaction fails closed for %s key result [evidence:mcp.secret-redaction]', (_case, result) => {
    expect(() => redactCommitStructuredContent(
      { operations: [{ result }] },
      {
        revealUriForKey: (keyId) => `https://alice.example/collections/keys/${keyId}/reveal`,
        uriPolicy: allowAllUriPolicy,
      },
    )).toThrow(McpSecretRedactionError);
  });

  it.each([
    ['canonical', apiKeyCreateResult()],
    ['flat', { keyId: 'key_commit_flat', secret: 'colp_live_commit_flat_secret' }],
  ] as const)(
    'Commit redaction rejects a %s key result without a reveal boundary [evidence:mcp.secret-redaction]',
    (_shape, result) => {
      expect(() => redactCommitStructuredContent({ operations: [{ result }] }))
        .toThrow(McpSecretRedactionError);
    },
  );

  it.each([
    ['create_key', {
      type: 'create_key' as const,
      input: {
        name: 'Plan without reveal boundary',
        type: 'read_key' as const,
        scopes: ['collections:read'] as ['collections:read'],
        collections: [] as string[],
        expiresAt: null,
      },
    }],
    ['rotate_key', {
      type: 'rotate_key' as const,
      targetId: 'key_without_reveal',
      input: { overlapSeconds: 60 },
    }],
  ] as const)(
    'rejects a %s Plan before persistence when no reveal boundary is configured [evidence:mcp.secret-redaction]',
    async (_type, operation) => {
      const planStore = createInMemoryPlanStore();
      const approvalStore = createInMemoryApprovalStore();
      const assessImpact = vi.fn(async () => ({
        collections: 0,
        nodes: 0,
        annotations: 0,
        attachments: 0,
        relations: 0,
        privateFieldsExcluded: [] as string[],
      }));
      const resolveBaseRevisions = vi.fn(async () => ({}));
      const executor = { execute: vi.fn(async () => []) };
      const service = createChangePlanService({
        planStore,
        approvalStore,
        impact: { assessImpact },
        revisions: {
          resolveBaseRevisions,
          currentRevisions: async (_transaction, base) => ({ ...base }),
        },
        scopes: { hasScopes: async () => true },
        authorizationPolicy: { requiredScopesForOperation: async () => [] },
        commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
        rateLimit: { allow: async () => true },
        approvalBaseUri: 'https://alice.example/collections/approvals',
        uriPolicy: allowAllUriPolicy,
        ids: { nextPlanId: () => 'plan_without_reveal' },
      });

      await expect(service.plan({
        operations: [operation],
        reason: 'key plan requires an out-of-band reveal boundary',
        dryRun: true,
      }, trustedContext().binding)).rejects.toMatchObject({ code: 'invalid_plan_request' });

      expect(await planStore.get('plan_without_reveal')).toBeUndefined();
      expect(assessImpact).not.toHaveBeenCalled();
      expect(resolveBaseRevisions).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    },
  );

  it('gateway Plan/Commit path never returns secrets in structured content [evidence:mcp.secret-redaction]', async () => {
    const context = trustedContext();
    const secretValue = 'colp_live_gateway_secret_must_not_leak';
    const firstMetadata = Object.freeze({
      ...canonicalKeyMetadata,
      id: 'key_plan_commit',
      name: 'First committed metadata',
      status: 'active' as const,
    });
    const firstCanonical = apiKeyCreateResult(firstMetadata, secretValue);
    const rotatedMetadata = Object.freeze({
      ...canonicalKeyMetadata,
      id: 'key_plan_rotate',
      name: 'First rotated metadata',
      type: 'sync_key' as const,
      scopes: ['sync:pull', 'sync:push'] as ['sync:pull', 'sync:push'],
      status: 'rotating' as const,
    });
    const rotatedSecret = 'colp_live_gateway_rotate_must_not_leak';
    const rotateCanonical = apiKeyRotateResult(rotatedMetadata, rotatedSecret);
    let revealVersion = 'first';
    const planStore = createInMemoryPlanStore();
    const approvalStore = createInMemoryApprovalStore();
    const executor = {
      execute: vi.fn(async () => [
        {
          opId: 'op-key',
          sequence: 1,
          status: 'applied' as const,
          revision: 'r_1',
          cursor: 'c_1',
          warnings: [] as [],
          transform: firstCanonical,
        },
        {
          opId: 'op-key-rotate',
          sequence: 2,
          status: 'applied' as const,
          revision: 'r_2',
          cursor: 'c_2',
          warnings: [] as [],
          transform: rotateCanonical,
        },
      ]),
    };
    const revealUriForKey = vi.fn((keyId: string) =>
      `https://alice.example/collections/keys/${keyId}/reveal/${revealVersion}`);
    const gateway = createMcpWriteToolGateway({
      changePlan: {
        planStore,
        approvalStore,
        impact: {
          assessImpact: async () => ({
            collections: 0,
            nodes: 0,
            annotations: 0,
            attachments: 0,
            relations: 0,
            privateFieldsExcluded: [] as string[],
          }),
        },
        revisions: {
          resolveBaseRevisions: async (operation) => resolveFixtureBaseRevisions(operation),
          currentRevisions: async (_transaction, base) => ({ ...base }),
        },
        scopes: { hasScopes: async () => true },
        authorizationPolicy: { requiredScopesForOperation: async () => [] },
        commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
        rateLimit: { allow: async () => true },
        approvalBaseUri: 'https://alice.example/collections/approvals',
        uriPolicy: { allow: () => true },
        ids: { nextPlanId: () => 'plan_secret_gw' },
        clock: { now: () => new Date('2026-07-16T07:00:00.000Z') },
      },
      revealUriForKey,
    });

    const planResult = await gateway.callTool(
      'changes.plan',
      {
        operations: [
          {
            type: 'create_key',
            input: {
              name: 'from-plan',
              type: 'read_key',
              scopes: ['collections:read'],
              collections: [],
              expiresAt: null,
            },
          },
          {
            type: 'rotate_key',
            targetId: 'key_plan_rotate',
            input: { overlapSeconds: 60 },
          },
        ],
        reason: 'create and rotate keys via plan',
        dryRun: true,
      },
      context,
    );
    expect(JSON.stringify(planResult)).not.toContain(secretValue);
    const planId = (planResult.structuredContent as { planId: string }).planId;

    await gateway.recordOutOfBandApproval(planId, context);
    const commitResult = await gateway.callTool(
      'changes.commit',
      { planId, idempotencyKey: 'idem-gw-secret' },
      context,
    );

    const commitJson = JSON.stringify(commitResult);
    expect(commitJson).not.toContain(secretValue);
    expect(commitJson).not.toContain(rotatedSecret);
    expect(commitJson).not.toContain('"secret"');
    expect(commitResult.structuredContent).toMatchObject({
      operations: [
        {
          transform: expectedRedactedKey(
            firstMetadata,
            'https://alice.example/collections/keys/key_plan_commit/reveal/first',
          ),
        },
        {
          transform: expectedRedactedKey(
            rotatedMetadata,
            'https://alice.example/collections/keys/key_plan_rotate/reveal/first',
          ),
        },
      ],
    });
    expect(structuredContentContainsSecret(commitResult.structuredContent)).toBe(false);

    revealVersion = 'changed-after-first-commit';
    const replay = await gateway.callTool(
      'changes.commit',
      { planId, idempotencyKey: 'idem-gw-secret' },
      context,
    );
    expect(replay).toEqual(commitResult);
    expect(JSON.stringify(replay)).not.toContain(secretValue);
    expect(JSON.stringify(replay)).not.toContain(rotatedSecret);
    expect(JSON.stringify(replay)).not.toContain('changed-after-first-commit');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(revealUriForKey).toHaveBeenCalledTimes(2);
    expect(revealUriForKey).toHaveBeenNthCalledWith(1, 'key_plan_commit');
    expect(revealUriForKey).toHaveBeenNthCalledWith(2, 'key_plan_rotate');
  });
});
