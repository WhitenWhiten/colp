/**
 * Low-risk MCP `collections.update`. Title and/or summary only; visibility,
 * slug, and indexing stay on Product HTTP / high-risk Plan. `nodes:write` only.
 */
import { types as nodeTypes } from 'node:util';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
} from '@know-n/colp/mcp';
import { authorizeCapability } from '../access-policy/index.js';
import {
  updateCollectionMetadataCanonical,
  updateCollectionMetadataCommandScope,
  ifMatchSatisfied,
  type ProductCollectionMutationUnitOfWork,
  type UpdateCollectionMetadataResult,
} from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import {
  PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE,
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpLowRiskNodeCreateInspect,
  type Phase4bMcpWriteErrorHint,
} from './low-risk-node-create.js';
import {
  deriveWriteCommandId,
  deriveWriteFingerprint,
  mapCanonicalWriteError,
  readDryRun,
  readRevisionFence,
  throwRejected,
  PHASE4B_MCP_STALE_REVISION_MESSAGE,
} from './low-risk-node-update.js';

export const PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME = 'collections.update' as const;

const TITLE_MAX = 512;
const SUMMARY_MAX = 2_000;

const INPUT_KEYS = Object.freeze([
  'collectionId',
  'baseRevision',
  'ifMatch',
  'patch',
  'dryRun',
] as const);

const PATCH_KEYS = Object.freeze(['title', 'summary'] as const);

export const PHASE4B_MCP_COLLECTIONS_UPDATE_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: Object.freeze({
    title: Object.freeze({ type: 'string', minLength: 1, maxLength: TITLE_MAX }),
    summary: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({ type: 'string', maxLength: SUMMARY_MAX }),
      ]),
    }),
  }),
} as const);

export const PHASE4B_MCP_COLLECTIONS_UPDATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    resultType: Object.freeze({ type: 'string', enum: Object.freeze(['complete', 'preview']) }),
    collectionId: Object.freeze({ type: 'string', minLength: 1 }),
    title: Object.freeze({ type: 'string' }),
    revision: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze(['resultType', 'collectionId', 'title']),
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

export interface Phase4bMcpLowRiskCollectionUpdateCompleteOutput {
  readonly resultType: 'complete';
  readonly collectionId: string;
  readonly title: string;
  readonly revision: string;
}

export interface Phase4bMcpLowRiskCollectionUpdatePreviewOutput {
  readonly resultType: 'preview';
  readonly collectionId: string;
  readonly title: string;
}

export type Phase4bMcpLowRiskCollectionUpdateOutput =
  | Phase4bMcpLowRiskCollectionUpdateCompleteOutput
  | Phase4bMcpLowRiskCollectionUpdatePreviewOutput;

export interface Phase4bMcpLowRiskCollectionUpdateService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpLowRiskCollectionUpdateOutput>;
}

export interface Phase4bMcpLowRiskCollectionUpdateServiceOptions {
  readonly unitOfWork: ProductCollectionMutationUnitOfWork;
  readonly inspect?: Phase4bMcpLowRiskNodeCreateInspect;
}

interface ParsedCollectionPatch {
  readonly title?: string;
  readonly summary?: string | null;
}

interface ParsedCollectionUpdateInput {
  readonly collectionId: string;
  readonly baseRevision: string;
  readonly patch: ParsedCollectionPatch;
  readonly dryRun: boolean;
}

export function createPhase4bMcpLowRiskCollectionUpdateService(
  options: Phase4bMcpLowRiskCollectionUpdateServiceOptions,
): Phase4bMcpLowRiskCollectionUpdateService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP collections.update options must be an own-data object.');
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
      const parsed = parseCollectionUpdateInput(input);
      if (parsed.dryRun) {
        if (inspect === undefined) {
          throw new TypeError('collections.update preview requires an inspect port.');
        }
        return executePreview(inspect, parsed, binding, accountSubjectId);
      }
      const facts = Object.freeze({
        collectionId: parsed.collectionId,
        baseRevision: parsed.baseRevision,
        patch: parsed.patch,
      });
      const commandId = deriveWriteCommandId(
        PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME,
        facts,
        binding,
      );
      const fingerprint = deriveWriteFingerprint(
        PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME,
        facts,
        binding,
      );
      try {
        const outcome = await unitOfWork.execute((ports) =>
          updateCollectionMetadataCanonical(ports, {
            actor: {
              principalId: binding.principalId,
              principalType: 'account',
              subjectId: accountSubjectId,
            },
            command: {
              commandId,
              fingerprint,
              commandScope: updateCollectionMetadataCommandScope(parsed.collectionId),
            },
            collectionId: parsed.collectionId,
            ifMatch: parsed.baseRevision,
            patch: parsed.patch,
          }));
        return projectCollectionUpdateOutput(outcome);
      } catch (error) {
        mapCanonicalWriteError(error, PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME);
      }
    },
  });
}

async function executePreview(
  inspect: Phase4bMcpLowRiskNodeCreateInspect,
  parsed: ParsedCollectionUpdateInput,
  binding: ReturnType<typeof requireAuthenticatedWriteBinding>,
  accountSubjectId: string,
): Promise<Phase4bMcpLowRiskCollectionUpdatePreviewOutput> {
  const title = await inspect.execute(async (ports) => {
    const collection = await ports.getCollection(parsed.collectionId);
    if (!collection || collection.deletedAt !== null) {
      throwRejected(PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME);
    }
    const decision = await authorizeCapability(ports.accessPolicy, {
      collectionId: parsed.collectionId,
      actor: {
        principalId: binding.principalId,
        subjectId: accountSubjectId,
        kind: 'account',
      },
      capability: 'update_collection_metadata',
    });
    if (decision.outcome !== 'allow') {
      if (decision.reasonCategory === 'policy_revision_mismatch') {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'stale_revision',
          PHASE4B_MCP_STALE_REVISION_MESSAGE,
        );
      }
      throwRejected(PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME);
    }
    if (!ifMatchSatisfied(parsed.baseRevision, collection.resourceRevision)) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'stale_revision',
        PHASE4B_MCP_STALE_REVISION_MESSAGE,
      );
    }
    return parsed.patch.title ?? collection.title;
  });
  return Object.freeze({
    resultType: 'preview',
    collectionId: parsed.collectionId,
    title,
  });
}

function projectCollectionUpdateOutput(
  outcome: UpdateCollectionMetadataResult,
): Phase4bMcpLowRiskCollectionUpdateCompleteOutput {
  if (outcome.kind === 'updated') {
    return Object.freeze({
      resultType: 'complete',
      collectionId: outcome.collection.id,
      title: outcome.collection.title,
      revision: outcome.collection.revision,
    });
  }
  if (outcome.kind === 'replay') {
    return decodeReplayCollectionUpdate(outcome.body);
  }
  throw new Phase4bMcpLowRiskNodeCreateError(
    'commit_unknown',
    'collections.update did not produce a durable committed or replayable result.',
  );
}

function decodeReplayCollectionUpdate(
  body: Uint8Array,
): Phase4bMcpLowRiskCollectionUpdateCompleteOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'collections.update durable receipt is not valid JSON.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'collections.update durable receipt must be a JSON object.',
    );
  }
  const collection = (parsed as { readonly collection?: unknown }).collection;
  if (typeof collection !== 'object' || collection === null || Array.isArray(collection)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'collections.update durable receipt collection is required.',
    );
  }
  const record = collection as Readonly<Record<string, unknown>>;
  const collectionId = record.id;
  const title = record.title;
  const revision = record.revision;
  if (typeof collectionId !== 'string' || typeof title !== 'string' || typeof revision !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'collections.update durable receipt is missing collection identity.',
    );
  }
  return Object.freeze({
    resultType: 'complete',
    collectionId,
    title,
    revision,
  });
}

function parseCollectionUpdateInput(
  input: Readonly<Record<string, unknown>>,
): ParsedCollectionUpdateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'collections.update input must be an object.',
    );
  }
  assertAllowedKeys(input, INPUT_KEYS, 'collections.update input contains unknown fields.');
  const collectionId = readRequiredString(input, 'collectionId');
  const baseRevision = readRevisionFence(input, PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME);
  const patch = parseCollectionPatch(readRequiredObject(input, 'patch'));
  const dryRun = readDryRun(input, PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME);
  return Object.freeze({
    collectionId,
    baseRevision,
    patch,
    dryRun,
  });
}

function parseCollectionPatch(raw: Readonly<Record<string, unknown>>): ParsedCollectionPatch {
  assertAllowedKeys(raw, PATCH_KEYS, 'collections.update patch contains unknown fields.');
  const hasTitle = Object.hasOwn(raw, 'title');
  const hasSummary = Object.hasOwn(raw, 'summary');
  if (!hasTitle && !hasSummary) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'collections.update patch must include at least one of title, summary.',
      collectionUpdateHint('patch'),
    );
  }
  const patch: { title?: string; summary?: string | null } = {};
  if (hasTitle) {
    const title = raw.title;
    if (typeof title !== 'string' || title.length < 1 || title.length > TITLE_MAX) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'collections.update title must be 1..512 characters.',
        collectionUpdateHint('patch.title'),
      );
    }
    patch.title = title;
  }
  if (hasSummary) {
    const summary = raw.summary;
    if (summary !== null && typeof summary !== 'string') {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'collections.update summary must be a string or null.',
        collectionUpdateHint('patch.summary'),
      );
    }
    if (typeof summary === 'string' && summary.length > SUMMARY_MAX) {
      throw new Phase4bMcpLowRiskNodeCreateError(
        'invalid_catalog_input',
        'collections.update summary must be at most 2000 characters.',
        collectionUpdateHint('patch.summary'),
      );
    }
    patch.summary = summary as string | null;
  }
  return Object.freeze(patch);
}

function assertWriteScope(scope: readonly string[]): void {
  if (
    !Array.isArray(scope)
    || scope.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || !scope.includes(PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE)
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'scope_invalid',
      'collections.update requires the current nodes:write scope.',
    );
  }
}

function collectionUpdateHint(field: string): Phase4bMcpWriteErrorHint {
  return Object.freeze({ field, nextTool: PHASE4B_MCP_COLLECTIONS_UPDATE_TOOL_NAME });
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

function readRequiredString(
  input: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `collections.update ${name} must be a non-empty string.`,
      collectionUpdateHint(name),
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
      `collections.update ${name} must be an object.`,
      collectionUpdateHint(name),
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function readOptionalInspect(
  options: Phase4bMcpLowRiskCollectionUpdateServiceOptions,
): Phase4bMcpLowRiskNodeCreateInspect | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'inspect');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
    return undefined;
  }
  const candidate = descriptor.value;
  if (typeof candidate !== 'object' || candidate === null || nodeTypes.isProxy(candidate)) {
    throw new TypeError('collections.update inspect must be an own-data object.');
  }
  const executeInspect = Object.getOwnPropertyDescriptor(candidate, 'execute')?.value;
  if (typeof executeInspect !== 'function' || nodeTypes.isProxy(executeInspect)) {
    throw new TypeError('collections.update inspect.execute must be an own-data function.');
  }
  return candidate as Phase4bMcpLowRiskNodeCreateInspect;
}
