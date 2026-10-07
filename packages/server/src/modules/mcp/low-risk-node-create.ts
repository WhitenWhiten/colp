import { parseMcpNodeCreatePayload } from './node-create-payload.js';
import { MCP_OWN_DATA_DEFAULT_BUDGET } from './own-data.js';
import {
  executeMcpNodeCreate, computeNodeCreateFingerprint, loadAndAssertCreateState,
  requireAccountSubjectId, assertScope, type Phase4bMcpNodeCreateCommand, type CreateAdmissionSnapshot,
} from './node-create-execution.js';
export * from './node-create-contract.js';
import {
  PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT,
  Phase4bMcpLowRiskNodeCreateError,
  nodeCreateHint,
  type Phase4bMcpLowRiskNodeCreateRequest,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpLowRiskNodeCreateBudget,
  type Phase4bMcpLowRiskNodeCreateInspect,
  type Phase4bMcpLowRiskNodeCreateServiceOptions,
  type Phase4bMcpLowRiskNodeCreateService,
  type Phase4bMcpLowRiskNodeCreateCompleteOutput,
  type Phase4bMcpLowRiskNodeCreatePreviewOutput,
  type Phase4bMcpLowRiskNodeCreateOutput,
  type Phase4bMcpLowRiskNodeCreateResourceOutput,
} from './node-create-contract.js';
import { snapshotMcpOwnData as snapshotPhase4bMcpData } from './own-data.js';
/**
 * MCP-W04 low-risk Canonical Node create application service.
 *
 * This module accepts the W03-validated `nodes.create` catalog shape plus a
 * trusted authenticated binding, scope, and per-request budget. Catalog input
 * is a fail-closed discriminated union: preview (`dryRun: true`) inspects
 * current authorization, policy, risk, and revisions without opening the
 * canonical mutation unit of work; apply (the default when `dryRun` is
 * omitted) rechecks the same gates inside the mutation unit of work and
 * reuses `createCollectionNode`. `confirmApply` is accepted for compatibility:
 * explicit `false` previews without writing, while omission preserves the
 * apply-by-default contract. Apply returns a closed, secret-safe, replayable result
 * and fails closed for unknown operations, stale revisions/policy, prompt
 * injection, secret markers, budget overflow, and unknown commit outcomes.
 *
 * MCP-W04 deliberately does not mount a transport route and does not expose a
 * claim. The route remains the responsibility of MCP-W06.
 */
import { types as nodeTypes } from 'node:util';

import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  assertCanonicalCommandId,
} from '../commands/index.js';
import {
  CREATE_COLLECTION_NODE_CONTRACT_VERSION,
  strongEntityTag,
  type BookmarkNodeView,
  type CollectionFenceSnapshot,
  type CreateCollectionNodeResult,
  type EditableNodeView,
  type FolderNodeView,
  type ParentStateSnapshot,
  type ProductCollectionCanonicalPorts,
} from '../collections/index.js';
import {
  PHASE4B_MCP_NODE_CREATE_DEFAULT_REASON,
} from './node-create-catalog.js';

interface ParsedLowRiskNodeCreateRequest {
  readonly command: Phase4bMcpNodeCreateCommand;
  readonly mode: 'preview' | 'apply';
}

interface OutputProjectionInput {
  readonly commandId: string;
  readonly status: number;
  readonly mediaType: string;
  readonly contractVersion: string;
  readonly node: EditableNodeView;
  readonly parent: ParentStateSnapshot;
  readonly fence: CollectionFenceSnapshot;
}

const CREATE_BASE_KEYS = Object.freeze([
  'tool',
  'collectionId',
  'node',
] as const);

const CREATE_ALLOWED_KEYS = Object.freeze([
  ...CREATE_BASE_KEYS,
  'parentId',
  'afterId',
  'beforeId',
  'reason',
  'dryRun',
  'confirmApply',
] as const);

const CREATE_INTENT_MESSAGE =
  'nodes.create applies by default; pass dryRun:true or confirmApply:false to preview.';

const SECRET_KEY_MARKERS = Object.freeze([
  'session',
  'sessionid',
  'mcpsessionid',
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'authorization',
  'privatekey',
  'apikey',
] as const);

const RAW_SECRET_PREFIXES = Object.freeze([
  'Bearer ',
  'Basic ',
  'sk-',
  'pk-live-',
  'pk-test-',
  'ghp_',
  'gho_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'AKIA',
  'ya29.',
  'eyJ',
] as const);

const PROMPT_INJECTION_MARKERS = Object.freeze([
  'ignore previous',
  'ignore all',
  'disregard',
  'system prompt',
  'system:',
  'now act as',
  'you are now',
  'forget instructions',
] as const);

const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/u;
const UNTRUSTED_NOTE_MAX_LENGTH = 1_000;

export function createPhase4bMcpLowRiskNodeCreateService(
  options: Phase4bMcpLowRiskNodeCreateServiceOptions,
): Phase4bMcpLowRiskNodeCreateService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP-W04 service options must be an own-data object.');
  }
  const unitOfWork = readRequiredOwnValue(options, 'unitOfWork', 'MCP-W04 service options');
  if (typeof unitOfWork !== 'object' || unitOfWork === null || nodeTypes.isProxy(unitOfWork)) {
    throw new TypeError('MCP-W04 requires a unitOfWork port.');
  }
  const execute = Object.getOwnPropertyDescriptor(unitOfWork, 'execute')?.value;
  if (typeof execute !== 'function' || nodeTypes.isProxy(execute)) {
    throw new TypeError('MCP-W04 unitOfWork.execute must be an own-data function.');
  }
  const inspect = readOptionalInspect(options);
  const configuredBudget = resolveBudget(options.inputBudget);

  return Object.freeze({
    execute: async (
      request: unknown,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ): Promise<Phase4bMcpLowRiskNodeCreateOutput> => {
      const ownedBinding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(context.binding),
      );
      assertScope(context.scope);
      const budget = resolveBudget(context.budget, configuredBudget);
      const parsed = validateRequest(request, ownedBinding, budget);
      const accountSubjectId = requireAccountSubjectId(context.accountSubjectId);
      if (parsed.mode === 'preview') {
        if (inspect === undefined) {
          throw new TypeError('MCP-W04 preview requires an inspect port.');
        }
        return executePreview(inspect, parsed, ownedBinding, accountSubjectId);
      }
      const result = await Reflect.apply(execute, unitOfWork, [
        (ports: ProductCollectionCanonicalPorts) => executeMcpNodeCreate(ports, parsed.command, {
          binding: ownedBinding, accountSubjectId, scope: context.scope,
        }),
      ]) as CreateCollectionNodeResult;

      return projectLowRiskNodeCreateOutput(result, parsed.command.idempotencyKey);
    },
  });
}

export function computeLowRiskNodeCreateFingerprint(
  request: Phase4bMcpLowRiskNodeCreateRequest,
  binding: McpAuthenticatedAuthorizationBinding,
): string {
  const budget = MCP_OWN_DATA_DEFAULT_BUDGET;
  const parsed = validateRequest(request, requireAuthenticatedWriteBinding(binding), budget);
  return computeNodeCreateFingerprint(parsed.command, binding);
}

export function projectLowRiskNodeCreateOutput(
  result: CreateCollectionNodeResult,
  commandId: string,
): Phase4bMcpLowRiskNodeCreateCompleteOutput {
  let projection: OutputProjectionInput;
  if (result.kind === 'created') {
    projection = {
      commandId,
      status: 201,
      mediaType: 'application/json',
      contractVersion: CREATE_COLLECTION_NODE_CONTRACT_VERSION,
      node: result.node,
      parent: result.parent,
      fence: result.fence,
    };
  } else if (result.kind === 'replay') {
    projection = {
      ...decodeReplayBody(result.body),
      commandId,
      status: result.status,
      mediaType: result.mediaType,
      contractVersion: result.contractVersion,
    };
  } else {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'commit_unknown',
      'nodes.create did not produce a durable committed or replayable result.',
    );
  }

  const output = buildOutputProjection(projection);
  assertNoPromptInjection(output);
  assertNoSecretMarkers(output);
  return output;
}

async function executePreview(
  inspect: Phase4bMcpLowRiskNodeCreateInspect,
  parsed: ParsedLowRiskNodeCreateRequest,
  binding: McpAuthenticatedAuthorizationBinding,
  accountSubjectId: string,
): Promise<Phase4bMcpLowRiskNodeCreatePreviewOutput> {
  const snapshot = await inspect.execute((ports) => loadAndAssertCreateState({
    loadCollection: ports.getCollection,
    getNode: ports.getNode,
    accessPolicy: ports.accessPolicy,
  }, parsed.command, binding, accountSubjectId, { fence: true }));
  const output = projectPreviewOutput(parsed, snapshot);
  assertNoPromptInjection(output);
  assertNoSecretMarkers(output);
  return output;
}

function validateRequest(
  request: unknown,
  binding: McpAuthenticatedAuthorizationBinding,
  budget: Required<Phase4bMcpLowRiskNodeCreateBudget>,
): ParsedLowRiskNodeCreateRequest {
  let snapshot: unknown;
  try {
    snapshot = snapshotPhase4bMcpData(request, budget);
  } catch {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'budget_exceeded',
      'MCP-W04 nodes.create request exceeded the configured resource budget.',
    );
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'MCP-W04 request must be a plain object.',
    );
  }
  const snapshotRecord = snapshot as Readonly<Record<string, unknown>>;
  assertNoPromptInjection(snapshot);
  assertNoSecretMarkers(snapshot);
  assertOnlyKeys(
    snapshotRecord,
    ['input', 'idempotencyKey', 'expectedBaseRevisions'],
    'MCP-W04 request contains unknown fields.',
  );

  const rawInput = readOwnRequiredObject(snapshotRecord, 'input', 'MCP-W04 request');
  assertCatalogInputKeys(rawInput);
  const tool = readOwnRequiredString(rawInput, 'tool', 'MCP-W04 catalog input');
  if (tool !== 'nodes.create') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'unknown_operation',
      'MCP-W04 executes only the allowlisted low-risk nodes.create operation.',
      nodeCreateHint('tool'),
    );
  }
  const createMode = classifyCreateMode(rawInput);
  const collectionId = readOwnRequiredString(
    rawInput,
    'collectionId',
    'MCP-W04 catalog input',
  );
  const parentId = readOptionalOpaqueId(rawInput, 'parentId', 'MCP-W04 catalog input')
    ?? undefined;
  assertOpaqueId(collectionId, 'collectionId');
  if (parentId !== undefined) assertOpaqueId(parentId, 'parentId');
  const afterId = readOptionalOpaqueId(rawInput, 'afterId', 'MCP-W04 catalog input');
  const beforeId = readOptionalOpaqueId(rawInput, 'beforeId', 'MCP-W04 catalog input');
  const reason = Object.hasOwn(rawInput, 'reason')
    ? readOwnRequiredString(rawInput, 'reason', 'MCP-W04 catalog input')
    : PHASE4B_MCP_NODE_CREATE_DEFAULT_REASON;
  if (reason.length > UNTRUSTED_NOTE_MAX_LENGTH || CONTROL_CHARACTER_RE.test(reason)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'MCP-W04 reason must be at most 1000 code units and free of control characters.',
      nodeCreateHint('reason'),
    );
  }
  const rawNode = readOwnRequiredObject(rawInput, 'node', 'MCP-W04 catalog input');
  const node = parseMcpNodeCreatePayload(rawNode);

  const idempotencyKey = readOwnRequiredString(
    snapshotRecord,
    'idempotencyKey',
    'MCP-W04 request',
  );
  try {
    assertCanonicalCommandId(idempotencyKey);
  } catch {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'MCP-W04 idempotencyKey must be a canonical lowercase UUID v4.',
      nodeCreateHint('idempotencyKey'),
    );
  }

  const expectedBaseRevisions = readExpectedBaseRevisions(snapshotRecord);
  return Object.freeze({
    mode: createMode,
    command: Object.freeze({
      collectionId,
      ...(parentId === undefined ? {} : { parentId }),
      afterId, beforeId, node, idempotencyKey, expectedBaseRevisions,
    }),
  });
}

function readExpectedBaseRevisions(
  snapshot: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const descriptor = Object.getOwnPropertyDescriptor(snapshot, 'expectedBaseRevisions');
  if (descriptor === undefined) return Object.freeze({});
  if (!('value' in descriptor)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'MCP-W04 expectedBaseRevisions must be an own data property.',
      nodeCreateHint('expectedBaseRevisions'),
    );
  }
  if (descriptor.value === null) return Object.freeze({});
  // The complete request was already copied and budgeted at admission.
  const expectedSnapshot: unknown = descriptor.value;
  if (typeof expectedSnapshot !== 'object' || expectedSnapshot === null || Array.isArray(expectedSnapshot)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'MCP-W04 expectedBaseRevisions must be an object.',
      nodeCreateHint('expectedBaseRevisions'),
    );
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(expectedSnapshot)) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'MCP-W04 expectedBaseRevisions values must be canonical revision tokens.',
        nodeCreateHint('expectedBaseRevisions'),
      );
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function buildOutputProjection(
  input: OutputProjectionInput,
): Phase4bMcpLowRiskNodeCreateCompleteOutput {
  const node = projectNode(input.node);
  return Object.freeze({
    resultType: 'complete',
    outputContract: PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT,
    receipt: Object.freeze({
      commandId: input.commandId,
      status: input.status,
      mediaType: input.mediaType,
      contractVersion: input.contractVersion,
    }),
    node,
    parent: Object.freeze({
      id: input.parent.id,
      childrenRevision: input.parent.childrenRevision,
      childrenEtag: input.parent.childrenEtag,
    }),
    fence: Object.freeze({
      contentRevision: input.fence.contentRevision,
      contentEtag: input.fence.contentEtag,
      policyRevision: input.fence.policyRevision,
      policyEtag: input.fence.policyEtag,
    }),
    appliedVisibility: node.visibility,
  });
}

function projectNode(
  node: EditableNodeView,
): Phase4bMcpLowRiskNodeCreateResourceOutput {
  const common = {
    id: node.id,
    collectionId: node.collectionId,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    description: node.description,
    tags: Object.freeze([...node.tags]),
    visibility: node.visibility,
    position: node.position,
    revision: node.revision,
    etag: node.etag,
    readOnly: node.readOnly as false,
    readOnlyReason: node.readOnlyReason as null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
  if (node.kind === 'folder') {
    const folder = node as FolderNodeView;
    return Object.freeze({
      ...common,
      childrenRevision: folder.childrenRevision,
      childrenEtag: folder.childrenEtag,
    });
  }
  const bookmark = node as BookmarkNodeView;
  return Object.freeze({
    ...common,
    url: bookmark.url,
    iconUrl: bookmark.iconUrl ?? null,
  });
}

function decodeReplayBody(body: Uint8Array): Omit<OutputProjectionInput, 'commandId' | 'status' | 'mediaType' | 'contractVersion'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
  } catch {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt is not valid JSON.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt must be a JSON object.',
    );
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const rawNode = readOwnRequiredObject(record, 'node', 'nodes.create receipt');
  const parent = readOwnRequiredObject(record, 'parent', 'nodes.create receipt');
  const fence = readOwnRequiredObject(record, 'fence', 'nodes.create receipt');
  return Object.freeze({
    node: decodeReplayNode(rawNode),
    parent: {
      id: readOwnRequiredString(parent, 'id', 'nodes.create receipt parent'),
      childrenRevision: readOwnRequiredString(
        parent,
        'childrenRevision',
        'nodes.create receipt parent',
      ),
      childrenEtag: readOwnRequiredString(
        parent,
        'childrenEtag',
        'nodes.create receipt parent',
      ),
    },
    fence: {
      contentRevision: readOwnRequiredString(fence, 'contentRevision', 'nodes.create receipt fence'),
      contentEtag: readOwnRequiredString(fence, 'contentEtag', 'nodes.create receipt fence'),
      policyRevision: readOwnRequiredString(fence, 'policyRevision', 'nodes.create receipt fence'),
      policyEtag: readOwnRequiredString(fence, 'policyEtag', 'nodes.create receipt fence'),
    },
  });
}

function decodeReplayNode(
  raw: Readonly<Record<string, unknown>>,
): EditableNodeView {
  const id = readReplayOwnRequiredString(raw, 'id', 'node');
  const collectionId = readReplayOwnRequiredString(raw, 'collectionId', 'node');
  const parentId = readReplayOwnRequiredString(raw, 'parentId', 'node');
  const kind = readReplayOwnRequiredString(raw, 'kind', 'node');
  if (kind !== 'folder' && kind !== 'bookmark') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.kind must be folder or bookmark.',
    );
  }
  const title = readReplayOwnRequiredString(raw, 'title', 'node');
  const description = readReplayOwnRequiredValue(raw, 'description', 'node');
  if (description !== null && typeof description !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.description must be a string or null.',
    );
  }
  const tags = readReplayOwnRequiredValue(raw, 'tags', 'node');
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.tags must be an array of strings.',
    );
  }
  const visibility = readReplayOwnRequiredString(raw, 'visibility', 'node');
  if (visibility !== 'inherit' && visibility !== 'protected' && visibility !== 'private') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.visibility must be inherit, protected, or private.',
    );
  }
  const position = readReplayOwnRequiredString(raw, 'position', 'node');
  const revision = readReplayOwnRequiredString(raw, 'revision', 'node');
  const etag = readReplayOwnRequiredString(raw, 'etag', 'node');
  const readOnly = readReplayOwnRequiredValue(raw, 'readOnly', 'node');
  if (readOnly !== false) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.readOnly must be false.',
    );
  }
  const readOnlyReason = readReplayOwnRequiredValue(raw, 'readOnlyReason', 'node');
  if (readOnlyReason !== null) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.readOnlyReason must be null.',
    );
  }
  const createdAt = readReplayOwnRequiredString(raw, 'createdAt', 'node');
  const updatedAt = readReplayOwnRequiredString(raw, 'updatedAt', 'node');
  const common = Object.freeze({
    id,
    collectionId,
    parentId,
    title,
    description: description as string | null,
    tags: Object.freeze([...tags] as readonly string[]),
    visibility,
    position,
    revision,
    etag,
    readOnly: false as const,
    readOnlyReason: null,
    createdAt,
    updatedAt,
  });
  if (kind === 'folder') {
    return Object.freeze({
      ...common,
      kind,
      childrenRevision: readReplayOwnRequiredString(raw, 'childrenRevision', 'node'),
      childrenEtag: readReplayOwnRequiredString(raw, 'childrenEtag', 'node'),
    }) as unknown as EditableNodeView;
  }
  return Object.freeze({
    ...common,
    kind,
    url: readReplayOwnRequiredString(raw, 'url', 'node'),
    iconUrl: decodeReplayIconUrl(raw),
  }) as unknown as EditableNodeView;
}

function decodeReplayIconUrl(raw: Readonly<Record<string, unknown>>): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'iconUrl');
  if (descriptor === undefined || !('value' in descriptor)) return null;
  const value = descriptor.value;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.create durable receipt node.iconUrl must be a string or null.',
    );
  }
  return value;
}

function readReplayOwnRequiredValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      `nodes.create durable receipt ${label}.${key} is required.`,
    );
  }
  return descriptor.value;
}

function readReplayOwnRequiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const candidate = readReplayOwnRequiredValue(value, key, label);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      `nodes.create durable receipt ${label}.${key} must be a non-empty string.`,
    );
  }
  return candidate;
}

function assertNoPromptInjection(value: unknown): void {
  const strings = collectStrings(value, new WeakSet<object>());
  for (const text of strings) {
    const lower = text.toLocaleLowerCase('und');
    if (PROMPT_INJECTION_MARKERS.some((marker) => lower.includes(marker))) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'prompt_injection_rejected',
        'nodes.create input or output contains a prompt-injection marker.',
      );
    }
  }
}

function assertNoSecretMarkers(value: unknown): void {
  if (typeof value === 'string') {
    if (RAW_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'secret_marker_rejected',
        'nodes.create input or output contains raw credential material.',
      );
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (nodeTypes.isProxy(value)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'secret_marker_rejected',
      'nodes.create input or output must not contain Proxies.',
    );
  }
  assertNoSecretMarkersInternal(value, new WeakSet<object>());
}

function assertNoSecretMarkersInternal(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertNoSecretMarkers(item);
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'secret_marker_rejected',
          'nodes.create input or output must not contain symbol keys.',
        );
      }
      const normalized = key.replace(/[-_]/gu, '').toLocaleLowerCase('und');
      if (SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker))) {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'secret_marker_rejected',
          `nodes.create input or output rejected secret/session field ${key}.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      assertNoSecretMarkers(descriptor.value);
      if (typeof descriptor.value === 'string'
        && RAW_SECRET_PREFIXES.some((prefix) => descriptor.value.startsWith(prefix))) {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'secret_marker_rejected',
          `nodes.create input or output contains raw credential material in ${key}.`,
        );
      }
    }
  } finally {
    seen.delete(value);
  }
}

function collectStrings(value: unknown, seen: WeakSet<object>): readonly string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (nodeTypes.isProxy(value) || seen.has(value)) return [];
  seen.add(value);
  try {
    const result: string[] = [];
    if (Array.isArray(value)) {
      for (const item of value) result.push(...collectStrings(item, seen));
      return result;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') result.push(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        result.push(...collectStrings(descriptor.value, seen));
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function classifyCreateMode(
  rawInput: Readonly<Record<string, unknown>>,
): 'preview' | 'apply' {
  const hasDryRun = Object.hasOwn(rawInput, 'dryRun');
  const dryRun = hasDryRun
    ? readOwnRequiredValue(rawInput, 'dryRun', 'MCP-W04 catalog input')
    : undefined;
  if (hasDryRun && dryRun !== true && dryRun !== false) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      CREATE_INTENT_MESSAGE,
      nodeCreateHint('dryRun'),
    );
  }
  const hasConfirmApply = Object.hasOwn(rawInput, 'confirmApply');
  const confirmApply = hasConfirmApply
    ? readOwnRequiredValue(rawInput, 'confirmApply', 'MCP-W04 catalog input')
    : undefined;
  if (hasConfirmApply && confirmApply !== true && confirmApply !== false) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      CREATE_INTENT_MESSAGE,
      nodeCreateHint('confirmApply'),
    );
  }
  if (dryRun === true || confirmApply === false) return 'preview';
  return 'apply';
}

function assertCatalogInputKeys(rawInput: Readonly<Record<string, unknown>>): void {
  const keys = Reflect.ownKeys(rawInput).filter((key): key is string => typeof key === 'string');
  const allowed = new Set<string>(CREATE_ALLOWED_KEYS);
  if (keys.some((key) => !allowed.has(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'open_payload_rejected',
      'MCP-W04 catalog input contains unknown fields.',
    );
  }
  if (CREATE_BASE_KEYS.some((key) => !keys.includes(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'open_payload_rejected',
      'MCP-W04 catalog input contains unknown fields.',
    );
  }
}

function projectPreviewOutput(
  parsed: ParsedLowRiskNodeCreateRequest,
  snapshot: CreateAdmissionSnapshot,
): Phase4bMcpLowRiskNodeCreatePreviewOutput {
  const node = parsed.command.node;
  const visibility = snapshot.appliedVisibility;
  const parentId = snapshot.parentId;
  const previewNode = node.kind === 'folder'
    ? Object.freeze({
      collectionId: parsed.command.collectionId,
      parentId,
      kind: 'folder' as const,
      title: node.title,
      description: node.description,
      tags: node.tags,
      visibility,
    })
    : Object.freeze({
      collectionId: parsed.command.collectionId,
      parentId,
      kind: 'bookmark' as const,
      title: node.title,
      description: node.description,
      tags: node.tags,
      visibility,
      url: node.url,
    });
  return Object.freeze({
    resultType: 'preview',
    outputContract: PHASE4B_MCP_NODE_CREATE_OUTPUT_CONTRACT,
    node: previewNode,
    parent: Object.freeze({
      id: snapshot.parent.id,
      childrenRevision: snapshot.parent.childrenRevision,
      childrenEtag: strongEntityTag(snapshot.parent.childrenRevision),
    }),
    fence: Object.freeze({
      contentRevision: snapshot.collection.contentRevision,
      contentEtag: strongEntityTag(snapshot.collection.contentRevision),
      policyRevision: snapshot.collection.policyRevision,
      policyEtag: strongEntityTag(snapshot.collection.policyRevision),
    }),
    appliedVisibility: visibility,
  });
}

function readOptionalInspect(
  options: Phase4bMcpLowRiskNodeCreateServiceOptions,
): Phase4bMcpLowRiskNodeCreateInspect | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'inspect');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
    return undefined;
  }
  const candidate = descriptor.value;
  if (typeof candidate !== 'object' || candidate === null || nodeTypes.isProxy(candidate)) {
    throw new TypeError('MCP-W04 inspect must be an own-data object.');
  }
  const executeInspect = Object.getOwnPropertyDescriptor(candidate, 'execute')?.value;
  if (typeof executeInspect !== 'function' || nodeTypes.isProxy(executeInspect)) {
    throw new TypeError('MCP-W04 inspect.execute must be an own-data function.');
  }
  return candidate as Phase4bMcpLowRiskNodeCreateInspect;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  message: string,
): void {
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string');
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError('open_payload_rejected', message);
  }
}

function assertNoUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  message: string,
): void {
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string');
  if (keys.some((key) => !allowed.includes(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError('open_payload_rejected', message);
  }
}

function catalogField(label: string, key: string): string {
  return label === 'MCP-W04 node payload' ? `node.${key}` : key;
}

function assertOpaqueId(value: string, label: string, field = label): void {
  if (!ID_PATTERN.test(value)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${label} must be a canonical opaque id.`,
      nodeCreateHint(field),
    );
  }
}

function readOptionalOpaqueId(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return null;
  if (!('value' in descriptor) || (descriptor.value !== null && typeof descriptor.value !== 'string')) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${label}.${key} must be a string or null.`,
      nodeCreateHint(key),
    );
  }
  if (descriptor.value === null) return null;
  assertOpaqueId(descriptor.value, `${label}.${key}`, key);
  return descriptor.value;
}

function readOwnRequiredObject(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): Readonly<Record<string, unknown>> {
  const candidate = readOwnRequiredValue(value, key, label);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${label}.${key} must be an object.`,
      nodeCreateHint(catalogField(label, key)),
    );
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function readOwnRequiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const candidate = readOwnRequiredValue(value, key, label);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${label}.${key} must be a non-empty string.`,
      nodeCreateHint(catalogField(label, key)),
    );
  }
  return candidate;
}

function readOwnRequiredValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${label} requires own data property ${key}.`,
      nodeCreateHint(catalogField(label, key)),
    );
  }
  return descriptor.value;
}

function readRequiredOwnValue(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`${label} requires own data property ${key}.`);
  }
  return descriptor.value;
}

function resolveBudget(
  candidate?: Phase4bMcpLowRiskNodeCreateBudget,
  fallback: Required<Phase4bMcpLowRiskNodeCreateBudget> = MCP_OWN_DATA_DEFAULT_BUDGET,
): Required<Phase4bMcpLowRiskNodeCreateBudget> {
  if (candidate === undefined) return fallback;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || Array.isArray(candidate)
    || nodeTypes.isProxy(candidate)
  ) {
    throw new TypeError('MCP-W04 budget must be an own-data object.');
  }
  const resolved = {
    maxDepth: readBudgetLimit(candidate, 'maxDepth', fallback.maxDepth),
    maxNodes: readBudgetLimit(candidate, 'maxNodes', fallback.maxNodes),
    maxBytes: readBudgetLimit(candidate, 'maxBytes', fallback.maxBytes),
    maxOperations: readBudgetLimit(candidate, 'maxOperations', fallback.maxOperations),
  };
  if (
    !Number.isSafeInteger(resolved.maxDepth) || resolved.maxDepth < 0
    || !Number.isSafeInteger(resolved.maxNodes) || resolved.maxNodes < 1
    || !Number.isSafeInteger(resolved.maxBytes) || resolved.maxBytes < 1
    || !Number.isSafeInteger(resolved.maxOperations) || resolved.maxOperations < 1
  ) {
    throw new TypeError('MCP-W04 budget contains invalid limits.');
  }
  return Object.freeze(resolved);
}

function readBudgetLimit(
  value: Phase4bMcpLowRiskNodeCreateBudget,
  name: keyof Phase4bMcpLowRiskNodeCreateBudget,
  fallback: number,
): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return fallback;
  if (!('value' in descriptor) || descriptor.value === undefined) return fallback;
  return descriptor.value as number;
}
