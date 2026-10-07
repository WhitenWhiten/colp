import { randomUUID } from 'node:crypto';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';
import type { McpApplicationWritePort } from './application-ports.js';
import { approveMcpReportPlan, commitMcpReportPlan, createMcpReportPlan, type McpReportPlan, type McpReportPlanOperation, type McpReportPlanStore, type McpReportPlanExecutor, type McpReportPlanRevisionPort } from './report-plan.js';

const opaqueString = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const seriesPatchFields = Object.freeze({
  title: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
  summary: Object.freeze({ type: ['string', 'null'], maxLength: 2_000 }),
  slug: Object.freeze({ type: ['string', 'null'], minLength: 3, maxLength: 63 }),
  visibility: Object.freeze({ type: 'string', enum: ['private', 'protected', 'unlisted', 'public'] }),
  allowSearchIndexing: Object.freeze({ type: 'boolean' }),
});
const editionMetadataFields = Object.freeze({
  titleSnapshot: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
  summarySnapshot: Object.freeze({ type: ['string', 'null'], maxLength: 2_000 }),
  periodStart: Object.freeze({ type: ['string', 'null'], maxLength: 64 }),
  periodEnd: Object.freeze({ type: ['string', 'null'], maxLength: 64 }),
});
const editionPatchFields = Object.freeze({ collectionId: opaqueString, issueKey: opaqueString, ...editionMetadataFields });
const operationType = Object.freeze({ const: 'report' });
const seriesCreateOperation = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'action', 'patch'],
  properties: Object.freeze({
    type: operationType,
    action: Object.freeze({ const: 'series.create' }),
    patch: Object.freeze({ type: 'object', minProperties: 1, additionalProperties: false, properties: seriesPatchFields }),
  }),
});
const seriesUpdateOperation = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'action', 'targetId', 'expectedRevision', 'patch'],
  properties: Object.freeze({
    type: operationType,
    action: Object.freeze({ const: 'series.update' }),
    targetId: opaqueString,
    expectedRevision: opaqueString,
    patch: Object.freeze({ type: 'object', minProperties: 1, additionalProperties: false, properties: seriesPatchFields }),
  }),
});
const editionUpdateOperation = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'action', 'targetId', 'expectedRevision', 'patch'],
  properties: Object.freeze({
    type: operationType,
    action: Object.freeze({ const: 'edition.update' }),
    targetId: opaqueString,
    expectedRevision: opaqueString,
    patch: Object.freeze({ type: 'object', minProperties: 1, additionalProperties: false, properties: editionMetadataFields }),
  }),
});
const editionPublishOperation = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'action', 'targetId', 'expectedRevision', 'patch'],
  properties: Object.freeze({
    type: operationType,
    action: Object.freeze({ const: 'edition.publish' }),
    targetId: opaqueString,
    expectedRevision: opaqueString,
    patch: Object.freeze({ type: 'object', maxProperties: 0, additionalProperties: false, properties: Object.freeze({}) }),
  }),
});
const editionAttachOperation = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'action', 'seriesId', 'sourceCollectionId', 'patch'],
  properties: Object.freeze({
    type: operationType,
    action: Object.freeze({ const: 'edition.attach' }),
    seriesId: opaqueString,
    sourceCollectionId: opaqueString,
    patch: Object.freeze({ type: 'object', minProperties: 1, additionalProperties: false, properties: editionPatchFields }),
  }),
});
const reportOperationSchema = Object.freeze({
  type: 'object',
  oneOf: Object.freeze([
    seriesCreateOperation,
    seriesUpdateOperation,
    editionUpdateOperation,
    editionPublishOperation,
    editionAttachOperation,
  ]),
});

const tools: readonly McpApplicationToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: 'reports.plan',
    description: 'Create a typed report change Plan. Publicization and publish require approval.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['operations', 'reportRevision'],
      properties: Object.freeze({
        operations: Object.freeze({ type: 'array', minItems: 1, maxItems: 20, items: reportOperationSchema }),
        reportRevision: opaqueString,
        sourceRevisions: Object.freeze({ type: 'object', additionalProperties: opaqueString, maxProperties: 64 }),
      }),
    }),
    requiredScopes: Object.freeze(['reports:write']),
  }),
  Object.freeze({
    name: 'reports.commit',
    description: 'Commit an approved report Plan.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['planId', 'idempotencyKey'],
      properties: Object.freeze({ planId: opaqueString, idempotencyKey: opaqueString }),
    }),
    requiredScopes: Object.freeze(['reports:write']),
  }),
]);

export function createReportMcpWriteToolPort(input: Readonly<{
  store: McpReportPlanStore;
  revisions: McpReportPlanRevisionPort;
  captureSourceRevisions?: (operations: readonly McpReportPlanOperation[],
    declared: Readonly<Record<string, string>>, context: McpApplicationContext) => Promise<Record<string, string>>;
  executePlanWithValidation?: (plan: McpReportPlan, context: McpApplicationContext,
    validate: Parameters<NonNullable<McpReportPlanExecutor['executeWithValidation']>>[1]) => Promise<unknown>;
  executePlan: (plan: McpReportPlan, context: McpApplicationContext) => unknown | PromiseLike<unknown>;
}>): McpApplicationWritePort {
  return Object.freeze({
    listTools: async (context: McpApplicationContext) => context.principal.kind === 'authenticated' && context.scopes.includes('reports:write') ? tools : [],
    callTool: async (context: McpApplicationContext, name: string, args: Readonly<Record<string, unknown>>): Promise<McpApplicationToolResult> => {
      if (context.principal.kind !== 'authenticated' || !context.scopes.includes('reports:write')) return { kind: 'rejected', stableCode: 'insufficient_scope', safeMessage: 'Insufficient scope.', retryable: false };
      try {
        if (Object.keys(args).some((key) => name === 'reports.plan'
          ? !['operations', 'reportRevision', 'sourceRevisions'].includes(key)
          : !['planId', 'idempotencyKey'].includes(key))) {
          throw new Error('invalid report tool arguments');
        }
        if (name === 'reports.plan') {
          if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 20
            || typeof args.reportRevision !== 'string' || args.reportRevision.length < 1 || args.reportRevision.length > 128) {
            throw new Error('invalid report tool arguments');
          }
          const operations = args.operations as McpReportPlanOperation[];
          const requiredScopes = reportPlanScopes(operations);
          if (requiredScopes.some((scope) => !context.scopes.includes(scope))) {
            return { kind: 'rejected', stableCode: 'insufficient_scope', safeMessage: 'Insufficient scope.', retryable: false };
          }
          const planInput = { planId: randomUUID(), operations, binding: context.principal, requiredScopes,
            reportRevision: args.reportRevision, sourceRevisions: args.sourceRevisions as Record<string, string> | undefined,
            expiresAt: new Date(Date.now() + 900_000).toISOString() };
          // Validate the complete request before resolving any source identities.
          const validated = await createMcpReportPlan({ ...planInput, store: { save() {}, get() { return undefined; } } });
          const sourceRevisions = input.captureSourceRevisions
            ? await input.captureSourceRevisions(validated.operations, validated.sourceRevisions, context)
            : validated.sourceRevisions;
          const plan = await createMcpReportPlan({ ...planInput, sourceRevisions, store: input.store });
          return { kind: 'complete', content: [{ type: 'text', text: JSON.stringify(plan) }], structuredContent: plan };
        }
        if (name === 'reports.commit') {
          if (typeof args.planId !== 'string' || typeof args.idempotencyKey !== 'string'
            || args.planId.length < 1 || args.planId.length > 128
            || args.idempotencyKey.length < 1 || args.idempotencyKey.length > 128) {
            throw new Error('invalid report tool arguments');
          }
          const result = await commitMcpReportPlan({ planId: args.planId, binding: context.principal, scopes: context.scopes, idempotencyKey: args.idempotencyKey, store: input.store, revisions: input.revisions, executor: { execute: (plan) => input.executePlan(plan, context), ...(input.executePlanWithValidation ? { executeWithValidation: (plan, validate) => input.executePlanWithValidation!(plan, context, validate) } : {}) } });
          return { kind: 'complete', content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        }
        return { kind: 'rejected', stableCode: 'unknown_tool', safeMessage: 'Unknown tool.', retryable: false };
      } catch (error) {
        const code = error instanceof Error && 'code' in error
          ? (error as { code?: unknown }).code : undefined;
        const stableCode = code === 'approval_required' ? 'approval_required'
          : code === 'stale_report' || code === 'stale_source' ? 'stale_revision'
            : code === 'binding_mismatch' || code === 'scope_downgrade' ? 'insufficient_scope'
              : 'invalid_request';
        return { kind: 'rejected', stableCode, safeMessage: stableCode === 'approval_required' ? 'Approval is required.' : stableCode === 'stale_revision' ? 'The report changed; refresh and retry.' : stableCode === 'insufficient_scope' ? 'Insufficient scope.' : 'The report request is invalid.', retryable: false };
      }
    },
  });
}

function reportPlanScopes(operations: readonly McpReportPlanOperation[]): readonly string[] {
  const requiresPublish = operations.some((operation) => {
    if (!operation || typeof operation !== 'object') return false;
    if (operation.action === 'edition.publish') return true;
    if (operation.action !== 'series.create' && operation.action !== 'series.update') return false;
    const visibility = operation.patch && typeof operation.patch === 'object'
      ? operation.patch.visibility : undefined;
    return visibility === 'public' || visibility === 'unlisted';
  });
  return Object.freeze(requiresPublish
    ? ['reports:write', 'reports:publish']
    : ['reports:write']);
}

export { approveMcpReportPlan };
