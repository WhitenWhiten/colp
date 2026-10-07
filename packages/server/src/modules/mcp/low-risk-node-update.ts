/**
 * Low-risk MCP `nodes.update`. Applies a closed node merge patch with
 * `nodes:write` only. Preview (`dryRun: true`) inspects authorization and the
 * revision fence without opening the canonical mutation unit of work.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import { authorizeCapability } from '../access-policy/index.js';
import { assertCanonicalCommandId, canonicalJson } from '../commands/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  NodeConflictError,
  ifMatchSatisfied,
  isAcceptedBookmarkUrl,
  updateCollectionNode,
  updateCollectionNodeCommandScope,
  type NodeMergePatch,
  type ProductCollectionMutationUnitOfWork,
  type UpdateCollectionNodeResult,
} from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import {
  PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE,
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpLowRiskNodeCreateInspect,
  type Phase4bMcpWriteErrorHint,
} from './low-risk-node-create.js';
export const PHASE4B_MCP_NODES_UPDATE_TOOL_NAME = 'nodes.update' as const;

export const PHASE4B_MCP_STALE_REVISION_MESSAGE =
  'Collection or parent revision is stale.' as const;

const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const TITLE_MAX = 1_024;
const DESCRIPTION_MAX = 10_000;
const TAG_MAX_ITEMS = 128;
const TAG_MAX_LENGTH = 256;
const REASON_MAX = 1_000;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/u;

const INPUT_KEYS = Object.freeze([
  'collectionId',
  'nodeId',
  'baseRevision',
  'ifMatch',
  'patch',
  'dryRun',
  'reason',
] as const);

const PATCH_KEYS = Object.freeze([
  'title',
  'url',
  'description',
  'tags',
] as const);

export interface Phase4bMcpLowRiskNodeUpdateCompleteOutput {
  readonly resultType: 'complete';
  readonly nodeId: string;
  readonly collectionId: string;
  readonly revision: string;
}

export interface Phase4bMcpLowRiskNodeUpdatePreviewOutput {
  readonly resultType: 'preview';
  readonly nodeId: string;
  readonly collectionId: string;
}

export type Phase4bMcpLowRiskNodeUpdateOutput =
  | Phase4bMcpLowRiskNodeUpdateCompleteOutput
  | Phase4bMcpLowRiskNodeUpdatePreviewOutput;

export interface Phase4bMcpLowRiskNodeUpdateService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpLowRiskNodeUpdateOutput>;
}

export interface Phase4bMcpLowRiskNodeUpdateServiceOptions {
  readonly unitOfWork: ProductCollectionMutationUnitOfWork;
  readonly inspect?: Phase4bMcpLowRiskNodeCreateInspect;
}

interface ParsedNodeUpdateInput {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly baseRevision: string;
  readonly patch: NodeMergePatch;
  readonly reason: string | undefined;
  readonly dryRun: boolean;
}

export function createPhase4bMcpLowRiskNodeUpdateService(
  options: Phase4bMcpLowRiskNodeUpdateServiceOptions,
): Phase4bMcpLowRiskNodeUpdateService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP nodes.update options must be an own-data object.');
  }
  const unitOfWork = options.unitOfWork;
  const inspect = readOptionalInspect(options);
  return Object.freeze({
    execute: async (
      input: Readonly<Record<string, unknown>>,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ) => {
      const binding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(context.binding),
      );
      assertWriteScope(context.scope);
      const accountSubjectId = requireMcpAccountSubjectId({
        accountSubjectId: context.accountSubjectId,
      });
      const parsed = parseNodeUpdateInput(input);
      if (parsed.dryRun) {
        if (inspect === undefined) {
          throw new TypeError('nodes.update preview requires an inspect port.');
        }
        return executePreview(inspect, parsed, binding, accountSubjectId);
      }
      const facts = Object.freeze({
        collectionId: parsed.collectionId,
        nodeId: parsed.nodeId,
        baseRevision: parsed.baseRevision,
        patch: parsed.patch,
        reason: parsed.reason ?? null,
      });
      const commandId = deriveWriteCommandId(
        PHASE4B_MCP_NODES_UPDATE_TOOL_NAME,
        facts,
        binding,
      );
      const fingerprint = deriveWriteFingerprint(
        PHASE4B_MCP_NODES_UPDATE_TOOL_NAME,
        facts,
        binding,
      );
      try {
        const outcome = await unitOfWork.execute((ports) =>
          updateCollectionNode(ports, {
            actor: {
              principalId: binding.principalId,
              principalType: 'account',
              subjectId: accountSubjectId,
            },
            command: {
              commandId,
              fingerprint,
              commandScope: updateCollectionNodeCommandScope(
                parsed.collectionId,
                parsed.nodeId,
              ),
            },
            collectionId: parsed.collectionId,
            nodeId: parsed.nodeId,
            ifMatch: parsed.baseRevision,
            patch: parsed.patch,
          }));
        return projectNodeUpdateOutput(outcome);
      } catch (error) {
        mapCanonicalWriteError(error, PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
      }
    },
  });
}

async function executePreview(
  inspect: Phase4bMcpLowRiskNodeCreateInspect,
  parsed: ParsedNodeUpdateInput,
  binding: McpAuthenticatedAuthorizationBinding,
  accountSubjectId: string,
): Promise<Phase4bMcpLowRiskNodeUpdatePreviewOutput> {
  await inspect.execute(async (ports) => {
    const collection = await ports.getCollection(parsed.collectionId);
    if (!collection || collection.deletedAt !== null) {
      throwRejected(PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
    }
    const decision = await authorizeCapability(ports.accessPolicy, {
      collectionId: parsed.collectionId,
      actor: {
        principalId: binding.principalId,
        subjectId: accountSubjectId,
        kind: 'account',
      },
      capability: 'update_node',
    });
    if (decision.outcome !== 'allow') {
      if (decision.reasonCategory === 'policy_revision_mismatch') {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'stale_revision',
          PHASE4B_MCP_STALE_REVISION_MESSAGE,
        );
      }
      throwRejected(PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
    }
    const node = await ports.getNode(parsed.collectionId, parsed.nodeId);
    if (!node || node.deletedAt !== null) {
      throwRejected(PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
    }
    if (node.isRoot) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'Root nodes cannot be updated.',
        nodeUpdateHint('nodeId'),
      );
    }
    if (!ifMatchSatisfied(parsed.baseRevision, node.resourceRevision)) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'stale_revision',
        PHASE4B_MCP_STALE_REVISION_MESSAGE,
      );
    }
    return undefined;
  });
  return Object.freeze({
    resultType: 'preview',
    nodeId: parsed.nodeId,
    collectionId: parsed.collectionId,
  });
}

function projectNodeUpdateOutput(
  outcome: UpdateCollectionNodeResult,
): Phase4bMcpLowRiskNodeUpdateCompleteOutput {
  if (outcome.kind === 'updated') {
    return Object.freeze({
      resultType: 'complete',
      nodeId: outcome.node.id,
      collectionId: outcome.node.collectionId,
      revision: outcome.node.revision,
    });
  }
  if (outcome.kind === 'replay') {
    return decodeReplayNodeUpdate(outcome.body);
  }
  throw new Phase4bMcpLowRiskNodeCreateError(
    'commit_unknown',
    'nodes.update did not produce a durable committed or replayable result.',
  );
}

function decodeReplayNodeUpdate(body: Uint8Array): Phase4bMcpLowRiskNodeUpdateCompleteOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.update durable receipt is not valid JSON.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.update durable receipt must be a JSON object.',
    );
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const node = record.node;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.update durable receipt node is required.',
    );
  }
  const nodeRecord = node as Readonly<Record<string, unknown>>;
  const nodeId = nodeRecord.id;
  const collectionId = nodeRecord.collectionId;
  const revision = nodeRecord.revision;
  if (typeof nodeId !== 'string' || typeof collectionId !== 'string' || typeof revision !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'nodes.update durable receipt is missing node identity.',
    );
  }
  return Object.freeze({
    resultType: 'complete',
    nodeId,
    collectionId,
    revision,
  });
}

function parseNodeUpdateInput(
  input: Readonly<Record<string, unknown>>,
): ParsedNodeUpdateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'nodes.update input must be an object.',
    );
  }
  assertAllowedKeys(input, INPUT_KEYS, 'nodes.update input contains unknown fields.');
  const collectionId = readRequiredOpaqueId(input, 'collectionId');
  const nodeId = readRequiredOpaqueId(input, 'nodeId');
  const baseRevision = readRevisionFence(input, PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
  const patch = parseNodePatch(readRequiredObject(input, 'patch'));
  const dryRun = readDryRun(input, PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
  const reason = readOptionalReason(input, PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
  return Object.freeze({
    collectionId,
    nodeId,
    baseRevision,
    patch,
    reason,
    dryRun,
  });
}

function parseNodePatch(raw: Readonly<Record<string, unknown>>): NodeMergePatch {
  if (Object.hasOwn(raw, 'visibility')) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'nodes.update cannot change visibility; use changes.plan and approval.',
      Object.freeze({ field: 'patch.visibility' }),
    );
  }
  assertAllowedKeys(raw, PATCH_KEYS, 'nodes.update patch contains unknown fields.');
  const hasTitle = Object.hasOwn(raw, 'title');
  const hasUrl = Object.hasOwn(raw, 'url');
  const hasDescription = Object.hasOwn(raw, 'description');
  const hasTags = Object.hasOwn(raw, 'tags');
  if (!hasTitle && !hasUrl && !hasDescription && !hasTags) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'nodes.update patch must include at least one of title, url, description, or tags.',
      nodeUpdateHint('patch'),
    );
  }
  const patch: {
    title?: string;
    url?: string;
    description?: string | null;
    tags?: readonly string[] | null;
  } = {};
  if (hasTitle) {
    const title = raw.title;
    if (typeof title !== 'string' || title.length < 1 || title.length > TITLE_MAX) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'nodes.update title must be 1..1024 characters.',
        nodeUpdateHint('patch.title'),
      );
    }
    patch.title = title;
  }
  if (hasUrl) {
    const url = raw.url;
    if (typeof url !== 'string' || !isAcceptedBookmarkUrl(url)) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'nodes.update url must satisfy the canonical HTTP(S) URL contract.',
        nodeUpdateHint('patch.url'),
      );
    }
    patch.url = url;
  }
  if (hasDescription) {
    const description = raw.description;
    if (description !== null && typeof description !== 'string') {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'nodes.update description must be a string or null.',
        nodeUpdateHint('patch.description'),
      );
    }
    if (typeof description === 'string' && description.length > DESCRIPTION_MAX) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'nodes.update description must be at most 10000 characters.',
        nodeUpdateHint('patch.description'),
      );
    }
    patch.description = description as string | null;
  }
  if (hasTags) {
    patch.tags = readTags(raw.tags);
  }
  return Object.freeze(patch);
}

function readTags(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'nodes.update tags must be an array of strings or null.',
      nodeUpdateHint('patch.tags'),
    );
  }
  if (value.length > TAG_MAX_ITEMS) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'nodes.update tags must have at most 128 items.',
      nodeUpdateHint('patch.tags'),
    );
  }
  for (const tag of value) {
    if (tag.length < 1 || tag.length > TAG_MAX_LENGTH) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'nodes.update tags items must be 1..256 characters.',
        nodeUpdateHint('patch.tags'),
      );
    }
  }
  return Object.freeze([...value] as readonly string[]);
}

export function mapCanonicalWriteError(error: unknown, operation: string): never {
  if (error instanceof Phase4bMcpLowRiskNodeCreateError) throw error;
  if (error instanceof CollectionPreconditionError) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'stale_revision',
      PHASE4B_MCP_STALE_REVISION_MESSAGE,
    );
  }
  if (error instanceof CollectionAuthorizationError) {
    throwRejected(operation);
  }
  if (error instanceof NodeConflictError) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'Root nodes cannot be updated.',
      nodeUpdateHint('nodeId'),
    );
  }
  if (error instanceof CollectionsError) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} input was rejected.`,
    );
  }
  throw error;
}

export function throwRejected(operation: string): never {
  throw new Phase4bMcpLowRiskNodeCreateError(
    'policy_denied',
    `${operation} was rejected.`,
  );
}

export function readRevisionFence(
  input: Readonly<Record<string, unknown>>,
  operation: string,
): string {
  const hasBase = Object.hasOwn(input, 'baseRevision');
  const hasIfMatch = Object.hasOwn(input, 'ifMatch');
  if (!hasBase && !hasIfMatch) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} requires baseRevision.`,
      hintFor(operation, 'baseRevision'),
    );
  }
  const baseRevision = hasBase ? readRequiredString(input, 'baseRevision', operation) : undefined;
  const ifMatch = hasIfMatch ? readRequiredString(input, 'ifMatch', operation) : undefined;
  if (baseRevision !== undefined && ifMatch !== undefined && baseRevision !== ifMatch) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} baseRevision and ifMatch must be equal when both are present.`,
      hintFor(operation, 'baseRevision'),
    );
  }
  return baseRevision ?? ifMatch!;
}

export function readDryRun(
  input: Readonly<Record<string, unknown>>,
  operation: string,
): boolean {
  if (!Object.hasOwn(input, 'dryRun')) return false;
  if (input.dryRun === true) return true;
  throw new Phase4bMcpLowRiskNodeCreateError(
    'invalid_catalog_input',
    `${operation} applies by default; pass dryRun:true only to preview.`,
    hintFor(operation, 'dryRun'),
  );
}

function readOptionalReason(
  input: Readonly<Record<string, unknown>>,
  operation: string,
): string | undefined {
  if (!Object.hasOwn(input, 'reason')) return undefined;
  const reason = input.reason;
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > REASON_MAX
    || CONTROL_CHARACTER_RE.test(reason)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} reason must be 1..1000 characters and free of control characters.`,
      hintFor(operation, 'reason'),
    );
  }
  return reason;
}

export function deriveWriteCommandId(
  operation: string,
  facts: Readonly<Record<string, unknown>>,
  binding: McpAuthenticatedAuthorizationBinding,
): string {
  const canonical = canonicalJson(Object.freeze({
    operation,
    binding: snapshotMcpAuthorizationBinding(binding),
    facts,
  }));
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  const commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  assertCanonicalCommandId(commandId);
  return commandId;
}

export function deriveWriteFingerprint(
  operation: string,
  facts: Readonly<Record<string, unknown>>,
  binding: McpAuthenticatedAuthorizationBinding,
): string {
  return createHash('sha256').update(canonicalJson(Object.freeze({
    operation,
    binding: snapshotMcpAuthorizationBinding(binding),
    facts,
  })), 'utf8').digest('hex');
}

function assertWriteScope(scope: readonly string[]): void {
  if (
    !Array.isArray(scope)
    || scope.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || !scope.includes(PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE)
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'scope_invalid',
      'nodes.update requires the current nodes:write scope.',
    );
  }
}

function nodeUpdateHint(field: string): Phase4bMcpWriteErrorHint {
  return Object.freeze({ field, nextTool: PHASE4B_MCP_NODES_UPDATE_TOOL_NAME });
}

function hintFor(operation: string, field: string): Phase4bMcpWriteErrorHint {
  if (operation === PHASE4B_MCP_NODES_UPDATE_TOOL_NAME) return nodeUpdateHint(field);
  if (operation === 'annotations.create' || operation === 'annotations.update') {
    return Object.freeze({ field, nextTool: operation });
  }
  return Object.freeze({ field, nextTool: 'collections.update' });
}

function assertAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  message: string,
): void {
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string');
  if (keys.some((key) => !allowed.includes(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError('invalid_catalog_input', message);
  }
}

function readRequiredOpaqueId(
  input: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = readRequiredString(input, name, PHASE4B_MCP_NODES_UPDATE_TOOL_NAME);
  if (!ID_PATTERN.test(value)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `nodes.update ${name} must be a canonical opaque id.`,
      nodeUpdateHint(name),
    );
  }
  return value;
}

function readRequiredString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  operation: string,
): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} ${name} must be a non-empty string.`,
      hintFor(operation, name),
    );
  }
  return value;
}

function readRequiredObject(
  input: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  const value = input[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `nodes.update ${name} must be an object.`,
      nodeUpdateHint(name),
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function readOptionalInspect(
  options: Phase4bMcpLowRiskNodeUpdateServiceOptions,
): Phase4bMcpLowRiskNodeCreateInspect | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'inspect');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
    return undefined;
  }
  const candidate = descriptor.value;
  if (typeof candidate !== 'object' || candidate === null || nodeTypes.isProxy(candidate)) {
    throw new TypeError('nodes.update inspect must be an own-data object.');
  }
  const executeInspect = Object.getOwnPropertyDescriptor(candidate, 'execute')?.value;
  if (typeof executeInspect !== 'function' || nodeTypes.isProxy(executeInspect)) {
    throw new TypeError('nodes.update inspect.execute must be an own-data function.');
  }
  return candidate as Phase4bMcpLowRiskNodeCreateInspect;
}
