import { createHash } from 'node:crypto';
import { canonicalJson } from '../commands/index.js';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';

/** Typed report operation; deliberately unrelated to Collection/Node operations. */
export type McpReportPlanOperation = Readonly<{
  type: 'report';
  action: 'series.create' | 'series.update' | 'edition.attach' | 'edition.update' | 'edition.publish';
  targetId?: string;
  seriesId?: string;
  sourceCollectionId?: string;
  expectedRevision?: string;
  sourceContentRevision?: string;
  sourcePolicyRevision?: string;
  patch: Readonly<Record<string, unknown>>;
}>;

export type McpReportPlanApproval = Readonly<{
  status: 'pending' | 'approved' | 'denied';
  approvedBy?: string;
  approvedAt?: string;
}>;

export type McpReportPlan = Readonly<{
  planId: string;
  operations: readonly McpReportPlanOperation[];
  operationsDigest: string;
  binding: McpAuthenticatedAuthorizationBinding;
  requiredScopes: readonly string[];
  reportRevision: string;
  sourceRevisions: Readonly<Record<string, string>>;
  expiresAt: string;
  approval: McpReportPlanApproval;
  status: 'pending' | 'committed' | 'cancelled';
  readonly commitIdempotencyKey?: string;
  readonly commitResult?: unknown;
}>;

export type McpReportPlanErrorCode =
  | 'invalid_plan' | 'binding_mismatch' | 'scope_downgrade' | 'expired'
  | 'stale_report' | 'stale_source' | 'approval_required' | 'unknown_commit' | 'replay';

export class McpReportPlanError extends Error {
  constructor(readonly code: McpReportPlanErrorCode, message: string) {
    super(message);
    this.name = 'McpReportPlanError';
  }
}

const MAX_PLAN_STRING_LENGTH = 4_096;
const MAX_PLAN_SERIALIZED_BYTES = 256 * 1_024;
const MAX_PLAN_OPERATIONS = 20;
const MAX_SOURCE_REVISIONS = 64;
const REPORT_ACTIONS = Object.freeze([
  'series.create', 'series.update', 'edition.attach', 'edition.update', 'edition.publish',
] as const);
const REPORT_SCOPES = Object.freeze(['reports:write', 'reports:publish', 'reports:follow'] as const);
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface McpReportPlanStore {
  save(plan: McpReportPlan): void | PromiseLike<void>;
  get(planId: string): McpReportPlan | undefined | PromiseLike<McpReportPlan | undefined>;
  update?(plan: McpReportPlan): void | PromiseLike<void>;
}

export interface McpReportPlanRevisionPort {
  currentReportRevision(plan: McpReportPlan): string | PromiseLike<string>;
  currentSourceRevisions(plan: McpReportPlan): Readonly<Record<string, string>> | PromiseLike<Readonly<Record<string, string>>>;
}

export interface McpReportPlanExecutor {
  execute(plan: McpReportPlan): unknown | PromiseLike<unknown>;
  /** Recover a durable execution receipt before checking mutable revisions;
   * new execution must validate and save its receipt in the business transaction. */
  executeWithValidation?(plan: McpReportPlan,
    validate: (revisions: McpReportPlanRevisionPort) => Promise<void>): Promise<unknown>;
}

export interface McpReportPlanCommitResult {
  readonly kind: 'committed' | 'replay';
  readonly planId: string;
  readonly value?: unknown;
}

const stable = (value: unknown): string => {
  const json = canonicalJson(value);
  if (json === undefined) throw new McpReportPlanError('invalid_plan', 'Report Plan is not deterministic JSON.');
  if (Buffer.byteLength(json, 'utf8') > MAX_PLAN_SERIALIZED_BYTES) {
    throw new McpReportPlanError('invalid_plan', 'Report Plan is too large.');
  }
  return json;
};

export function serializeMcpReportPlan(plan: McpReportPlan): string {
  return stable({
    planId: plan.planId,
    operations: plan.operations,
    operationsDigest: plan.operationsDigest,
    binding: plan.binding,
    requiredScopes: plan.requiredScopes,
    reportRevision: plan.reportRevision,
    sourceRevisions: plan.sourceRevisions,
    expiresAt: plan.expiresAt,
    approval: plan.approval,
    status: plan.status,
    ...(plan.commitIdempotencyKey === undefined ? {} : { commitIdempotencyKey: plan.commitIdempotencyKey }),
  });
}

export function computeMcpReportPlanDigest(input: Readonly<{
  operations: readonly McpReportPlanOperation[];
  binding: McpAuthenticatedAuthorizationBinding;
  requiredScopes: readonly string[];
  reportRevision: string;
  sourceRevisions: Readonly<Record<string, string>>;
  expiresAt: string;
}>): string {
  const canonical = stable({
    operations: input.operations,
    binding: input.binding,
    requiredScopes: input.requiredScopes,
    reportRevision: input.reportRevision,
    sourceRevisions: input.sourceRevisions,
    expiresAt: input.expiresAt,
  });
  return `sha-256:${createHash('sha256').update(canonical, 'utf8').digest('base64url')}`;
}

export function verifyMcpReportPlanDigest(plan: McpReportPlan): boolean {
  return computeMcpReportPlanDigest(plan) === plan.operationsDigest;
}

function sameBinding(a: McpAuthenticatedAuthorizationBinding, b: McpAuthenticatedAuthorizationBinding): boolean {
  return a.kind === b.kind && a.principalId === b.principalId && a.clientId === b.clientId
    && a.credentialBindingId === b.credentialBindingId && a.resourceAudience === b.resourceAudience
    && a.securityEpoch === b.securityEpoch;
}

function assertOperation(operation: unknown): asserts operation is McpReportPlanOperation {
  if (!isPlainRecord(operation) || operation.type !== 'report'
    || !REPORT_ACTIONS.includes(operation.action as (typeof REPORT_ACTIONS)[number])
    || !isPlainRecord(operation.patch) || !boundedJson(operation)) {
    throw new McpReportPlanError('invalid_plan', 'Unknown typed report operation.');
  }
  const action = operation.action as McpReportPlanOperation['action'];
  const operationKeys = Object.keys(operation).sort();
  const allowedOperationKeys = action === 'series.create'
    ? ['action', 'patch', 'type']
    : action === 'series.update'
      ? ['action', 'expectedRevision', 'patch', 'targetId', 'type']
      : action === 'edition.attach'
        ? ['action', 'patch', 'seriesId', 'sourceCollectionId', 'type']
        : ['action', 'expectedRevision', 'patch', 'targetId', 'type'];
  if (!sameKeys(operationKeys, allowedOperationKeys)) {
    throw new McpReportPlanError('invalid_plan', 'Report operation contains an unknown field.');
  }
  const patch = operation.patch as Record<string, unknown>;
  const patchKeys = Object.keys(patch);
  const allowedPatchKeys = action === 'series.create' || action === 'series.update'
    ? ['title', 'summary', 'slug', 'visibility', 'allowSearchIndexing']
    : action === 'edition.attach'
      ? ['collectionId', 'issueKey', 'titleSnapshot', 'summarySnapshot', 'periodStart', 'periodEnd']
      : ['titleSnapshot', 'summarySnapshot', 'periodStart', 'periodEnd'];
  if (patchKeys.some((key) => !allowedPatchKeys.includes(key))
    || !patchKeys.every((key) => validatePatchField(key, patch[key]))) {
    throw new McpReportPlanError('invalid_plan', 'Report operation contains an unknown patch field.');
  }
  if ((action === 'series.create' && !('title' in patch))
    || (action !== 'series.create' && action !== 'edition.attach' && !validOpaque(operation.targetId))) {
    throw new McpReportPlanError('invalid_plan', 'Report operation target is required.');
  }
  if ((action === 'series.update' || action === 'edition.update') && patchKeys.length === 0) {
    throw new McpReportPlanError('invalid_plan', 'Update operation requires a metadata patch.');
  }
  if (action === 'edition.attach') {
    if (!validOpaque(operation.seriesId) || !validOpaque(operation.sourceCollectionId)) {
      throw new McpReportPlanError('invalid_plan', 'Attach operation requires series and source identities.');
    }
    if (!('issueKey' in patch) || !('titleSnapshot' in patch)) {
      throw new McpReportPlanError('invalid_plan', 'Attach operation requires issue key and title.');
    }
    const collectionId = patch.collectionId;
    if (collectionId !== undefined && collectionId !== operation.sourceCollectionId) {
      throw new McpReportPlanError('invalid_plan', 'Attach source identities must match.');
    }
  }
  if (action === 'edition.publish' || action === 'series.update' || action === 'edition.update') {
    if (!validRevision(operation.expectedRevision)) throw new McpReportPlanError('invalid_plan', 'Report operation requires expectedRevision.');
  }
  if (action === 'edition.publish' && patchKeys.length > 0) {
    throw new McpReportPlanError('invalid_plan', 'Publish operation cannot carry a metadata patch.');
  }
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSorted = [...actual].sort();
  const sorted = [...expected].sort();
  return actualSorted.length === sorted.length && actualSorted.every((key, index) => key === sorted[index]);
}

function validatePatchField(key: string, value: unknown): boolean {
  if (key === 'title' || key === 'titleSnapshot') return validText(value, 512, true);
  if (key === 'summary' || key === 'summarySnapshot') return value === null || validText(value, 2_000, false);
  if (key === 'slug') return value === null || (typeof value === 'string'
    && value.length >= 3 && value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value));
  if (key === 'visibility') return value === 'private' || value === 'protected'
    || value === 'unlisted' || value === 'public';
  if (key === 'allowSearchIndexing') return typeof value === 'boolean';
  if (key === 'collectionId' || key === 'issueKey') return validOpaque(value);
  if (key === 'periodStart' || key === 'periodEnd') return value === null || validInstant(value);
  return false;
}

function validText(value: unknown, maxLength: number, nonBlank: boolean): value is string {
  return typeof value === 'string' && value.length >= (nonBlank ? 1 : 0)
    && value.length <= maxLength && (!nonBlank || value.trim().length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && RFC3339_INSTANT.test(value)
    && Number.isFinite(Date.parse(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedJson(value: unknown, depth = 0, budget = { remaining: 256 }): boolean {
  if (depth > 8 || budget.remaining-- <= 0) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= MAX_PLAN_STRING_LENGTH;
  if (typeof value === 'number') return Number.isFinite(value) && Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 32 && value.every((item) => boundedJson(item, depth + 1, budget));
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && entries.every(([key, item]) => key.length <= 128 && boundedJson(item, depth + 1, budget));
}

function validOpaque(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

function isValidBinding(value: unknown): value is McpAuthenticatedAuthorizationBinding {
  if (!isPlainRecord(value) || value.kind !== 'authenticated') return false;
  const fields = ['principalId', 'clientId', 'credentialBindingId', 'resourceAudience', 'securityEpoch'] as const;
  if (!sameKeys(Object.keys(value), ['clientId', 'credentialBindingId', 'kind', 'principalId', 'resourceAudience', 'securityEpoch'])) return false;
  return fields.every((field) => validText(value[field], 256, true));
}

/** Builds a session-free report plan. Publicization/publish always require approval. */
export async function createMcpReportPlan(input: Readonly<{
  planId: string;
  operations: readonly McpReportPlanOperation[];
  binding: McpAuthenticatedAuthorizationBinding;
  requiredScopes: readonly string[];
  reportRevision: string;
  sourceRevisions?: Readonly<Record<string, string>>;
  expiresAt: string;
  store: McpReportPlanStore;
}>): Promise<McpReportPlan> {
  if (!validOpaque(input.planId) || !Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_PLAN_OPERATIONS
    || !isValidBinding(input.binding) || !Array.isArray(input.requiredScopes) || !input.requiredScopes.length
    || input.requiredScopes.length > REPORT_SCOPES.length
    || input.requiredScopes.some((scope) => !REPORT_SCOPES.includes(scope as (typeof REPORT_SCOPES)[number]))
    || new Set(input.requiredScopes).size !== input.requiredScopes.length
    || !validRevision(input.reportRevision)) throw new McpReportPlanError('invalid_plan', 'Report Plan requires bounded authenticated inputs.');
  input.operations.forEach(assertOperation);
  const now = Date.now();
  const expires = Date.parse(input.expiresAt);
  if (!validInstant(input.expiresAt) || !Number.isFinite(expires) || expires <= now
    || expires - now > 15 * 60_000) throw new McpReportPlanError('invalid_plan', 'Report Plan expiry is invalid.');
  const sourceRevisionsInput = input.sourceRevisions ?? {};
  if (!isPlainRecord(sourceRevisionsInput) || Object.keys(sourceRevisionsInput).length > MAX_SOURCE_REVISIONS
    || Object.entries(sourceRevisionsInput).some(([key, value]) => !validOpaque(key) || !validRevision(value))) {
    throw new McpReportPlanError('invalid_plan', 'Report source revisions are invalid.');
  }
  const sourceRevisions = Object.freeze({ ...sourceRevisionsInput });
  const operationsDigest = computeMcpReportPlanDigest({ ...input, sourceRevisions });
  const requiresApproval = input.operations.some((op) => op.action === 'edition.publish'
    || ((op.action === 'series.update' || op.action === 'series.create')
      && ['public', 'unlisted'].includes(String(op.patch.visibility))));
  const plan: McpReportPlan = Object.freeze({
    planId: input.planId,
    operations: Object.freeze([...input.operations]),
    operationsDigest,
    binding: input.binding,
    requiredScopes: Object.freeze([...input.requiredScopes]),
    reportRevision: input.reportRevision,
    sourceRevisions,
    expiresAt: input.expiresAt,
    approval: Object.freeze({ status: requiresApproval ? 'pending' : 'approved' }),
    status: 'pending',
  });
  await input.store.save(plan);
  return plan;
}

export async function approveMcpReportPlan(store: McpReportPlanStore, planId: string, binding: McpAuthenticatedAuthorizationBinding, now = new Date()): Promise<McpReportPlan> {
  if (!validOpaque(planId) || !isValidBinding(binding)) {
    throw new McpReportPlanError('invalid_plan', 'Report approval inputs are invalid.');
  }
  const plan = await store.get(planId);
  if (!plan) throw new McpReportPlanError('unknown_commit', 'Report Plan was not found.');
  if (plan.status !== 'pending') throw new McpReportPlanError('replay', 'Report Plan is no longer approvable.');
  if (!isValidBinding(plan.binding)) throw new McpReportPlanError('invalid_plan', 'Stored Report Plan binding is invalid.');
  if (!sameBinding(plan.binding, binding)) throw new McpReportPlanError('binding_mismatch', 'Approval binding does not match the Plan.');
  if (plan.approval.status === 'denied') throw new McpReportPlanError('replay', 'Report Plan approval was denied.');
  if (Date.parse(plan.expiresAt) <= now.getTime()) throw new McpReportPlanError('expired', 'Report Plan has expired.');
  if (plan.approval.status === 'approved') return plan;
  const updated = Object.freeze({ ...plan, approval: Object.freeze({ status: 'approved' as const, approvedBy: binding.principalId, approvedAt: now.toISOString() }) });
  if (store.update) await store.update(updated); else await store.save(updated);
  return updated;
}

export async function commitMcpReportPlan(input: Readonly<{
  planId: string;
  binding: McpAuthenticatedAuthorizationBinding;
  scopes: readonly string[];
  idempotencyKey: string;
  store: McpReportPlanStore;
  revisions: McpReportPlanRevisionPort;
  executor: McpReportPlanExecutor;
  now?: Date;
}>): Promise<McpReportPlanCommitResult> {
  if (!validOpaque(input.planId) || !validOpaque(input.idempotencyKey) || !isValidBinding(input.binding)) {
    throw new McpReportPlanError('invalid_plan', 'Report commit inputs are invalid.');
  }
  const plan = await input.store.get(input.planId);
  if (!plan) throw new McpReportPlanError('unknown_commit', 'Report Plan was not found.');
  if (!isValidBinding(plan.binding)) throw new McpReportPlanError('invalid_plan', 'Stored Report Plan binding is invalid.');
  if (!sameBinding(plan.binding, input.binding)) throw new McpReportPlanError('binding_mismatch', 'Commit binding does not match the Plan.');
  if (!plan.requiredScopes.every((scope) => input.scopes.includes(scope))) throw new McpReportPlanError('scope_downgrade', 'Commit scope is weaker than the Plan scope.');
  if (plan.status === 'committed') {
    if (plan.commitIdempotencyKey === input.idempotencyKey) return { kind: 'replay', planId: plan.planId, value: plan.commitResult };
    throw new McpReportPlanError('replay', 'Report Plan was already committed with a different idempotency key.');
  }
  if (plan.status !== 'pending') throw new McpReportPlanError('replay', 'Report Plan is no longer committable.');
  if (!verifyMcpReportPlanDigest(plan)) throw new McpReportPlanError('invalid_plan', 'Report Plan digest mismatch.');
  const validate = async (revisions: McpReportPlanRevisionPort): Promise<void> => {
    if (Date.parse(plan.expiresAt) <= (input.now ?? new Date()).getTime()) throw new McpReportPlanError('expired', 'Report Plan has expired.');
    if (plan.approval.status !== 'approved') throw new McpReportPlanError('approval_required', 'Report Plan approval is required.');
    if (await revisions.currentReportRevision(plan) !== plan.reportRevision) throw new McpReportPlanError('stale_report', 'Report revision changed.');
    const source = await revisions.currentSourceRevisions(plan);
    for (const [id, revision] of Object.entries(plan.sourceRevisions)) if (source[id] !== revision) throw new McpReportPlanError('stale_source', 'Report source revision changed.');
  };
  const value = input.executor.executeWithValidation
    ? await input.executor.executeWithValidation({ ...plan, commitIdempotencyKey: input.idempotencyKey }, validate)
    : await (async () => { await validate(input.revisions); return input.executor.execute(plan); })();
  const committed = Object.freeze({ ...plan, status: 'committed' as const, commitIdempotencyKey: input.idempotencyKey, commitResult: value });
  if (input.store.update) await input.store.update(committed); else await input.store.save(committed);
  return { kind: 'committed', planId: plan.planId, value };
}

/** Non-empty controls required by ND-12 acceptance artifacts. */
export const MCP_REPORT_PLAN_NEGATIVE_CONTROLS = Object.freeze([
  'unknown-commit', 'foreign-binding', 'stale-report-revision', 'stale-source-revision',
  'scope-downgrade', 'expired-plan', 'publicization-without-approval',
] as const);
