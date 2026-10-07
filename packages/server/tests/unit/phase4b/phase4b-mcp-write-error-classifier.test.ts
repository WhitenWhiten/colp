/**
 * MCP-CQ-04: shared strict/compat write-error classification.
 * Table-driven for every `Phase4bMcpLowRiskNodeCreateError` code. Business
 * rejects must not collapse to JSON-RPC `-32603`.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  MCP_WIRE_INTERNAL_ERROR_CODE,
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  createAuthenticatedBinding,
  type Mcp20260728WriteToolAdapter,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_LOW_RISK_NODE_CREATE_ERROR_CODES,
  Phase4bMcpLowRiskNodeCreateError,
  classifyPhase4bMcpWriteError,
  createMcpApplicationContext,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpResourceIdentity,
  redactedPhase4bMcpWriteErrorLogFields,
  toPhase4bMcpWriteRejectedResult,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpLowRiskNodeCreateErrorCode,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type Phase4bMcpWriteErrorClassification,
} from '../../../src/modules/mcp/index.js';
import { COLLECTION_KINDS } from '../../../src/modules/collections/index.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import {
  AUDIENCE,
  SCOPES,
  WRITE_SCOPES,
  mcpEnv,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  createInMemoryWriteToolFixture,
} from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  nodeCreateArguments,
} from '../../support/phase4b-mcp-compat-write.js';

const CANARY = 'CANARY-cq04-password=supersecret-Bearer-eyJhbGciOi';
const CALL_SCOPES = Object.freeze([...SCOPES, ...WRITE_SCOPES]);
const AUTHENTICATED = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

interface MappedRow {
  readonly id: string;
  readonly error: Error;
  readonly classified: Phase4bMcpWriteErrorClassification;
}

function mappedNodeCreateRows(): readonly MappedRow[] {
  const rows: MappedRow[] = PHASE4B_MCP_LOW_RISK_NODE_CREATE_ERROR_CODES.map((code) => {
    const error = new Phase4bMcpLowRiskNodeCreateError(code, `${code} ${CANARY}`);
    return Object.freeze({
      id: code,
      error,
      classified: classifyPhase4bMcpWriteError(error),
    });
  });
  return Object.freeze(rows);
}

function expectedWriteErrorData(stableClass: string): Readonly<Record<string, unknown>> {
  if (stableClass === 'parent_invalid') {
    return Object.freeze({
      code: stableClass,
      field: 'parentId',
      allowedKinds: Object.freeze(['folder', 'bookmark']),
      allowedVisibilities: Object.freeze(['inherit', 'protected', 'private']),
      nextTool: 'nodes.create',
    });
  }
  if (stableClass === 'invalid_params') {
    return Object.freeze({
      code: stableClass,
      allowedKinds: Object.freeze(['folder', 'bookmark']),
      allowedVisibilities: Object.freeze(['inherit', 'protected', 'private']),
      nextTool: 'nodes.create',
    });
  }
  return Object.freeze({ code: stableClass });
}

test('writeErrorHintFrom copies only field and nextTool from a catalog error', () => {
  const bare = new Phase4bMcpLowRiskNodeCreateError('invalid_catalog_input', 'missing');
  assert.equal(writeErrorHintFrom(bare), undefined);
  const hinted = new Phase4bMcpLowRiskNodeCreateError(
    'invalid_catalog_input',
    'missing url',
    { field: 'node.url', nextTool: 'nodes.create' },
  );
  assert.deepEqual(writeErrorHintFrom(hinted), {
    field: 'node.url',
    nextTool: 'nodes.create',
  });
  assert.equal(writeErrorHintFrom(new Error('nope')), undefined);
});

test('invalid_params data names the failed field and retries nodes.create', () => {
  const error = new Phase4bMcpLowRiskNodeCreateError(
    'invalid_catalog_input',
    'MCP-W04 bookmark URL must satisfy the canonical HTTP(S) URL contract.',
    { field: 'node.url', nextTool: 'nodes.create' },
  );
  const wire = toPhase4bMcpWriteRequestError(
    classifyPhase4bMcpWriteError(error),
    writeErrorHintFrom(error),
  );
  assert.deepEqual(wire.data, {
    code: 'invalid_params',
    field: 'node.url',
    allowedKinds: Object.freeze(['folder', 'bookmark']),
    allowedVisibilities: Object.freeze(['inherit', 'protected', 'private']),
    nextTool: 'nodes.create',
  });
});

test('collections.create invalid_params names the field and does not send the model to nodes.create', () => {
  const error = new Phase4bMcpLowRiskNodeCreateError(
    'invalid_catalog_input',
    'collections.create title must be a non-empty string.',
    { field: 'title', nextTool: 'collections.create' },
  );
  const wire = toPhase4bMcpWriteRequestError(
    classifyPhase4bMcpWriteError(error),
    writeErrorHintFrom(error),
  );
  assert.deepEqual(wire.data, {
    code: 'invalid_params',
    field: 'title',
    allowedKinds: COLLECTION_KINDS,
    allowedVisibilities: Object.freeze(['private']),
    nextTool: 'collections.create',
  });
  const data = wire.data as { readonly nextTool?: string; readonly allowedKinds?: readonly string[] };
  assert.notEqual(data.nextTool, 'nodes.create');
  assert.equal(data.allowedKinds?.includes('folder'), false);
  assert.equal(data.allowedKinds?.includes('bookmark'), false);
});

test('parent_invalid data always names parentId and retries nodes.create', () => {
  const error = new Phase4bMcpLowRiskNodeCreateError(
    'parent_invalid',
    'nodes.create parent must be a live folder or root in the same collection.',
  );
  const wire = toPhase4bMcpWriteRequestError(
    classifyPhase4bMcpWriteError(error),
    writeErrorHintFrom(error),
  );
  assert.deepEqual(wire.data, expectedWriteErrorData('parent_invalid'));
  assert.equal((wire.data as { field?: string }).field, 'parentId');
});

test('mapping table covers every Phase4bMcpLowRiskNodeCreateError code', () => {
  const expected: Record<Phase4bMcpLowRiskNodeCreateErrorCode, true> = {
    invalid_catalog_input: true,
    unknown_operation: true,
    open_payload_rejected: true,
    budget_exceeded: true,
    scope_invalid: true,
    stale_revision: true,
    policy_denied: true,
    parent_invalid: true,
    secret_marker_rejected: true,
    prompt_injection_rejected: true,
    commit_unknown: true,
    output_invalid: true,
    authoritative_state_invalid: true,
  };
  assert.deepEqual(
    [...PHASE4B_MCP_LOW_RISK_NODE_CREATE_ERROR_CODES].sort(),
    Object.keys(expected).sort(),
  );
});

test('classifier maps every low-risk node-create code to a frozen COLP class', () => {
  const byCode = Object.fromEntries(
    mappedNodeCreateRows()
      .map((row) => [row.id, row.classified]),
  ) as Record<Phase4bMcpLowRiskNodeCreateErrorCode, Phase4bMcpWriteErrorClassification>;

  assert.equal(byCode.invalid_catalog_input.stableClass, 'invalid_params');
  assert.equal(byCode.invalid_catalog_input.jsonRpcCode, MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
  assert.equal(byCode.unknown_operation.stableClass, 'invalid_params');
  assert.equal(byCode.parent_invalid.stableClass, 'parent_invalid');
  assert.equal(byCode.parent_invalid.jsonRpcCode, MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
  assert.equal(byCode.parent_invalid.colpKind, 'invalid_params');
  assert.equal(byCode.parent_invalid.safeMessage, 'Parent is not a live folder in this collection.');
  assert.equal(byCode.open_payload_rejected.stableClass, 'safe_input_rejected');
  assert.equal(byCode.secret_marker_rejected.stableClass, 'safe_input_rejected');
  assert.equal(byCode.prompt_injection_rejected.stableClass, 'safe_input_rejected');
  assert.equal(byCode.budget_exceeded.stableClass, 'budget_exceeded');
  assert.equal(byCode.scope_invalid.stableClass, 'unknown_tool');
  assert.equal(byCode.scope_invalid.safeMessage, 'Unknown tool.');
  assert.equal(byCode.stale_revision.stableClass, 'stale_revision');
  assert.equal(byCode.policy_denied.stableClass, 'policy_rejected');
  assert.equal(byCode.commit_unknown.stableClass, 'internal_error');
  assert.equal(byCode.commit_unknown.jsonRpcCode, MCP_WIRE_INTERNAL_ERROR_CODE);
  assert.equal(byCode.output_invalid.stableClass, 'internal_error');
  assert.equal(byCode.authoritative_state_invalid.stableClass, 'internal_error');

  const cancelled = classifyPhase4bMcpWriteError(new DOMException('Client disconnected', 'AbortError'));
  assert.equal(cancelled.stableClass, 'cancelled');
  const timedOut = classifyPhase4bMcpWriteError(new DOMException('MCP request timeout', 'TimeoutError'));
  assert.equal(timedOut.stableClass, 'timeout');
  const unknown = classifyPhase4bMcpWriteError(new Error(`postgres ${CANARY}`));
  assert.equal(unknown.stableClass, 'internal_error');
  assert.equal(unknown.jsonRpcCode, MCP_WIRE_INTERNAL_ERROR_CODE);

  for (const row of mappedNodeCreateRows()) {
    assert.equal(row.classified.safeMessage.includes(CANARY), false, row.id);
    const log = redactedPhase4bMcpWriteErrorLogFields(row.classified, 'corr-1');
    assert.deepEqual(Object.keys(log).sort(), ['correlationId', 'errorClass', 'outcome']);
    assert.equal(log.correlationId, 'corr-1');
    assert.equal(log.errorClass, row.classified.stableClass);
    assert.equal(JSON.stringify(log).includes(CANARY), false, row.id);
    const wire = toPhase4bMcpWriteRequestError(row.classified);
    assert.equal(wire.wireCode, row.classified.jsonRpcCode);
    assert.equal(wire.message.includes(CANARY), false, row.id);
  }
});

test('facade maps every low-risk node-create code on the compat application path', async () => {
  let pending: Error | undefined;
  const fixture = createInMemoryWriteToolFixture({
    nodeCreateThrow: () => pending,
  });
  const facade = createWriteFacade(fixture.bundle.adapter);
  const context = appWriteContext();
  for (const row of mappedNodeCreateRows()) {
    pending = row.error;
    if (row.classified.outcome === 'dependency_error') {
      await assert.rejects(
        facade.callTool(context, 'nodes.create', nodeCreateArguments()),
        (error: unknown) => error instanceof Error && error.message === 'Internal error',
        row.id,
      );
      continue;
    }
    const result = await facade.callTool(context, 'nodes.create', nodeCreateArguments());
    const expected = toPhase4bMcpWriteRejectedResult(row.classified);
    assert.deepEqual(result, expected, row.id);
    assert.equal(JSON.stringify(result).includes(CANARY), false, row.id);
  }
});


function createWriteFacade(writeAdapter: Mcp20260728WriteToolAdapter) {
  const config = loadConfig(mcpEnv()).mcp!;
  const collectionProjection = unusedCollectionProjection();
  const snapshotProjection = unusedSnapshotProjection();
  const readSurface = createPhase4bMcpReadToolAdapter({
    collectionProjection,
    snapshotProjection,
    nodeProjection: unusedNodeProjection(),
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
  });
  return createPhase4bMcpApplicationFacadeFromColpAdapters({
    resourceIdentity: createPhase4bMcpResourceIdentity(config),
    collectionProjection,
    snapshotProjection,
    nodeProjection: unusedNodeProjection(),
    readToolAdapter: readSurface.adapter,
    writeToolAdapter: writeAdapter,
  });
}

function appWriteContext() {
  return createMcpApplicationContext({
    principal: Object.freeze({
      kind: 'authenticated' as const,
      principalId: AUTHENTICATED.principalId,
      clientId: AUTHENTICATED.clientId,
      credentialBindingId: AUTHENTICATED.credentialBindingId,
      resourceAudience: AUTHENTICATED.resourceAudience,
      securityEpoch: AUTHENTICATED.securityEpoch,
    }),
    scopes: CALL_SCOPES,
    abortSignal: new AbortController().signal,
    budgets: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    correlationId: 'cq04-facade',
    authorization: Object.freeze({ accountSubjectId: AUTHENTICATED.principalId }),
  });
}

function unusedCollectionProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new Error('unused');
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function unusedSnapshotProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('unused');
    },
    async readPage() {
      throw new Error('unused');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function unusedNodeProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('unused');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}
