import { createPhase4bMcpResult } from './results.js';
import type { Phase4bMcpChangePlanService } from './change-plan-service.js';
import { MCP_OWN_DATA_DEFAULT_BUDGET, snapshotMcpOwnData as snapshotPhase4bData } from './own-data.js';
/**
 * MCP-W06 host composition for the Modern `2026-07-28` Write Tools mount.
 *
 * This module owns the host boundary between the production MCP transport and
 * COLP-MCP-13's `createMcp20260728WriteToolAdapter`. It registers the frozen
 * low-risk node-creation Tool. `nodes.move` is mounted beside it but is medium
 * risk: every call is a change plan, never a direct write.
 * `nodes.set_visibility` remains a catalog/plan operation, not a direct mounted
 * Tool. It also provides the W02 plan-status
 * resolver backing server-minted MRTR `requestState`, and keeps dynamic scope
 * filtering in one place so the transport cannot accidentally expose Write Tools
 * to anonymous, read-only, or empty-scope requests.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  createMcp20260728WriteToolAdapter,
  requireAuthenticatedWriteBinding,
  scanMcp20260728XMcpHeaderDeclarations,
  snapshotMcpAuthorizationBinding,
  type Mcp20260728PlanResolution,
  type Mcp20260728RequestContext,
  type Mcp20260728Result,
  type Mcp20260728WritePlanStatusPort,
  type Mcp20260728WriteToolAdapter,
  type Mcp20260728XMcpHeaderDeclaration,
  type Mcp20260728XMcpHeaderScanResult,
  type McpAuthenticatedAuthorizationBinding,
  type McpChangePlanServiceOptions,
  type McpChangePlanRevisionPort,
  type McpLowRiskToolDefinition,
  type McpStoredPlan,
  type McpWriteInputBudget,
} from '@know-n/colp/mcp';
import { canonicalJson } from '../commands/index.js';
import { ANNOTATION_MAX_VALUE_BYTES } from '../collections/index.js';
import { PHASE4B_MCP_WRITE_SERVER_INFO } from './discovery.js';
import {
  PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE,
  PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT,
  type Phase4bMcpLowRiskNodeCreateRequest,
  type Phase4bMcpLowRiskNodeCreateService,
} from './low-risk-node-create.js';
import {
  PHASE4B_MCP_NODES_UPDATE_TOOL_NAME,
  type Phase4bMcpLowRiskNodeUpdateService,
} from './low-risk-node-update.js';
import {
  PHASE4B_MCP_COLLECTIONS_UPDATE_OUTPUT_SCHEMA,
  PHASE4B_MCP_COLLECTIONS_UPDATE_PATCH_SCHEMA,
  PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME,
  type Phase4bMcpLowRiskCollectionUpdateService,
} from './low-risk-collection-update.js';
import {
  PHASE4B_MCP_ANNOTATION_FORMATS,
  PHASE4B_MCP_ANNOTATION_TYPES,
  PHASE4B_MCP_ANNOTATION_VISIBILITIES,
  PHASE4B_MCP_ANNOTATIONS_CREATE_OUTPUT_SCHEMA,
  PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
  PHASE4B_MCP_ANNOTATIONS_UPDATE_OUTPUT_SCHEMA,
  PHASE4B_MCP_ANNOTATIONS_UPDATE_PATCH_SCHEMA,
  PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
  type Phase4bMcpLowRiskAnnotationCreateService,
  type Phase4bMcpLowRiskAnnotationUpdateService,
} from './low-risk-annotation-tools.js';
import {
  PHASE4B_MCP_CHANGES_GET_INPUT_SCHEMA,
  PHASE4B_MCP_CHANGES_GET_OUTPUT_SCHEMA,
  PHASE4B_MCP_CHANGES_GET_TOOL_NAME,
  type Phase4bMcpLowRiskChangeGetService,
} from './low-risk-change-get.js';
import {
  PHASE4B_MCP_COLLECTIONS_CREATE_INPUT_SCHEMA,
  PHASE4B_MCP_COLLECTIONS_CREATE_OUTPUT_SCHEMA,
  PHASE4B_MCP_COLLECTIONS_CREATE_TOOL_NAME,
  type Phase4bMcpOwnedCollectionCreateService,
} from './owned-collection-mcp.js';
import {
  classifyPhase4bMcpWriteError,
  rethrowPhase4bMcpWriteAdapterError,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
} from './write-error-classifier.js';
import {
  PHASE4B_MCP_NODE_CREATE_DEFAULT_REASON,
  PHASE4B_MCP_NODE_CREATE_NODE_SCHEMA,
  PHASE4B_MCP_NODE_UPDATE_PATCH_SCHEMA,
} from './node-create-catalog.js';
import {
  readMcpAccountSubjectId,
  requireMcpAccountSubjectId,
  runWithMcpAccountSubjectId,
} from './account-context.js';

export const PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER = 'X-Collection-Id' as const;

export const PHASE4B_MCP_CHANGES_PLAN_DESCRIPTION =
  'Create a pending high-risk Change Plan. dryRun must be true and stores a real plan that needs out-of-band approval; apply with changes.commit. Collection public/unlisted uses the collection resource fence; node protected/private uses the node revision.';

export const PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES: readonly [
  'collections.create',
  'collections.update',
  'nodes.create',
  'nodes.move',
  'nodes.delete_subtree',
  'nodes.update',
  'annotations.create',
  'annotations.update',
  'changes.plan',
  'changes.commit',
  'changes.cancel',
  'changes.get',
] = Object.freeze([
  PHASE4B_MCP_COLLECTIONS_CREATE_TOOL_NAME,
  PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME,
  'nodes.create',
  'nodes.move',
  'nodes.delete_subtree',
  PHASE4B_MCP_NODES_UPDATE_TOOL_NAME,
  PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
  PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
  'changes.plan',
  'changes.commit',
  'changes.cancel',
  PHASE4B_MCP_CHANGES_GET_TOOL_NAME,
]);

export const PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES: Readonly<
  Record<Phase4bMcpWriteToolName, readonly string[]>
> = Object.freeze({
  'collections.create': Object.freeze(['collections:create']),
  'collections.update': Object.freeze(['collections:write']),
  'nodes.create': Object.freeze([PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE]),
  'nodes.move': Object.freeze(['nodes:write']),
  'nodes.delete_subtree': Object.freeze(['nodes:write']),
  'nodes.update': Object.freeze([PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE]),
  'annotations.create': Object.freeze(['annotations:write']),
  'annotations.update': Object.freeze(['annotations:write']),
  'changes.plan': Object.freeze(['nodes:write', 'access:write']),
  'changes.commit': Object.freeze(['nodes:write', 'access:write', 'changes:commit']),
  'changes.cancel': Object.freeze(['changes:cancel']),
  'changes.get': Object.freeze([PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE]),
});

export type Phase4bMcpWriteToolName = (typeof PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES)[number];

const writeCollectionIdProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 1_024,
  'x-mcp-header': PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
} as const);

const opaqueIdProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._~-]+$',
} as const);

const nodeCreateProperties = Object.freeze({
  collectionId: writeCollectionIdProperty,
  parentId: opaqueIdProperty,
  afterId: Object.freeze({ oneOf: Object.freeze([
    Object.freeze({ type: 'null' }),
    opaqueIdProperty,
  ]) }),
  beforeId: Object.freeze({ oneOf: Object.freeze([
    Object.freeze({ type: 'null' }),
    opaqueIdProperty,
  ]) }),
  node: PHASE4B_MCP_NODE_CREATE_NODE_SCHEMA,
  reason: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_000 }),
  dryRun: Object.freeze({
    const: true,
    description: 'Preview without writing.',
  }),
  confirmApply: Object.freeze({
    type: 'boolean',
    description: 'Set false to preview without writing. Omit or set true to apply unless dryRun is true.',
  }),
} as const);

const nodeCreateInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: nodeCreateProperties,
  required: Object.freeze(['collectionId', 'node']),
} as const);

const nodeMoveInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    nodeId: opaqueIdProperty,
    collectionId: opaqueIdProperty,
    parentId: opaqueIdProperty,
    position: Object.freeze({
      type: 'integer',
      minimum: 0,
      maximum: 100_000,
    }),
  }),
  required: Object.freeze(['nodeId', 'parentId']),
} as const);

const nodeMoveOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    planId: Object.freeze({ type: 'string', minLength: 1 }),
    risk: Object.freeze({ enum: ['medium', 'high'] }),
    requiresApproval: Object.freeze({ type: 'boolean' }),
    status: Object.freeze({ enum: ['pending', 'consumed'] }),
    approvedBy: Object.freeze({ const: 'policy' }),
    versionId: Object.freeze({ type: 'string' }),
    impact: Object.freeze({
      type: 'array',
      items: Object.freeze({ type: 'string' }),
    }),
    operations: Object.freeze({ type: 'array' }),
  }),
  required: Object.freeze(['planId', 'risk', 'requiresApproval', 'impact', 'operations']),
} as const);

const nodeCreateOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    resultType: Object.freeze({ type: 'string', enum: Object.freeze(['complete', 'preview']) }),
    outputContract: Object.freeze({ const: PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT }),
    receipt: Object.freeze({ type: 'object' }),
    node: Object.freeze({ type: 'object' }),
    parent: Object.freeze({ type: 'object' }),
    fence: Object.freeze({ type: 'object' }),
    appliedVisibility: Object.freeze({
      type: 'string',
      enum: Object.freeze(['inherit', 'protected', 'private']),
    }),
  }),
  required: Object.freeze([
    'resultType',
    'outputContract',
    'node',
    'parent',
    'fence',
  ]),
  oneOf: Object.freeze([
    Object.freeze({
      properties: Object.freeze({
        resultType: Object.freeze({ const: 'complete' }),
      }),
      required: Object.freeze(['receipt']),
    }),
    Object.freeze({
      properties: Object.freeze({
        resultType: Object.freeze({ const: 'preview' }),
      }),
      not: Object.freeze({
        required: Object.freeze(['receipt']),
      }),
    }),
  ]),
} as const);

export const PHASE4B_MCP_NODES_CREATE_INPUT_SCHEMA = nodeCreateInputSchema;
export const PHASE4B_MCP_NODES_CREATE_OUTPUT_SCHEMA = nodeCreateOutputSchema;

const revisionTokenProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 1_024,
} as const);

const nodeUpdateInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: writeCollectionIdProperty,
    nodeId: opaqueIdProperty,
    baseRevision: revisionTokenProperty,
    ifMatch: revisionTokenProperty,
    patch: PHASE4B_MCP_NODE_UPDATE_PATCH_SCHEMA,
    dryRun: Object.freeze({ const: true }),
    reason: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_000 }),
  }),
  required: Object.freeze(['collectionId', 'nodeId', 'patch']),
  anyOf: Object.freeze([
    Object.freeze({ required: Object.freeze(['baseRevision']) }),
    Object.freeze({ required: Object.freeze(['ifMatch']) }),
  ]),
} as const);

const nodeUpdateOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    resultType: Object.freeze({ type: 'string', enum: Object.freeze(['complete', 'preview']) }),
    nodeId: Object.freeze({ type: 'string', minLength: 1 }),
    collectionId: Object.freeze({ type: 'string', minLength: 1 }),
    revision: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze(['resultType', 'nodeId', 'collectionId']),
  oneOf: Object.freeze([
    Object.freeze({
      properties: Object.freeze({
        resultType: Object.freeze({ const: 'complete' }),
      }),
      required: Object.freeze(['revision']),
    }),
    Object.freeze({
      properties: Object.freeze({
        resultType: Object.freeze({ const: 'preview' }),
      }),
      not: Object.freeze({
        required: Object.freeze(['revision']),
      }),
    }),
  ]),
} as const);

const collectionUpdateInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: writeCollectionIdProperty,
    baseRevision: revisionTokenProperty,
    ifMatch: revisionTokenProperty,
    patch: PHASE4B_MCP_COLLECTIONS_UPDATE_PATCH_SCHEMA,
    dryRun: Object.freeze({ const: true }),
  }),
  required: Object.freeze(['collectionId', 'patch']),
  anyOf: Object.freeze([
    Object.freeze({ required: Object.freeze(['baseRevision']) }),
    Object.freeze({ required: Object.freeze(['ifMatch']) }),
  ]),
} as const);

export const PHASE4B_MCP_NODES_UPDATE_INPUT_SCHEMA = nodeUpdateInputSchema;
export const PHASE4B_MCP_NODES_UPDATE_OUTPUT_SCHEMA = nodeUpdateOutputSchema;
export const PHASE4B_MCP_COLLECTIONS_UPDATE_INPUT_SCHEMA = collectionUpdateInputSchema;

const annotationCreateInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: writeCollectionIdProperty,
    nodeId: opaqueIdProperty,
    value: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: ANNOTATION_MAX_VALUE_BYTES,
    }),
    type: Object.freeze({ type: 'string', enum: PHASE4B_MCP_ANNOTATION_TYPES }),
    format: Object.freeze({ type: 'string', enum: PHASE4B_MCP_ANNOTATION_FORMATS }),
    visibility: Object.freeze({ type: 'string', enum: PHASE4B_MCP_ANNOTATION_VISIBILITIES }),
    dryRun: Object.freeze({ const: true }),
  }),
  required: Object.freeze(['collectionId', 'nodeId', 'value']),
} as const);

const annotationUpdateInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: writeCollectionIdProperty,
    annotationId: opaqueIdProperty,
    baseRevision: revisionTokenProperty,
    ifMatch: revisionTokenProperty,
    patch: PHASE4B_MCP_ANNOTATIONS_UPDATE_PATCH_SCHEMA,
    dryRun: Object.freeze({ const: true }),
  }),
  required: Object.freeze(['collectionId', 'annotationId', 'patch']),
  anyOf: Object.freeze([
    Object.freeze({ required: Object.freeze(['baseRevision']) }),
    Object.freeze({ required: Object.freeze(['ifMatch']) }),
  ]),
} as const);

export const PHASE4B_MCP_ANNOTATIONS_CREATE_INPUT_SCHEMA = annotationCreateInputSchema;
export const PHASE4B_MCP_ANNOTATIONS_UPDATE_INPUT_SCHEMA = annotationUpdateInputSchema;

const nodeCreateHeaderScan = scanMcp20260728XMcpHeaderDeclarations(nodeCreateInputSchema);
const nodeUpdateHeaderScan = scanMcp20260728XMcpHeaderDeclarations(nodeUpdateInputSchema);
const collectionUpdateHeaderScan = scanMcp20260728XMcpHeaderDeclarations(collectionUpdateInputSchema);
const annotationCreateHeaderScan = scanMcp20260728XMcpHeaderDeclarations(annotationCreateInputSchema);
const annotationUpdateHeaderScan = scanMcp20260728XMcpHeaderDeclarations(annotationUpdateInputSchema);
if (
  !nodeCreateHeaderScan.valid
  || !nodeUpdateHeaderScan.valid
  || !collectionUpdateHeaderScan.valid
  || !annotationCreateHeaderScan.valid
  || !annotationUpdateHeaderScan.valid
) {
  throw new TypeError('MCP-W06 low-risk Tool schemas contain invalid Mcp-Param-* declarations.');
}

function freezeHeaderDeclarations(
  scan: Mcp20260728XMcpHeaderScanResult,
): readonly Mcp20260728XMcpHeaderDeclaration[] {
  if (!scan.valid) {
    throw new TypeError('MCP-W06 low-risk Tool schemas contain invalid Mcp-Param-* declarations.');
  }
  return Object.freeze(
    scan.declarations.map(
      (declaration) => Object.freeze({
        path: Object.freeze([...declaration.path]),
        headerName: declaration.headerName,
        type: declaration.type,
      }),
    ),
  );
}

export const PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS: readonly Mcp20260728XMcpHeaderDeclaration[] =
  mergePhase4bMcpParamDeclarations(
    freezeHeaderDeclarations(nodeCreateHeaderScan),
    freezeHeaderDeclarations(nodeUpdateHeaderScan),
    freezeHeaderDeclarations(collectionUpdateHeaderScan),
    freezeHeaderDeclarations(annotationCreateHeaderScan),
    freezeHeaderDeclarations(annotationUpdateHeaderScan),
  );

export interface Phase4bMcpWriteToolAdapterBundle {
  readonly adapter: Mcp20260728WriteToolAdapter;
  readonly paramDeclarations: readonly Mcp20260728XMcpHeaderDeclaration[];
  readonly toolNames: typeof PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES;
}

export interface Phase4bMcpWriteToolAdapterOptions {
  /** Protocol-neutral COLP Change Plan service options backed by W02/W05 ports. */
  readonly changePlan: McpChangePlanServiceOptions;
  readonly planCatalog?: Pick<Phase4bMcpChangePlanService, 'plan'>;
  /** W04 low-risk Canonical Node create application service. */
  readonly nodeCreateService: Phase4bMcpLowRiskNodeCreateService;
  /** Private Collection create; always `visibility: private`. */
  readonly collectionCreateService: Phase4bMcpOwnedCollectionCreateService;
  /** Low-risk node merge-patch update. */
  readonly nodeUpdateService: Phase4bMcpLowRiskNodeUpdateService;
  /** Low-risk collection title/summary update. */
  readonly collectionUpdateService: Phase4bMcpLowRiskCollectionUpdateService;
  /** Low-risk annotation create; subject is a node. */
  readonly annotationCreateService: Phase4bMcpLowRiskAnnotationCreateService;
  /** Low-risk annotation merge-patch update. */
  readonly annotationUpdateService: Phase4bMcpLowRiskAnnotationUpdateService;
  /** Low-risk read of the current account's change plan. */
  readonly changeGetService: Phase4bMcpLowRiskChangeGetService;
  /** Host resolver mapping W02 Plan status for MRTR requestState retries. */
  readonly resolvePlan: Mcp20260728WritePlanStatusPort;
  /** HMAC key (string or raw bytes, >= 32 bytes) for server-minted requestState. */
  readonly requestStateKey: string | Uint8Array;
  readonly requestStateTtlSeconds?: number;
  readonly requestStateClock?: () => number;
  readonly inputBudget?: McpWriteInputBudget;
}

/**
 * Builds a frozen, stateless Write adapter for concurrent per-request authorization.
 */
export function createPhase4bMcpWriteToolAdapter(
  options: Phase4bMcpWriteToolAdapterOptions,
): Phase4bMcpWriteToolAdapterBundle {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP-W06 Write adapter options must be an own-data object.');
  }
  const adapter = withMcpAccountSubject(createMcp20260728WriteToolAdapter({
    changePlan: readRequiredOwnData(options, 'changePlan') as McpChangePlanServiceOptions,
    lowRiskTools: Object.freeze({
      [PHASE4B_MCP_COLLECTIONS_CREATE_TOOL_NAME]: createCollectionCreateDefinition(
        readRequiredOwnData(options, 'collectionCreateService') as Phase4bMcpOwnedCollectionCreateService,
      ),
      [PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME]: createCollectionUpdateDefinition(
        readRequiredOwnData(options, 'collectionUpdateService') as Phase4bMcpLowRiskCollectionUpdateService,
      ),
      'nodes.create': createNodeCreateDefinition(
        readRequiredOwnData(options, 'nodeCreateService') as Phase4bMcpLowRiskNodeCreateService,
      ),
      'nodes.move': createNodeMoveDefinition(),
      'nodes.delete_subtree': createNodeDeleteSubtreeDefinition(),
      [PHASE4B_MCP_NODES_UPDATE_TOOL_NAME]: createNodeUpdateDefinition(
        readRequiredOwnData(options, 'nodeUpdateService') as Phase4bMcpLowRiskNodeUpdateService,
      ),
      [PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME]: createAnnotationCreateDefinition(
        readRequiredOwnData(options, 'annotationCreateService') as Phase4bMcpLowRiskAnnotationCreateService,
      ),
      [PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME]: createAnnotationUpdateDefinition(
        readRequiredOwnData(options, 'annotationUpdateService') as Phase4bMcpLowRiskAnnotationUpdateService,
      ),
      [PHASE4B_MCP_CHANGES_GET_TOOL_NAME]: createChangeGetDefinition(
        readRequiredOwnData(options, 'changeGetService') as Phase4bMcpLowRiskChangeGetService,
      ),
    }),
    serverInfo: PHASE4B_MCP_WRITE_SERVER_INFO,
    resolvePlan: readRequiredOwnData(options, 'resolvePlan') as Mcp20260728WritePlanStatusPort,
    requestStateKey: readRequiredOwnData(options, 'requestStateKey') as string | Uint8Array,
    cache: Object.freeze({ 'tools/list': Object.freeze({ ttlMs: 0, cacheScope: 'private' }) }),
    ...readOptionalWriteAdapterOptions(options),
  }), options.planCatalog, options.changePlan.revisions);
  return Object.freeze({
    adapter,
    paramDeclarations: PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS,
    toolNames: PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  });
}

function bindMcpAccountSubject<T>(
  context: Mcp20260728RequestContext,
  work: () => T,
): T {
  const accountSubjectId = readMcpAccountSubjectId(context.authorization);
  if (accountSubjectId === undefined) {
    return work();
  }
  return runWithMcpAccountSubjectId(accountSubjectId, work);
}

function withMcpAccountSubject(
  adapter: Mcp20260728WriteToolAdapter,
  planCatalog?: Pick<Phase4bMcpChangePlanService, 'plan'>,
  planRevisions?: McpChangePlanRevisionPort,
): Mcp20260728WriteToolAdapter {
  const wrapped: Mcp20260728WriteToolAdapter = {
    listTools: (context, input) =>
      bindMcpAccountSubject(context, async () => {
        const listed = await adapter.listTools(context, input);
        return withHostWriteToolDescriptions(listed);
      }),
    callTool: (context, input) =>
      bindMcpAccountSubject(context, async () => {
        const call = snapshotPhase4bData(input, MCP_OWN_DATA_DEFAULT_BUDGET) as Record<string, unknown>;
        if (call.name === 'changes.plan' && planRevisions && canCallPhase4bMcpWriteTool(context, 'changes.plan')) {
          await adapter.listTools(context, {});
          const args = call.arguments as { operations?: readonly unknown[] };
          for (const operation of Array.isArray(args?.operations) ? args.operations : []) {
            if (operation && typeof operation === 'object' && (operation as { type?: string }).type === 'set_visibility') {
              await planRevisions.resolveBaseRevisions(
                operation as Parameters<McpChangePlanRevisionPort['resolveBaseRevisions']>[0],
                requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(context.binding)),
              );
            }
          }
        }
        if (planCatalog && (call.name === 'nodes.move' || call.name === 'nodes.delete_subtree')) {
          await adapter.listTools(context, {});
          if (!canCallPhase4bMcpWriteTool(context, call.name)) {
            throw new TypeError('Missing nodes:write scope.');
          }
          const args = snapshotPhase4bData(call.arguments, MCP_OWN_DATA_DEFAULT_BUDGET) as Record<string, unknown>;
          const plan = await planCatalog.plan({
            ...args, tool: call.name, dryRun: true, reason: call.name,
          }, requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(context.binding)));
          return createPhase4bMcpResult({ method: 'tools/call', fields: { structuredContent: {
            planId: plan.planId, risk: plan.risk, requiresApproval: plan.requiresApproval,
            impact: plan.operations.map((operation) => (operation as { impact: string }).impact), operations: plan.operations,
            status: plan.status, ...(plan.approvedBy ? { approvedBy: plan.approvedBy } : {}),
            ...(plan.versionId ? { versionId: plan.versionId } : {}),
          } }, cache: { ttlMs: 0, cacheScope: 'private' } }, true);
        }
        return adapter.callTool(context, input);
      }).catch(rethrowPhase4bMcpWriteAdapterError),
    recordOutOfBandApproval: (planId, context) =>
      bindMcpAccountSubject(context, () => adapter.recordOutOfBandApproval(planId, context)),
    transportRequirements: adapter.transportRequirements,
  };
  return Object.freeze(wrapped);
}

function withHostWriteToolDescriptions(listed: Mcp20260728Result): Mcp20260728Result {
  const tools = listed.tools;
  if (!Array.isArray(tools)) return listed;
  return Object.freeze({
    ...listed,
    tools: Object.freeze(tools.map((tool) => {
      if (
        typeof tool === 'object'
        && tool !== null
        && (tool as { name?: unknown }).name === 'changes.plan'
      ) {
        return Object.freeze({
          ...(tool as Record<string, unknown>),
          description: PHASE4B_MCP_CHANGES_PLAN_DESCRIPTION,
        });
      }
      return tool;
    })),
  });
}

/**
 * Returns true only for authenticated requests carrying at least one scope
 * from the W01 Write catalog. Anonymous and empty-scope requests never see or
 * call Write Tools.
 */
export function canAccessPhase4bMcpWriteTools(
  context: Mcp20260728RequestContext,
): boolean {
  if (context.binding.kind !== 'authenticated') return false;
  return hasAnyPhase4bMcpWriteScope(context.scope);
}

export function canCallPhase4bMcpWriteTool(
  context: Mcp20260728RequestContext,
  name: string,
): boolean {
  if (context.binding.kind !== 'authenticated') return false;
  const required = PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES[name as Phase4bMcpWriteToolName];
  if (required === undefined) return false;
  return required.every((scope) => context.scope.includes(scope));
}

export function hasAnyPhase4bMcpWriteScope(scope: readonly string[]): boolean {
  const owned = new Set(scope);
  for (const name of PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES) {
    if (PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES[name].some((entry) => owned.has(entry))) {
      return true;
    }
  }
  return false;
}

export function filterPhase4bMcpWriteTools(
  tools: readonly Readonly<Record<string, unknown>>[],
  scope: readonly string[],
): readonly Readonly<Record<string, unknown>>[] {
  const owned = new Set(scope);
  return tools.filter((tool) => {
    const name = tool.name;
    if (typeof name !== 'string') return false;
    const required = PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES[name as Phase4bMcpWriteToolName];
    return required !== undefined && required.every((entry) => owned.has(entry));
  });
}

export function mergePhase4bMcpParamDeclarations(
  ...groups: readonly (readonly Mcp20260728XMcpHeaderDeclaration[])[]
): readonly Mcp20260728XMcpHeaderDeclaration[] {
  const seen = new Set<string>();
  const result: Mcp20260728XMcpHeaderDeclaration[] = [];
  for (const group of groups) {
    for (const declaration of group) {
      const key = `${declaration.headerName.toLowerCase()}\0${declaration.path.join('/')}\0${declaration.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(Object.freeze({
        path: Object.freeze([...declaration.path]),
        headerName: declaration.headerName,
        type: declaration.type,
      }));
    }
  }
  return Object.freeze(result);
}

export interface Phase4bMcpWritePlanStorePort {
  readonly get: (
    planId: string,
  ) => McpStoredPlan | undefined | PromiseLike<McpStoredPlan | undefined>;
}

/**
 * Maps W02 durable Plan rows to the COLP MRTR status resolver. It also
 * validates the stored authorization binding so requestState never resolves a
 * Plan across principals, clients, credentials, audiences, or security epochs.
 */
export function createPhase4bMcpWritePlanStatusPort(
  planStore: Phase4bMcpWritePlanStorePort,
  now: () => number = () => Date.now(),
): Mcp20260728WritePlanStatusPort {
  if (typeof planStore !== 'object' || planStore === null || nodeTypes.isProxy(planStore)) {
    throw new TypeError('MCP-W06 plan status port requires an own-data plan store.');
  }
  return Object.freeze({
    async resolvePlan(
      planId: string,
      binding: McpAuthenticatedAuthorizationBinding,
    ): Promise<Mcp20260728PlanResolution> {
      const plan = await planStore.get(planId);
      if (plan === undefined || !bindingsEqual(plan.binding, binding)) {
        return Object.freeze({ status: 'unknown' });
      }
      const expired = (plan.status === 'pending' || plan.status === 'approved')
        && Date.parse(plan.expiresAt) <= now();
      if (expired) return Object.freeze({ status: 'expired' });
      const projected = projectPhase4bMcpPlan(plan);
      return Object.freeze({
        status: plan.status,
        plan: projected,
      });
    },
  });
}

export function projectPhase4bMcpPlan(
  plan: McpStoredPlan,
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {
    planId: plan.planId,
    expiresAt: plan.expiresAt,
    risk: plan.risk,
    requiresApproval: plan.requiresApproval,
    summary: plan.summary,
    impact: plan.impact,
    requiredScopes: [...plan.requiredScopes],
    baseRevisions: { ...plan.baseRevisions },
  };
  if (plan.approvalMethod !== undefined) projected.approvalMethod = plan.approvalMethod;
  if (plan.approvalUri !== undefined) projected.approvalUri = plan.approvalUri;
  return Object.freeze(projected);
}

function createCollectionCreateDefinition(
  service: Phase4bMcpOwnedCollectionCreateService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: PHASE4B_MCP_COLLECTIONS_CREATE_INPUT_SCHEMA,
    outputSchema: PHASE4B_MCP_COLLECTIONS_CREATE_OUTPUT_SCHEMA,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: PHASE4B_MCP_COLLECTIONS_CREATE_TOOL_NAME,
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      try {
        return await service.execute(input, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function createCollectionUpdateDefinition(
  service: Phase4bMcpLowRiskCollectionUpdateService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: collectionUpdateInputSchema,
    outputSchema: PHASE4B_MCP_COLLECTIONS_UPDATE_OUTPUT_SCHEMA,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME,
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      try {
        return await service.execute(input, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function createNodeUpdateDefinition(
  service: Phase4bMcpLowRiskNodeUpdateService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: nodeUpdateInputSchema,
    outputSchema: nodeUpdateOutputSchema,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: PHASE4B_MCP_NODES_UPDATE_TOOL_NAME,
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      try {
        return await service.execute(input, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function createAnnotationCreateDefinition(
  service: Phase4bMcpLowRiskAnnotationCreateService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: annotationCreateInputSchema,
    outputSchema: PHASE4B_MCP_ANNOTATIONS_CREATE_OUTPUT_SCHEMA,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      try {
        return await service.execute(input, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function createAnnotationUpdateDefinition(
  service: Phase4bMcpLowRiskAnnotationUpdateService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: annotationUpdateInputSchema,
    outputSchema: PHASE4B_MCP_ANNOTATIONS_UPDATE_OUTPUT_SCHEMA,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      try {
        return await service.execute(input, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function createChangeGetDefinition(
  service: Phase4bMcpLowRiskChangeGetService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: PHASE4B_MCP_CHANGES_GET_INPUT_SCHEMA,
    outputSchema: PHASE4B_MCP_CHANGES_GET_OUTPUT_SCHEMA,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: PHASE4B_MCP_CHANGES_GET_TOOL_NAME,
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      try {
        return await service.execute(input, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function createNodeDeleteSubtreeDefinition(): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false,
      properties: { nodeId: opaqueIdProperty, collectionId: opaqueIdProperty }, required: ['nodeId'] }),
    outputSchema: nodeMoveOutputSchema,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: 'delete_subtree',
      risk: 'high' as const,
    })]),
    invoke: () => {
      throw new TypeError('nodes.delete_subtree cannot write directly.');
    },
  };
  return Object.freeze(definition);
}

function createNodeMoveDefinition(): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: nodeMoveInputSchema,
    outputSchema: nodeMoveOutputSchema,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: 'move_node',
      risk: 'medium' as const,
    })]),
    invoke: () => {
      throw new TypeError('nodes.move is medium risk and cannot write directly.');
    },
  };
  return Object.freeze(definition);
}

function createNodeCreateDefinition(
  service: Phase4bMcpLowRiskNodeCreateService,
): McpLowRiskToolDefinition {
  const definition: McpLowRiskToolDefinition = {
    inputSchema: nodeCreateInputSchema,
    outputSchema: nodeCreateOutputSchema,
    toCanonicalOperations: () => Object.freeze([Object.freeze({
      type: 'nodes.create',
      risk: 'low' as const,
    })]),
    invoke: async (input, context) => {
      const request = buildNodeCreateRequest(input, context.binding);
      try {
        return await service.execute(request, {
          binding: context.binding,
          accountSubjectId: requireMcpAccountSubjectId(context.authorization),
          scope: context.scope,
          budget: context.budget,
        });
      } catch (error) {
        throw mappedNodeCreateError(error);
      }
    },
  };
  return Object.freeze(definition);
}

function mappedNodeCreateError(error: unknown): unknown {
  const classified = classifyPhase4bMcpWriteError(error);
  if (classified.outcome === 'rejected' || classified.outcome === 'dependency_error') {
    return toPhase4bMcpWriteRequestError(classified, writeErrorHintFrom(error));
  }
  return error;
}

function buildNodeCreateRequest(
  input: Readonly<Record<string, unknown>>,
  binding: McpAuthenticatedAuthorizationBinding,
): Phase4bMcpLowRiskNodeCreateRequest {
  const node = readRequiredOwnObject(input, 'node');
  const parentId = readOptionalOwnString(input, 'parentId');
  const facts = Object.freeze({
    collectionId: readRequiredOwnString(input, 'collectionId'),
    ...(parentId === null ? {} : { parentId }),
    afterId: readOptionalOwnString(input, 'afterId'),
    beforeId: readOptionalOwnString(input, 'beforeId'),
    node,
    reason: readOptionalOwnString(input, 'reason') ?? PHASE4B_MCP_NODE_CREATE_DEFAULT_REASON,
  });
  return Object.freeze({
    input: Object.freeze({
      tool: 'nodes.create',
      ...facts,
      ...readNodeCreateModeFlags(input),
    }),
    idempotencyKey: deriveNodeCreateCommandId(facts, binding),
    expectedBaseRevisions: Object.freeze({}),
  });
}

function readNodeCreateModeFlags(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ readonly confirmApply: true }> | Readonly<{
  readonly dryRun: true;
  readonly confirmApply: false;
}> {
  const hasDryRun = Object.hasOwn(input, 'dryRun');
  const dryRun = hasDryRun ? readRequiredOwnData(input, 'dryRun') : undefined;
  const hasConfirmApply = Object.hasOwn(input, 'confirmApply');
  const confirmApply = hasConfirmApply
    ? readRequiredOwnData(input, 'confirmApply')
    : undefined;
  if (dryRun === true || confirmApply === false) {
    return Object.freeze({ dryRun: true as const, confirmApply: false as const });
  }
  return Object.freeze({ confirmApply: true as const });
}

function deriveNodeCreateCommandId(
  facts: Readonly<Record<string, unknown>>,
  binding: McpAuthenticatedAuthorizationBinding,
): string {
  const ownedBinding = requireAuthenticatedWriteBinding(
    snapshotMcpAuthorizationBinding(binding),
  );
  const canonical = canonicalJson(Object.freeze({
    operation: 'nodes.create',
    binding: ownedBinding,
    facts,
  }));
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readOptionalWriteAdapterOptions(
  options: Phase4bMcpWriteToolAdapterOptions,
): Readonly<{
  requestStateTtlSeconds?: number;
  requestStateClock?: () => number;
  inputBudget?: McpWriteInputBudget;
}> {
  const result: {
    requestStateTtlSeconds?: number;
    requestStateClock?: () => number;
    inputBudget?: McpWriteInputBudget;
  } = {};
  const descriptor = Object.getOwnPropertyDescriptor(options, 'requestStateTtlSeconds');
  if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== undefined) {
    result.requestStateTtlSeconds = descriptor.value;
  }
  const clockDescriptor = Object.getOwnPropertyDescriptor(options, 'requestStateClock');
  if (clockDescriptor !== undefined && 'value' in clockDescriptor && clockDescriptor.value !== undefined) {
    result.requestStateClock = clockDescriptor.value;
  }
  const budgetDescriptor = Object.getOwnPropertyDescriptor(options, 'inputBudget');
  if (budgetDescriptor !== undefined && 'value' in budgetDescriptor && budgetDescriptor.value !== undefined) {
    result.inputBudget = budgetDescriptor.value;
  }
  return Object.freeze(result);
}

function readRequiredOwnData(options: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`MCP-W06 Write adapter requires ${name}.`);
  }
  return descriptor.value;
}

function readRequiredOwnObject(
  value: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  const candidate = readRequiredOwnData(value, name);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`MCP-W06 ${name} must be a plain object.`);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function readRequiredOwnString(
  value: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const candidate = readRequiredOwnData(value, name);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new TypeError(`MCP-W06 ${name} must be a non-empty string.`);
  }
  return candidate;
}

function readOptionalOwnString(
  value: Readonly<Record<string, unknown>>,
  name: string,
): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return null;
  if (descriptor.value === null) return null;
  if (typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
    throw new TypeError(`MCP-W06 ${name} must be a string or null.`);
  }
  return descriptor.value;
}

function bindingsEqual(
  left: McpAuthenticatedAuthorizationBinding,
  right: McpAuthenticatedAuthorizationBinding,
): boolean {
  return left.kind === right.kind
    && left.principalId === right.principalId
    && left.clientId === right.clientId
    && left.credentialBindingId === right.credentialBindingId
    && left.resourceAudience === right.resourceAudience
    && left.securityEpoch === right.securityEpoch;
}
