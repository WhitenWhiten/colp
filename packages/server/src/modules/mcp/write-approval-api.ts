/**
 * MCP-W07 Product approval application service.
 *
 * This module exposes current-account Plan/Approval views and exact-once
 * approve/deny decisions for the Product HTTP surface. It never receives raw
 * credentials, Session cookies, MCP wire objects, or untrusted note text.
 * Untrusted Plan note content stays out of every view/summary; operation
 * previews are structurally typed data for a renderer to escape.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import type {
  McpAuthenticatedAuthorizationBinding,
  McpStoredPlan,
} from '@know-n/colp/mcp';
import {
  stableReplayHeaders,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../commands/index.js';

export type WriteApprovalDecision = 'approve' | 'deny';
export type WriteApprovalPlanStatus = McpStoredPlan['status'];
export type WriteApprovalDecisionState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'committing'
  | 'consumed';

export interface WriteApprovalImpact {
  readonly collections: number;
  readonly nodes: number;
  readonly annotations: number;
  readonly attachments: number;
  readonly relations: number;
  readonly privateFieldsExcluded: readonly string[];
}

export interface WriteApprovalNodeSummary {
  readonly kind: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly visibility: string | null;
}

export interface WriteApprovalOperationPreview {
  readonly type: string;
  readonly collectionId: string | null;
  readonly nodeId: string | null;
  readonly visibility: string | null;
  readonly nodeSummary: WriteApprovalNodeSummary | null;
}

export interface WriteApprovalTarget {
  readonly kind: 'collection' | 'node';
  readonly collectionId: string;
  readonly nodeId: string | null;
}

export interface WriteApprovalView {
  readonly planId: string;
  readonly status: WriteApprovalPlanStatus;
  readonly risk: McpStoredPlan['risk'];
  readonly requiresApproval: boolean;
  readonly summary: string;
  readonly impact: WriteApprovalImpact;
  readonly requiredScopes: readonly string[];
  readonly target: WriteApprovalTarget;
  readonly operations: readonly WriteApprovalOperationPreview[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decision: WriteApprovalDecisionState;
  readonly etag: string;
}

export interface WriteApprovalPage {
  readonly items: readonly WriteApprovalView[];
  readonly nextCursor: null;
}

export interface WriteApprovalDecisionResult {
  readonly kind: 'decided';
  readonly planId: string;
  readonly decision: 'approved' | 'denied';
  readonly status: 'approved' | 'cancelled';
  readonly etag: string;
}

export interface WriteApprovalAccount {
  readonly id: string;
}

export interface WriteApprovalListFilter {
  readonly principalIds: readonly string[];
  readonly limit: number;
}

export interface WriteApprovalDecisionInput {
  readonly planId: string;
  readonly decision: WriteApprovalDecision;
  readonly account: WriteApprovalAccount;
  readonly commandId: string;
  readonly commandScope: string;
  readonly fingerprint: string;
  readonly ifMatch: string;
  readonly now?: Date;
  readonly signal?: AbortSignal;
}

export type Phase4bMcpWriteApprovalDecisionOutcome =
  | { readonly kind: 'succeeded'; readonly result: WriteApprovalDecisionResult }
  | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>;

export interface WriteApprovalAuditDecision {
  readonly planId: string;
  readonly principalId: string;
  readonly commandId: string;
  readonly decision: 'approved' | 'denied';
  readonly status: 'approved' | 'cancelled';
  readonly risk: McpStoredPlan['risk'];
  readonly operationsDigest: string;
}

export interface Phase4bMcpWriteApprovalPlanStorePorts<Transaction extends object = object> {
  /**
   * Executes decision work in one atomic unit. A thrown error must roll back
   * Plan, Approval, Audit, and command receipt changes made inside the callback.
   */
  readonly execute: <Result>(
    work: (transaction: Transaction) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Result>;
  readonly lockPlan: (
    transaction: Transaction,
    planId: string,
  ) => McpStoredPlan | undefined | PromiseLike<McpStoredPlan | undefined>;
  readonly updatePlan: (
    transaction: Transaction,
    plan: McpStoredPlan,
  ) => void | PromiseLike<void>;
  readonly markApproved: (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => void | PromiseLike<void>;
  readonly createReceiptPort: (transaction: Transaction) => ProductCommandReceiptPort;
  readonly appendAuditDecision: (
    transaction: Transaction,
    decision: WriteApprovalAuditDecision,
  ) => void | PromiseLike<void>;
  readonly listPlans: (
    filter: WriteApprovalListFilter,
  ) => readonly McpStoredPlan[] | PromiseLike<readonly McpStoredPlan[]>;
  readonly getPlan: (
    planId: string,
  ) => McpStoredPlan | undefined | PromiseLike<McpStoredPlan | undefined>;
}

export interface Phase4bMcpWriteApprovalApi {
  readonly list: (
    account: WriteApprovalAccount,
    options?: Readonly<{ readonly limit?: number }>,
  ) => Promise<WriteApprovalPage>;
  readonly get: (
    account: WriteApprovalAccount,
    planId: string,
  ) => Promise<WriteApprovalView | undefined>;
  readonly decide: (
    input: WriteApprovalDecisionInput,
  ) => Promise<Phase4bMcpWriteApprovalDecisionOutcome>;
}

export type WriteApprovalApiErrorCode =
  | 'plan_not_found'
  | 'precondition_failed'
  | 'decision_conflict'
  | 'unknown_outcome';

export class WriteApprovalApiError extends Error {
  readonly code: WriteApprovalApiErrorCode;
  readonly currentEtag: string | null;

  constructor(code: WriteApprovalApiErrorCode, message: string, currentEtag: string | null = null) {
    super(message);
    this.name = 'WriteApprovalApiError';
    this.code = code;
    this.currentEtag = currentEtag;
  }
}

const PLAN_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const DEFAULT_LIST_LIMIT = 100;

export function approvalEtag(plan: McpStoredPlan): string {
  const digest = createHash('sha256')
    .update(`${plan.planId}\0${plan.status}\0${plan.createdAt}`, 'utf8')
    .digest('base64url');
  return `"approval:${digest}"`;
}

export function createPhase4bMcpWriteApprovalApi<Transaction extends object>(
  ports: Phase4bMcpWriteApprovalPlanStorePorts<Transaction>,
): Phase4bMcpWriteApprovalApi {
  if (typeof ports !== 'object' || ports === null || nodeTypes.isProxy(ports)) {
    throw new TypeError('MCP-W07 approval ports must be an own-data object.');
  }
  for (const name of [
    'execute',
    'lockPlan',
    'updatePlan',
    'markApproved',
    'createReceiptPort',
    'appendAuditDecision',
    'listPlans',
    'getPlan',
  ] as const) {
    assertOwnDataFunction(
      ports as unknown as Phase4bMcpWriteApprovalPlanStorePorts<object>,
      name,
    );
  }

  const api: Phase4bMcpWriteApprovalApi = Object.freeze({
    async list(
      account: WriteApprovalAccount,
      options: Readonly<{ readonly limit?: number }> = {},
    ) {
      const limit = normalizeLimit(options.limit);
      const plans = await settle(ports.listPlans(Object.freeze({
        principalIds: uniquePrincipalIds(account),
        limit,
      })));
      const visible = plans
        .filter((plan) => isVisible(plan, account))
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt, 'en-US')
          || left.planId.localeCompare(right.planId, 'en-US'))
        .slice(0, limit)
        .map((plan) => toView(plan));
      return Object.freeze({
        items: Object.freeze(visible) as readonly WriteApprovalView[],
        nextCursor: null,
      });
    },

    async get(account: WriteApprovalAccount, planId: string) {
      const plan = await settle(ports.getPlan(planId));
      if (plan === undefined || !isVisible(plan, account)) return undefined;
      return toView(plan);
    },

    async decide(input: WriteApprovalDecisionInput) {
      const commandBinding: ProductCommandBinding = Object.freeze({
        principalId: input.account.id,
        commandScope: input.commandScope,
        commandId: input.commandId,
      });
      const now = input.now ?? new Date();
      const outcome = await ports.execute(async (transaction) => {
        const receipts = ports.createReceiptPort(transaction);
        const claim = await settle(receipts.claim(commandBinding, input.fingerprint));
        if (claim.kind !== 'claimed') return claim as Phase4bMcpWriteApprovalDecisionOutcome;

        try {
          const plan = await settle(ports.lockPlan(transaction, input.planId));
          if (plan === undefined || !isVisible(plan, input.account)) {
            throw new WriteApprovalApiError(
              'plan_not_found',
              'The requested approval was not found.',
            );
          }
          assertCurrentEtag(plan, input.ifMatch);
          assertDecisionAllowed(plan, now);

          const updated = input.decision === 'approve'
            ? await approvePlan(ports, transaction, plan)
            : Object.freeze({ ...plan, status: 'cancelled' as const });
          await settle(ports.updatePlan(transaction, updated));
          const result = buildDecisionResult(updated, input.decision);
          await settle(ports.appendAuditDecision(transaction, Object.freeze({
            planId: updated.planId,
            principalId: input.account.id,
            commandId: input.commandId,
            decision: result.decision,
            status: result.status,
            risk: updated.risk,
            operationsDigest: updated.operationsDigest,
          })));
          await settle(receipts.complete(
            commandBinding,
            input.fingerprint,
            toProductCommandResult(result),
          ));
          return { kind: 'succeeded' as const, result };
        } catch (error) {
          throw mapDecisionError(error);
        }
      }, input.signal === undefined ? undefined : { signal: input.signal });
      return outcome;
    },
  });
  return api;
}

function uniquePrincipalIds(account: WriteApprovalAccount): readonly string[] {
  return Object.freeze([account.id]);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('MCP-W07 approval list limit must be a positive safe integer.');
  }
  return Math.min(value, DEFAULT_LIST_LIMIT);
}

function isVisible(plan: McpStoredPlan, account: WriteApprovalAccount): boolean {
  return plan.binding.principalId === account.id;
}

function assertCurrentEtag(plan: McpStoredPlan, expected: string): void {
  const current = approvalEtag(plan);
  if (expected !== current) {
    throw new WriteApprovalApiError(
      'precondition_failed',
      'The Plan changed before the approval decision.',
      current,
    );
  }
}

function assertDecisionAllowed(plan: McpStoredPlan, now: Date): void {
  if (
    plan.status === 'cancelled'
    || plan.status === 'consumed'
    || plan.status === 'committing'
  ) {
    throw new WriteApprovalApiError(
      'decision_conflict',
      'The Plan is no longer available for this decision.',
    );
  }
  if (plan.status === 'expired' || Date.parse(plan.expiresAt) <= now.getTime()) {
    throw new WriteApprovalApiError(
      'decision_conflict',
      'The Plan expired before this decision.',
    );
  }
  if (plan.status !== 'pending' && plan.status !== 'approved') {
    throw new WriteApprovalApiError(
      'unknown_outcome',
      'The Plan is in an unknown decision state.',
    );
  }
}

async function approvePlan<Transaction extends object>(
  ports: Phase4bMcpWriteApprovalPlanStorePorts<Transaction>,
  transaction: Transaction,
  plan: McpStoredPlan,
): Promise<McpStoredPlan> {
  await settle(ports.markApproved(transaction, {
    planId: plan.planId,
    binding: plan.binding,
    operationsDigest: plan.operationsDigest,
  }));
  return Object.freeze({ ...plan, status: 'approved' as const });
}

function buildDecisionResult(
  plan: McpStoredPlan,
  decision: WriteApprovalDecision,
): WriteApprovalDecisionResult {
  if (decision === 'approve' && plan.status === 'approved') {
    return Object.freeze({
      kind: 'decided' as const,
      planId: plan.planId,
      decision: 'approved' as const,
      status: 'approved' as const,
      etag: approvalEtag(plan),
    });
  }
  if (decision === 'deny' && plan.status === 'cancelled') {
    return Object.freeze({
      kind: 'decided' as const,
      planId: plan.planId,
      decision: 'denied' as const,
      status: 'cancelled' as const,
      etag: approvalEtag(plan),
    });
  }
  throw new WriteApprovalApiError(
    'unknown_outcome',
    'The approval decision did not persist with a known outcome.',
  );
}

function toProductCommandResult(result: WriteApprovalDecisionResult): ProductCommandResult {
  return {
    status: 200,
    body: new TextEncoder().encode(JSON.stringify(result)),
    stableHeaders: stableReplayHeaders({
      etag: result.etag,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    }),
    mediaType: 'application/json',
    contractVersion: '1.14.0',
    targetIdentity: `mcp:approval:${result.planId}`,
  };
}

function toView(plan: McpStoredPlan): WriteApprovalView {
  return Object.freeze({
    planId: plan.planId,
    status: plan.status,
    risk: plan.risk,
    requiresApproval: plan.requiresApproval,
    summary: plan.summary,
    impact: toImpact(plan),
    requiredScopes: Object.freeze([...plan.requiredScopes]) as readonly string[],
    target: approvalTarget(plan),
    operations: Object.freeze(safeOperationPreviews(plan)),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    decision: decisionState(plan.status),
    etag: approvalEtag(plan),
  });
}

function toImpact(plan: McpStoredPlan): WriteApprovalImpact {
  const impact = plan.impact as unknown as Readonly<Record<string, unknown>>;
  return Object.freeze({
    collections: readCount(impact.collections),
    nodes: readCount(impact.nodes),
    annotations: readCount(impact.annotations),
    attachments: readCount(impact.attachments),
    relations: readCount(impact.relations),
    privateFieldsExcluded: Object.freeze(
      Array.isArray(impact.privateFieldsExcluded)
        ? impact.privateFieldsExcluded.filter((value): value is string => typeof value === 'string')
        : [],
    ),
  });
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function decisionState(status: WriteApprovalPlanStatus): WriteApprovalDecisionState {
  if (status === 'pending') return 'pending';
  if (status === 'approved' || status === 'committing' || status === 'consumed') return 'approved';
  if (status === 'cancelled') return 'denied';
  return 'expired';
}

function approvalTarget(plan: McpStoredPlan): WriteApprovalTarget {
  const operations = plan.operations as unknown as readonly Readonly<Record<string, unknown>>[];
  const collectionOperation = operations.find((operation) => typeof operation.collectionId === 'string');
  const collectionId = typeof collectionOperation?.collectionId === 'string'
    ? collectionOperation.collectionId
    : deriveCollectionId(plan);
  const nodeId = deriveNodeId(plan);
  if (nodeId !== null) {
    return Object.freeze({
      kind: 'node' as const,
      collectionId,
      nodeId,
    });
  }
  return Object.freeze({
    kind: 'collection' as const,
    collectionId,
    nodeId: null,
  });
}

function deriveCollectionId(plan: McpStoredPlan): string {
  for (const key of Object.keys(plan.baseRevisions)) {
    if (key.startsWith('content.')) return key.slice('content.'.length);
    if (key.startsWith('policy.')) return key.slice('policy.'.length);
    if (key.startsWith('resource.')) return key.slice('resource.'.length);
  }
  return '';
}

function deriveNodeId(plan: McpStoredPlan): string | null {
  for (const key of Object.keys(plan.baseRevisions)) {
    if (key.startsWith('node.')) {
      const nodeId = key.slice('node.'.length);
      if (PLAN_ID_PATTERN.test(nodeId)) return nodeId;
    }
  }
  return null;
}

function safeOperationPreviews(plan: McpStoredPlan): readonly WriteApprovalOperationPreview[] {
  const operations = plan.operations as unknown as readonly Readonly<Record<string, unknown>>[];
  return Object.freeze(operations.map((operation) => {
    const type = typeof operation.type === 'string' ? operation.type : 'unknown';
    const collectionId = typeof operation.collectionId === 'string' ? operation.collectionId : null;
    if (type === 'set_visibility') {
      const input = asRecord(operation.input);
      return Object.freeze({
        type,
        collectionId,
        nodeId: deriveNodeId(plan),
        visibility: typeof input.visibility === 'string' ? input.visibility : null,
        nodeSummary: null,
      });
    }
    if (type === 'move_node') {
      return Object.freeze({
        type,
        collectionId,
        nodeId: typeof operation.nodeId === 'string' ? operation.nodeId : null,
        visibility: null,
        nodeSummary: Object.freeze({
          kind: null,
          title: null,
          url: null,
          visibility: null,
        }),
      });
    }
    if (type === 'create_node') {
      const payload = asRecord(operation.payload);
      const node = asRecord(payload.node);
      return Object.freeze({
        type,
        collectionId,
        nodeId: null,
        visibility: null,
        nodeSummary: Object.freeze({
          kind: typeof node.kind === 'string' ? node.kind : null,
          title: typeof node.title === 'string' ? node.title : null,
          url: typeof node.url === 'string' ? node.url : null,
          visibility: typeof node.visibility === 'string' ? node.visibility : null,
        }),
      });
    }
    return Object.freeze({
      type,
      collectionId,
      nodeId: null,
      visibility: null,
      nodeSummary: null,
    });
  }));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function mapDecisionError(error: unknown): never {
  if (error instanceof WriteApprovalApiError) throw error;
  const code = readErrorCode(error);
  if (
    code === 'binding_mismatch'
    || code === 'digest_mismatch'
    || code === 'plan_not_found'
  ) {
    throw new WriteApprovalApiError('plan_not_found', 'The requested approval was not found.');
  }
  if (
    code === 'approval_conflict'
    || code === 'plan_expired'
    || code === 'plan_cancelled'
    || code === 'plan_already_consumed'
  ) {
    throw new WriteApprovalApiError(
      'decision_conflict',
      'The Plan is no longer available for this decision.',
    );
  }
  throw new WriteApprovalApiError(
    'unknown_outcome',
    'The approval decision did not complete with a known outcome.',
  );
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function assertOwnDataFunction(
  ports: Phase4bMcpWriteApprovalPlanStorePorts<object>,
  name: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(ports, name);
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError(`MCP-W07 approval port ${name} must be an own-data function.`);
  }
}

function settle<Value>(value: Value | PromiseLike<Value>): Promise<Value> {
  return Promise.resolve(value);
}
