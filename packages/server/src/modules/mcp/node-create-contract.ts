import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  CollectionFenceSnapshot, LockedCollectionRow, LockedNodeRow, ParentStateSnapshot,
  ProductCollectionCanonicalPorts, ProductCollectionMutationUnitOfWork,
} from '../collections/index.js';

export const PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT =
  'known.mcp.write.nodes.create.output.v1' as const;

export const PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE = 'nodes:write' as const;

export type Phase4bMcpLowRiskNodeCreateErrorCode =
  | 'invalid_catalog_input'
  | 'unknown_operation'
  | 'open_payload_rejected'
  | 'budget_exceeded'
  | 'scope_invalid'
  | 'stale_revision'
  | 'policy_denied'
  | 'parent_invalid'
  | 'secret_marker_rejected'
  | 'prompt_injection_rejected'
  | 'commit_unknown'
  | 'output_invalid'
  | 'authoritative_state_invalid';

export type Phase4bMcpWriteRetryTool =
  | 'nodes.create'
  | 'nodes.update'
  | 'collections.create'
  | 'collections.update'
  | 'annotations.create'
  | 'annotations.update';

export type Phase4bMcpWriteErrorHint = Readonly<{
  readonly field?: string;
  readonly nextTool?: Phase4bMcpWriteRetryTool;
}>;

export class Phase4bMcpLowRiskNodeCreateError extends Error {
  readonly code: Phase4bMcpLowRiskNodeCreateErrorCode;
  readonly field?: string;
  readonly nextTool?: Phase4bMcpWriteRetryTool;

  constructor(
    code: Phase4bMcpLowRiskNodeCreateErrorCode,
    message: string,
    hint: Phase4bMcpWriteErrorHint = {},
  ) {
    super(message);
    this.name = 'Phase4bMcpLowRiskNodeCreateError';
    this.code = code;
    if (hint.field !== undefined) this.field = hint.field;
    if (hint.nextTool !== undefined) this.nextTool = hint.nextTool;
  }
}

export function nodeCreateHint(field: string): Phase4bMcpWriteErrorHint {
  return Object.freeze({ field, nextTool: 'nodes.create' });
}

export interface Phase4bMcpLowRiskNodeCreateNode {
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit' | 'protected' | 'private';
  readonly url?: string;
}

export type McpNodeCreatePayload = Readonly<{
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility?: 'inherit' | 'protected' | 'private';
}> & (
  | { readonly kind: 'folder' }
  | { readonly kind: 'bookmark'; readonly url: string }
);

export interface Phase4bMcpLowRiskNodeCreateRequest {
  /** W03-validated `nodes.create` catalog input. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Canonical UUID v4 command idempotency key. */
  readonly idempotencyKey: string;
  /**
   * Optional W03 base revisions from the Plan (`children.<parentId>`,
   * `content.<collectionId>`, and optionally `policy.<collectionId>`).
   */
  readonly expectedBaseRevisions?: Readonly<Record<string, string>>;
}

export interface Phase4bMcpLowRiskNodeCreateContext {
  readonly binding: McpAuthenticatedAuthorizationBinding;
  /** `accounts.subject_id` from OAuth account resolution; never `accounts.id`. */
  readonly accountSubjectId: string;
  readonly scope: readonly string[];
  readonly budget?: Phase4bMcpLowRiskNodeCreateBudget;
}

export interface Phase4bMcpLowRiskNodeCreateBudget {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
  readonly maxOperations?: number;
}

export interface Phase4bMcpLowRiskNodeCreateInspectPorts {
  readonly getCollection: (collectionId: string) => Promise<LockedCollectionRow | null>;
  readonly getNode: (collectionId: string, nodeId: string) => Promise<LockedNodeRow | null>;
  readonly accessPolicy: ProductCollectionCanonicalPorts['accessPolicy'];
}

export interface Phase4bMcpLowRiskNodeCreateInspect {
  readonly execute: <Result>(
    work: (ports: Phase4bMcpLowRiskNodeCreateInspectPorts) => Promise<Result>,
  ) => Promise<Result>;
}

export interface Phase4bMcpLowRiskNodeCreateServiceOptions {
  readonly unitOfWork: ProductCollectionMutationUnitOfWork;
  /** Read-only inspection for preview. Must not persist writes. */
  readonly inspect?: Phase4bMcpLowRiskNodeCreateInspect;
  readonly inputBudget?: Phase4bMcpLowRiskNodeCreateBudget;
}

export interface Phase4bMcpLowRiskNodeCreateService {
  readonly execute: (
    request: unknown,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpLowRiskNodeCreateOutput>;
}

export interface Phase4bMcpLowRiskNodeCreateCompleteOutput {
  readonly resultType: 'complete';
  readonly outputContract: typeof PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT;
  readonly receipt: {
    readonly commandId: string;
    readonly status: number;
    readonly mediaType: string;
    readonly contractVersion: string;
  };
  readonly node: Phase4bMcpLowRiskNodeCreateResourceOutput;
  readonly parent: ParentStateSnapshot;
  readonly fence: CollectionFenceSnapshot;
  readonly appliedVisibility: 'inherit' | 'protected' | 'private';
}

export interface Phase4bMcpLowRiskNodeCreatePreviewNode {
  readonly collectionId: string;
  readonly parentId: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit' | 'protected' | 'private';
  readonly url?: string;
}

export interface Phase4bMcpLowRiskNodeCreatePreviewOutput {
  readonly resultType: 'preview';
  readonly outputContract: typeof PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT;
  readonly node: Phase4bMcpLowRiskNodeCreatePreviewNode;
  readonly parent: ParentStateSnapshot;
  readonly fence: CollectionFenceSnapshot;
  readonly appliedVisibility: 'inherit' | 'protected' | 'private';
}

export type Phase4bMcpLowRiskNodeCreateOutput =
  | Phase4bMcpLowRiskNodeCreateCompleteOutput
  | Phase4bMcpLowRiskNodeCreatePreviewOutput;

export function isPhase4bMcpLowRiskNodeCreateCompleteOutput(
  output: Phase4bMcpLowRiskNodeCreateOutput,
): output is Phase4bMcpLowRiskNodeCreateCompleteOutput {
  return output.resultType === 'complete';
}

export interface Phase4bMcpLowRiskNodeCreateResourceOutput {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit' | 'protected' | 'private';
  readonly position: string;
  readonly revision: string;
  readonly etag: string;
  readonly readOnly: false;
  readonly readOnlyReason: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url?: string;
  readonly iconUrl?: string | null;
  readonly childrenRevision?: string;
  readonly childrenEtag?: string;
}

