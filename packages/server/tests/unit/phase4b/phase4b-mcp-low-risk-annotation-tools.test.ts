/**
 * T2 low-risk `annotations.create` / `annotations.update`: closed schema,
 * session-bound creator, dryRun never writes, conceal/stale stay leak-safe.
 */
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  createAuthenticatedBinding,
  type Mcp20260728RequestContext,
} from '@know-n/colp/mcp';
import { createMcpToolInputValidator, McpToolInputError } from '../../support/mcp-tool-schema-validator.js';
import {
  AnnotationCreateError,
  AnnotationUpdateError,
  type CreateAnnotationInput,
  type AnnotationMutationUnitOfWork,
  type UpdateAnnotationInput,
} from '../../../src/modules/collections/index.js';
import * as createAnnotationModule from '../../../src/modules/collections/application/create-annotation.js';
import {
  PHASE4B_MCP_ANNOTATIONS_CREATE_INPUT_SCHEMA,
  PHASE4B_MCP_ANNOTATIONS_UPDATE_INPUT_SCHEMA,
  PHASE4B_MCP_STALE_REVISION_MESSAGE,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  Phase4bMcpLowRiskNodeCreateError,
  canCallPhase4bMcpWriteTool,
  classifyPhase4bMcpWriteError,
  createPhase4bMcpLowRiskAnnotationCreateService,
  createPhase4bMcpLowRiskAnnotationUpdateService,
  createPhase4bMcpRequestContext,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
} from '../../../src/modules/mcp/index.js';
import { compatListedToolInputSchema } from '../../../src/transport/mcp/mcp-compat-write-adapter.js';
import {
  BINDING,
  CONTEXT as NODE_CONTEXT,
} from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const CONTEXT = Object.freeze({ ...NODE_CONTEXT, scope: Object.freeze(['annotations:write']) });

const COL_ID = 'collection-1';
const NODE_ID = 'node-1';
const ANN_ID = 'annotation-1';
const BASE_REVISION = 'rev-base-1';
const LEAK_ETAG = '"rev-LEAK-999"';
const CREATOR = Object.freeze({
  id: 'https://app.example.test/profiles/alice',
  name: 'Alice',
});

const createInputValidator = createMcpToolInputValidator(PHASE4B_MCP_ANNOTATIONS_CREATE_INPUT_SCHEMA);
const updateInputValidator = createMcpToolInputValidator(PHASE4B_MCP_ANNOTATIONS_UPDATE_INPUT_SCHEMA);

const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const AUTHENTICATED = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

function createApplyInput(
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: COL_ID,
    nodeId: NODE_ID,
    value: 'A useful note',
    ...extra,
  });
}

function updateApplyInput(
  patch: Readonly<Record<string, unknown>> = Object.freeze({ value: 'Updated note' }),
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: COL_ID,
    annotationId: ANN_ID,
    baseRevision: BASE_REVISION,
    patch,
    ...extra,
  });
}

function capturingUnitOfWork(probe: { uowCalls: number }): AnnotationMutationUnitOfWork {
  return Object.freeze({
    execute: async (work) => {
      probe.uowCalls += 1;
      return work({} as never);
    },
  });
}

function throwingUnitOfWork(
  error: unknown,
  probe: { uowCalls: number },
): AnnotationMutationUnitOfWork {
  return Object.freeze({
    execute: async () => {
      probe.uowCalls += 1;
      throw error;
    },
  });
}

function resolveCreator(
  creator: { readonly id: string; readonly name: string } | null = CREATOR,
) {
  return async () => creator;
}

function allowingInspect() {
  return Object.freeze({
    create: vi.fn(async (_input: CreateAnnotationInput) => undefined),
    update: vi.fn(async (_input: UpdateAnnotationInput) => undefined),
  });
}

function listContext(
  scope: readonly string[],
): Mcp20260728RequestContext {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/list' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/list',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({
            tools: Object.freeze({ call: true }),
          }),
        }),
      }),
    }),
    binding: AUTHENTICATED,
    scope,
    authorization: Object.freeze({}),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

function jsonSchemaFromCompatListed(
  compiled: ReturnType<typeof compatListedToolInputSchema>,
): Record<string, unknown> {
  const json = (compiled as {
    readonly '~standard': { readonly jsonSchema: { readonly input: () => unknown } };
  })['~standard'].jsonSchema.input();
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('expected JSON Schema object from compatListedToolInputSchema');
  }
  return json as Record<string, unknown>;
}

test('annotations.create schema rejects extra properties, public visibility, and html format', () => {
  const valid = createApplyInput();
  assert.doesNotThrow(() => createInputValidator(valid));
  assert.throws(
    () => createInputValidator({ ...valid, extra: true }),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => createInputValidator({ ...valid, creator: CREATOR }),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => createInputValidator(createApplyInput({ visibility: 'public' })),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => createInputValidator(createApplyInput({ format: 'html' })),
    (error: unknown) => error instanceof McpToolInputError,
  );
});

test('annotations.update schema rejects extra properties, empty patch, public visibility, and html format', () => {
  const valid = updateApplyInput();
  assert.doesNotThrow(() => updateInputValidator(valid));
  assert.throws(
    () => updateInputValidator({ ...valid, extra: true }),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => updateInputValidator(updateApplyInput(Object.freeze({}))),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => updateInputValidator(updateApplyInput(Object.freeze({ visibility: 'public' }))),
    (error: unknown) => error instanceof McpToolInputError,
  );
  assert.throws(
    () => updateInputValidator(updateApplyInput(Object.freeze({ format: 'html' }))),
    (error: unknown) => error instanceof McpToolInputError,
  );
});

test('annotations.create and annotations.update services reject extra properties and invalid catalog values', async () => {
  const probe = { uowCalls: 0 };
  const createService = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: capturingUnitOfWork(probe),
    resolveAnnotationCreator: resolveCreator(),
    inspect: allowingInspect(),
  });
  const updateService = createPhase4bMcpLowRiskAnnotationUpdateService({
    unitOfWork: capturingUnitOfWork(probe),
    inspect: allowingInspect(),
  });
  await assert.rejects(
    createService.execute({ ...createApplyInput(), extra: true }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  await assert.rejects(
    createService.execute(createApplyInput({ visibility: 'public' }), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  await assert.rejects(
    createService.execute(createApplyInput({ format: 'html' }), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  await assert.rejects(
    updateService.execute(updateApplyInput(Object.freeze({})), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  await assert.rejects(
    updateService.execute(updateApplyInput(Object.freeze({ visibility: 'public' })), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'invalid_catalog_input');
      return true;
    },
  );
  assert.equal(probe.uowCalls, 0);
});

test('annotations.create defaults type to note and visibility to private', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(createAnnotationModule, 'createAnnotation').mockResolvedValue({
    kind: 'created',
    annotation: {
      id: 'ann-created',
      collectionId: COL_ID,
      subject: { type: 'node', id: NODE_ID },
      type: 'note',
      revision: 'rev-next',
    } as never,
    operationId: 'op-1',
    commitOrdinal: 1n,
  });
  const service = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: capturingUnitOfWork(probe),
    resolveAnnotationCreator: resolveCreator(),
    inspect: allowingInspect(),
  });
  const output = await service.execute(createApplyInput(), CONTEXT);
  assert.equal(output.resultType, 'complete');
  if (output.resultType !== 'complete') return;
  assert.equal(output.type, 'note');
  assert.equal(spy.mock.calls[0]?.[1]?.annotation.type, 'note');
  assert.equal(spy.mock.calls[0]?.[1]?.annotation.visibility, 'private');
  assert.equal(spy.mock.calls[0]?.[1]?.annotation.format, 'plain');
});

test('annotations.create dryRun runs admission inspect without calling the mutator', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(createAnnotationModule, 'createAnnotation');
  const inspect = allowingInspect();
  const service = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: capturingUnitOfWork(probe),
    resolveAnnotationCreator: resolveCreator(),
    inspect,
  });
  const output = await service.execute(createApplyInput({ dryRun: true }), CONTEXT);
  assert.deepEqual(output, {
    resultType: 'preview',
    collectionId: COL_ID,
    nodeId: NODE_ID,
    type: 'note',
  });
  assert.equal('annotationId' in output, false);
  assert.equal('revision' in output, false);
  assert.equal(probe.uowCalls, 0);
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(inspect.create.mock.calls.length, 1);
  assert.deepEqual(inspect.create.mock.calls[0]?.[0].annotation.subject, {
    type: 'node',
    id: NODE_ID,
  });
});

test('annotation dryRun fails closed on missing create target and stale update revision', async () => {
  const probe = { uowCalls: 0 };
  const createInspect = allowingInspect();
  createInspect.create.mockRejectedValueOnce(
    new AnnotationCreateError('annotation_not_found', 'Annotation subject was not found.'),
  );
  const createService = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: capturingUnitOfWork(probe),
    resolveAnnotationCreator: resolveCreator(),
    inspect: createInspect,
  });
  await assert.rejects(
    createService.execute(createApplyInput({ dryRun: true }), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'policy_denied');
      return true;
    },
  );

  const updateInspect = allowingInspect();
  updateInspect.update.mockRejectedValueOnce(new AnnotationUpdateError(
    'annotation_precondition_failed',
    'Annotation changed before this patch was applied.',
    LEAK_ETAG,
  ));
  const updateService = createPhase4bMcpLowRiskAnnotationUpdateService({
    unitOfWork: capturingUnitOfWork(probe),
    inspect: updateInspect,
  });
  await assert.rejects(
    updateService.execute(updateApplyInput(undefined, { dryRun: true }), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'stale_revision');
      assert.equal(JSON.stringify(error).includes('LEAK'), false);
      return true;
    },
  );
  assert.equal(probe.uowCalls, 0);
  assert.equal(createInspect.create.mock.calls.length, 1);
  assert.equal(updateInspect.update.mock.calls.length, 1);
});

test('annotations.create omit dryRun calls createAnnotation with a node subject and session-bound creator', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(createAnnotationModule, 'createAnnotation').mockResolvedValue({
    kind: 'created',
    annotation: {
      id: 'ann-created',
      collectionId: COL_ID,
      subject: { type: 'node', id: NODE_ID },
      type: 'note',
      revision: 'rev-applied',
    } as never,
    operationId: 'op-1',
    commitOrdinal: 1n,
  });
  const service = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: capturingUnitOfWork(probe),
    resolveAnnotationCreator: resolveCreator(),
    inspect: allowingInspect(),
  });
  const output = await service.execute(createApplyInput(), CONTEXT);
  assert.equal(output.resultType, 'complete');
  if (output.resultType !== 'complete') return;
  assert.equal(output.annotationId, 'ann-created');
  assert.equal(output.collectionId, COL_ID);
  assert.equal(output.nodeId, NODE_ID);
  assert.equal(output.revision, 'rev-applied');
  assert.equal(probe.uowCalls, 1);
  assert.equal(spy.mock.calls.length, 1);
  const input = spy.mock.calls[0]?.[1];
  assert.deepEqual(input?.annotation.subject, { type: 'node', id: NODE_ID });
  assert.deepEqual(input?.actor.creator, CREATOR);
  assert.equal(Object.hasOwn(input?.annotation ?? {}, 'creator'), false);
  assert.equal(input?.actor.principalId, BINDING.principalId);
});

test('annotations.create missing profile is policy_denied', async () => {
  const probe = { uowCalls: 0 };
  const spy = vi.spyOn(createAnnotationModule, 'createAnnotation');
  const service = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: capturingUnitOfWork(probe),
    resolveAnnotationCreator: resolveCreator(null),
    inspect: allowingInspect(),
  });
  await assert.rejects(
    service.execute(createApplyInput(), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'policy_denied');
      assert.equal(
        error.message,
        'A public profile handle is required before creating an annotation.',
      );
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'policy_rejected');
      assert.notEqual(classified.stableClass, 'internal_error');
      return true;
    },
  );
  assert.equal(probe.uowCalls, 0);
  assert.equal(spy.mock.calls.length, 0);
});

test('annotations.update stale precondition classifies without current etag or revision token', async () => {
  const probe = { uowCalls: 0 };
  const service = createPhase4bMcpLowRiskAnnotationUpdateService({
    unitOfWork: throwingUnitOfWork(
      new AnnotationUpdateError(
        'annotation_precondition_failed',
        'Annotation changed before this patch was applied.',
        LEAK_ETAG,
      ),
      probe,
    ),
    inspect: allowingInspect(),
  });
  await assert.rejects(
    service.execute(updateApplyInput(), CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'stale_revision');
      assert.equal(error.message, PHASE4B_MCP_STALE_REVISION_MESSAGE);
      assert.equal(error.message.includes('LEAK'), false);
      assert.equal(JSON.stringify(error).includes('LEAK'), false);
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'stale_revision');
      assert.equal(classified.safeMessage, PHASE4B_MCP_STALE_REVISION_MESSAGE);
      assert.equal(classified.safeMessage.includes('LEAK'), false);
      const wire = toPhase4bMcpWriteRequestError(classified, writeErrorHintFrom(error));
      assert.equal(JSON.stringify(wire).includes('LEAK'), false);
      assert.equal(JSON.stringify(wire).includes(ANN_ID), false);
      return true;
    },
  );
  assert.equal(probe.uowCalls, 1);
});

test('annotations.update not found is policy_denied, not Internal error', async () => {
  const probe = { uowCalls: 0 };
  const secretId = 'ann-secret-id-999';
  const service = createPhase4bMcpLowRiskAnnotationUpdateService({
    unitOfWork: throwingUnitOfWork(
      new AnnotationUpdateError('annotation_not_found', `Annotation ${secretId} was not found.`),
      probe,
    ),
    inspect: allowingInspect(),
  });
  await assert.rejects(
    service.execute({
      ...updateApplyInput(),
      annotationId: secretId,
    }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, 'policy_denied');
      assert.equal(error.message.includes(secretId), false);
      const classified = classifyPhase4bMcpWriteError(error);
      assert.equal(classified.stableClass, 'policy_rejected');
      assert.notEqual(classified.stableClass, 'internal_error');
      assert.equal(classified.safeMessage, 'Write policy rejected this request.');
      const wire = toPhase4bMcpWriteRequestError(classified, writeErrorHintFrom(error));
      assert.equal(JSON.stringify(wire).includes(secretId), false);
      assert.notEqual(classified.safeMessage, 'Internal error');
      return true;
    },
  );
});

test('catalog lists annotations.create and annotations.update when annotations:write is present', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const listed = await fixture.bundle.adapter.listTools(
    listContext(['annotations:write']),
    {},
  );
  const names = (listed.tools as ReadonlyArray<{ readonly name: string }>).map((tool) => tool.name);
  assert.equal(names.includes('annotations.create'), true);
  assert.equal(names.includes('annotations.update'), true);
  assert.deepEqual(
    [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].filter((name) => name.startsWith('annotations.')),
    ['annotations.create', 'annotations.update'],
  );
  assert.equal(
    canCallPhase4bMcpWriteTool(listContext(['annotations:write']), 'annotations.create'),
    true,
  );
  assert.equal(
    canCallPhase4bMcpWriteTool(listContext(['annotations:write']), 'annotations.update'),
    true,
  );
  assert.equal(
    canCallPhase4bMcpWriteTool(listContext(['mcp:read:own']), 'annotations.create'),
    false,
  );
});

test('compat listed annotation schemas have no x-mcp-header', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const listed = await fixture.bundle.adapter.listTools(
    listContext(['annotations:write']),
    {},
  );
  const tools = listed.tools as ReadonlyArray<{
    readonly name: string;
    readonly inputSchema?: Readonly<Record<string, unknown>>;
  }>;
  for (const name of ['annotations.create', 'annotations.update'] as const) {
    const tool = tools.find((entry) => toolName(entry) === name);
    assert.ok(tool, name);
    const collectionId = (tool!.inputSchema?.properties as {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
    } | undefined)?.collectionId;
    assert.equal(collectionId?.['x-mcp-header'], 'X-Collection-Id');
    const stripped = jsonSchemaFromCompatListed(compatListedToolInputSchema({
      name,
      description: `Write tool ${name}`,
      inputSchema: tool!.inputSchema as Readonly<Record<string, unknown>>,
      requiredScopes: Object.freeze(['nodes:write']),
    }));
    const strippedHeader = (stripped.properties as {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
    } | undefined)?.collectionId?.['x-mcp-header'];
    assert.equal(strippedHeader, undefined);
    assert.equal(JSON.stringify(stripped).includes('x-mcp-header'), false);
  }
});

function toolName(tool: { readonly name: string }): string {
  return tool.name;
}
