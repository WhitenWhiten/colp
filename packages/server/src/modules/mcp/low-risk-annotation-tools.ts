/**
 * Low-risk MCP `annotations.create` / `annotations.update`. Notes are
 * Product annotations (`createAnnotation` / `updateAnnotation`), not
 * bookmark `note`/`tldr` fields. Host OAuth scope is `annotations:write`.
 */
import { types as nodeTypes } from 'node:util';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  ANNOTATION_MAX_VALUE_BYTES,
  AnnotationCreateError,
  AnnotationUpdateError,
  createAnnotation,
  createAnnotationCommandScope,
  updateAnnotation,
  updateAnnotationCommandScope,
  type AnnotationMutationPorts,
  type AnnotationMutationUnitOfWork,
  type CreateAnnotationInput,
  type CreateAnnotationResult,
  type ProductAnnotationMergePatch,
  type UpdateAnnotationInput,
  type UpdateAnnotationResult,
} from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpWriteErrorHint,
} from './low-risk-node-create.js';
import {
  deriveWriteCommandId,
  deriveWriteFingerprint,
  PHASE4B_MCP_STALE_REVISION_MESSAGE,
  readDryRun,
  readRevisionFence,
} from './low-risk-node-update.js';

const ANNOTATIONS_WRITE_SCOPE = 'annotations:write' as const;

export const PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME = 'annotations.create' as const;
export const PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME = 'annotations.update' as const;

export const PHASE4B_MCP_ANNOTATION_TYPES = Object.freeze(['note', 'tldr', 'summary'] as const);
export const PHASE4B_MCP_ANNOTATION_FORMATS = Object.freeze(['plain', 'markdown'] as const);
export const PHASE4B_MCP_ANNOTATION_VISIBILITIES = Object.freeze(['private', 'protected'] as const);

const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const VALUE_ENCODER = new TextEncoder();
const MISSING_PROFILE_MESSAGE =
  'A public profile handle is required before creating an annotation.' as const;

const CREATE_INPUT_KEYS = Object.freeze([
  'collectionId',
  'nodeId',
  'value',
  'type',
  'format',
  'visibility',
  'dryRun',
] as const);

const UPDATE_INPUT_KEYS = Object.freeze([
  'collectionId',
  'annotationId',
  'baseRevision',
  'ifMatch',
  'patch',
  'dryRun',
] as const);

const UPDATE_PATCH_KEYS = Object.freeze(['value', 'format', 'visibility'] as const);

export const PHASE4B_MCP_ANNOTATIONS_UPDATE_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: Object.freeze({
    value: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: ANNOTATION_MAX_VALUE_BYTES,
    }),
    format: Object.freeze({
      type: 'string',
      enum: PHASE4B_MCP_ANNOTATION_FORMATS,
    }),
    visibility: Object.freeze({
      type: 'string',
      enum: PHASE4B_MCP_ANNOTATION_VISIBILITIES,
    }),
  }),
} as const);

export const PHASE4B_MCP_ANNOTATIONS_CREATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    resultType: Object.freeze({ type: 'string', enum: Object.freeze(['complete', 'preview']) }),
    annotationId: Object.freeze({ type: 'string', minLength: 1 }),
    collectionId: Object.freeze({ type: 'string', minLength: 1 }),
    nodeId: Object.freeze({ type: 'string', minLength: 1 }),
    type: Object.freeze({ type: 'string', enum: PHASE4B_MCP_ANNOTATION_TYPES }),
    revision: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze(['resultType', 'collectionId', 'nodeId', 'type']),
  oneOf: Object.freeze([
    Object.freeze({
      properties: Object.freeze({
        resultType: Object.freeze({ const: 'complete' }),
      }),
      required: Object.freeze(['annotationId', 'revision']),
    }),
    Object.freeze({
      properties: Object.freeze({
        resultType: Object.freeze({ const: 'preview' }),
      }),
      not: Object.freeze({
        required: Object.freeze(['annotationId', 'revision']),
      }),
    }),
  ]),
} as const);

export const PHASE4B_MCP_ANNOTATIONS_UPDATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    resultType: Object.freeze({ type: 'string', enum: Object.freeze(['complete', 'preview']) }),
    annotationId: Object.freeze({ type: 'string', minLength: 1 }),
    collectionId: Object.freeze({ type: 'string', minLength: 1 }),
    revision: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze(['resultType', 'annotationId', 'collectionId']),
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

export type Phase4bMcpAnnotationType = (typeof PHASE4B_MCP_ANNOTATION_TYPES)[number];
export type Phase4bMcpAnnotationFormat = (typeof PHASE4B_MCP_ANNOTATION_FORMATS)[number];
export type Phase4bMcpAnnotationVisibility = (typeof PHASE4B_MCP_ANNOTATION_VISIBILITIES)[number];

export interface Phase4bMcpAnnotationCreator {
  readonly id: string;
  readonly name: string;
}

export type Phase4bMcpResolveAnnotationCreator = (
  accountId: string,
) => Promise<Phase4bMcpAnnotationCreator | null>;

export interface Phase4bMcpLowRiskAnnotationCreateCompleteOutput {
  readonly resultType: 'complete';
  readonly annotationId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly type: Phase4bMcpAnnotationType;
  readonly revision: string;
}

export interface Phase4bMcpLowRiskAnnotationCreatePreviewOutput {
  readonly resultType: 'preview';
  readonly collectionId: string;
  readonly nodeId: string;
  readonly type: Phase4bMcpAnnotationType;
}

export type Phase4bMcpLowRiskAnnotationCreateOutput =
  | Phase4bMcpLowRiskAnnotationCreateCompleteOutput
  | Phase4bMcpLowRiskAnnotationCreatePreviewOutput;

export interface Phase4bMcpLowRiskAnnotationUpdateCompleteOutput {
  readonly resultType: 'complete';
  readonly annotationId: string;
  readonly collectionId: string;
  readonly revision: string;
}

export interface Phase4bMcpLowRiskAnnotationUpdatePreviewOutput {
  readonly resultType: 'preview';
  readonly annotationId: string;
  readonly collectionId: string;
}

export type Phase4bMcpLowRiskAnnotationUpdateOutput =
  | Phase4bMcpLowRiskAnnotationUpdateCompleteOutput
  | Phase4bMcpLowRiskAnnotationUpdatePreviewOutput;

export interface Phase4bMcpLowRiskAnnotationCreateService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpLowRiskAnnotationCreateOutput>;
}

export interface Phase4bMcpLowRiskAnnotationUpdateService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpLowRiskAnnotationUpdateOutput>;
}

export interface Phase4bMcpLowRiskAnnotationCreateServiceOptions {
  readonly unitOfWork: AnnotationMutationUnitOfWork;
  readonly resolveAnnotationCreator: Phase4bMcpResolveAnnotationCreator;
  readonly inspect: Pick<Phase4bMcpLowRiskAnnotationInspect, 'create'>;
}

export interface Phase4bMcpLowRiskAnnotationUpdateServiceOptions {
  readonly unitOfWork: AnnotationMutationUnitOfWork;
  readonly inspect: Pick<Phase4bMcpLowRiskAnnotationInspect, 'update'>;
}

export interface Phase4bMcpLowRiskAnnotationInspect {
  readonly create: (input: CreateAnnotationInput) => Promise<void>;
  readonly update: (input: UpdateAnnotationInput) => Promise<void>;
}

interface ParsedAnnotationCreateInput {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly value: string;
  readonly type: Phase4bMcpAnnotationType;
  readonly format: Phase4bMcpAnnotationFormat;
  readonly visibility: Phase4bMcpAnnotationVisibility;
  readonly dryRun: boolean;
}

interface ParsedAnnotationUpdateInput {
  readonly collectionId: string;
  readonly annotationId: string;
  readonly baseRevision: string;
  readonly patch: ProductAnnotationMergePatch;
  readonly dryRun: boolean;
}

const ANNOTATION_PREVIEW_COMPLETE = Object.freeze({ kind: 'annotation-preview-complete' });

/**
 * Runs the real Product annotation admission path with non-persisting receipt
 * and canonical ports. The surrounding PostgreSQL UoW may lock/read rows, but
 * no receipt or canonical mutation can be written during preview.
 */
export function createPhase4bMcpLowRiskAnnotationInspect(
  unitOfWork: AnnotationMutationUnitOfWork,
): Phase4bMcpLowRiskAnnotationInspect {
  return Object.freeze({
    create: (input: CreateAnnotationInput) => executeAnnotationPreview(
      unitOfWork,
      (ports) => createAnnotation(ports, input),
    ),
    update: (input: UpdateAnnotationInput) => executeAnnotationPreview(
      unitOfWork,
      (ports) => updateAnnotation(ports, input),
    ),
  });
}

export function createPhase4bMcpLowRiskAnnotationCreateService(
  options: Phase4bMcpLowRiskAnnotationCreateServiceOptions,
): Phase4bMcpLowRiskAnnotationCreateService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP annotations.create options must be an own-data object.');
  }
  const unitOfWork = options.unitOfWork;
  const resolveAnnotationCreator = readRequiredCreatorResolver(options);
  const inspect = readRequiredInspect(options, 'create');
  return Object.freeze({
    execute: async (
      input: Readonly<Record<string, unknown>>,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ) => {
      const binding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(context.binding),
      );
      assertWriteScope(context.scope, PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME);
      const accountSubjectId = requireMcpAccountSubjectId({
        accountSubjectId: context.accountSubjectId,
      });
      const parsed = parseAnnotationCreateInput(input);
      const creator = await resolveTrustedCreator(resolveAnnotationCreator, binding.principalId);
      const facts = Object.freeze({
        collectionId: parsed.collectionId,
        nodeId: parsed.nodeId,
        type: parsed.type,
        format: parsed.format,
        value: parsed.value,
        visibility: parsed.visibility,
      });
      const commandId = deriveWriteCommandId(
        PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
        facts,
        binding,
      );
      const fingerprint = deriveWriteFingerprint(
        PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
        facts,
        binding,
      );
      const mutationInput: CreateAnnotationInput = Object.freeze({
        actor: Object.freeze({
          principalId: binding.principalId,
          principalType: 'account' as const,
          subjectId: accountSubjectId,
          creator,
        }),
        command: Object.freeze({
          commandId,
          fingerprint,
          commandScope: createAnnotationCommandScope(parsed.collectionId),
        }),
        collectionId: parsed.collectionId,
        annotation: Object.freeze({
          subject: Object.freeze({ type: 'node' as const, id: parsed.nodeId }),
          type: parsed.type,
          format: parsed.format,
          value: parsed.value,
          visibility: parsed.visibility,
        }),
      });
      try {
        if (parsed.dryRun) {
          await inspect.create(mutationInput);
          return Object.freeze({
            resultType: 'preview',
            collectionId: parsed.collectionId,
            nodeId: parsed.nodeId,
            type: parsed.type,
          });
        }
        const outcome = await unitOfWork.execute((ports) =>
          createAnnotation(ports, mutationInput));
        return projectCreateOutput(outcome);
      } catch (error) {
        mapAnnotationMutationError(error, PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME);
      }
    },
  });
}

export function createPhase4bMcpLowRiskAnnotationUpdateService(
  options: Phase4bMcpLowRiskAnnotationUpdateServiceOptions,
): Phase4bMcpLowRiskAnnotationUpdateService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP annotations.update options must be an own-data object.');
  }
  const unitOfWork = options.unitOfWork;
  const inspect = readRequiredInspect(options, 'update');
  return Object.freeze({
    execute: async (
      input: Readonly<Record<string, unknown>>,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ) => {
      const binding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(context.binding),
      );
      assertWriteScope(context.scope, PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME);
      const accountSubjectId = requireMcpAccountSubjectId({
        accountSubjectId: context.accountSubjectId,
      });
      const parsed = parseAnnotationUpdateInput(input);
      const facts = Object.freeze({
        collectionId: parsed.collectionId,
        annotationId: parsed.annotationId,
        baseRevision: parsed.baseRevision,
        patch: parsed.patch,
      });
      const commandId = deriveWriteCommandId(
        PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
        facts,
        binding,
      );
      const fingerprint = deriveWriteFingerprint(
        PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
        facts,
        binding,
      );
      const expectedRevision = unwrapEntityTag(parsed.baseRevision);
      const mutationInput: UpdateAnnotationInput = Object.freeze({
        actor: Object.freeze({
          principalId: binding.principalId,
          principalType: 'account' as const,
          subjectId: accountSubjectId,
        }),
        command: Object.freeze({
          commandId,
          fingerprint,
          commandScope: updateAnnotationCommandScope(
            parsed.collectionId,
            parsed.annotationId,
          ),
        }),
        collectionId: parsed.collectionId,
        annotationId: parsed.annotationId,
        precondition: Object.freeze({
          kind: 'single-strong-if-match' as const,
          entityTag: `"${expectedRevision}"`,
          expectedRevision,
        }),
        patch: parsed.patch,
      });
      try {
        if (parsed.dryRun) {
          await inspect.update(mutationInput);
          return Object.freeze({
            resultType: 'preview',
            annotationId: parsed.annotationId,
            collectionId: parsed.collectionId,
          });
        }
        const outcome = await unitOfWork.execute((ports) =>
          updateAnnotation(ports, mutationInput));
        return projectUpdateOutput(outcome);
      } catch (error) {
        mapAnnotationMutationError(error, PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME);
      }
    },
  });
}

function parseAnnotationCreateInput(
  input: Readonly<Record<string, unknown>>,
): ParsedAnnotationCreateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'annotations.create input must be an object.',
    );
  }
  assertAllowedKeys(
    input,
    CREATE_INPUT_KEYS,
    'annotations.create input contains unknown fields.',
  );
  const collectionId = readRequiredOpaqueId(
    input,
    'collectionId',
    PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
  );
  const nodeId = readRequiredOpaqueId(
    input,
    'nodeId',
    PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
  );
  const value = readRequiredValueString(
    input,
    'value',
    PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
  );
  const type = Object.hasOwn(input, 'type')
    ? readAnnotationType(input.type, 'type')
    : 'note';
  const format = Object.hasOwn(input, 'format')
    ? readAnnotationFormat(input.format, 'format')
    : 'plain';
  const visibility = Object.hasOwn(input, 'visibility')
    ? readAnnotationVisibility(input.visibility, 'visibility')
    : 'private';
  const dryRun = readDryRun(input, PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME);
  return Object.freeze({
    collectionId,
    nodeId,
    value,
    type,
    format,
    visibility,
    dryRun,
  });
}

function parseAnnotationUpdateInput(
  input: Readonly<Record<string, unknown>>,
): ParsedAnnotationUpdateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'annotations.update input must be an object.',
    );
  }
  assertAllowedKeys(
    input,
    UPDATE_INPUT_KEYS,
    'annotations.update input contains unknown fields.',
  );
  const collectionId = readRequiredOpaqueId(
    input,
    'collectionId',
    PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
  );
  const annotationId = readRequiredOpaqueId(
    input,
    'annotationId',
    PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
  );
  const baseRevision = readRevisionFence(input, PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME);
  const patch = parseAnnotationPatch(readRequiredObject(
    input,
    'patch',
    PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
  ));
  const dryRun = readDryRun(input, PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME);
  return Object.freeze({
    collectionId,
    annotationId,
    baseRevision,
    patch,
    dryRun,
  });
}

function parseAnnotationPatch(raw: Readonly<Record<string, unknown>>): ProductAnnotationMergePatch {
  assertAllowedKeys(raw, UPDATE_PATCH_KEYS, 'annotations.update patch contains unknown fields.');
  const hasValue = Object.hasOwn(raw, 'value');
  const hasFormat = Object.hasOwn(raw, 'format');
  const hasVisibility = Object.hasOwn(raw, 'visibility');
  if (!hasValue && !hasFormat && !hasVisibility) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'annotations.update patch must include at least one of value, format, visibility.',
      annotationHint(PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME, 'patch'),
    );
  }
  const patch: {
    value?: string;
    format?: Phase4bMcpAnnotationFormat;
    visibility?: Phase4bMcpAnnotationVisibility;
  } = {};
  if (hasValue) {
    patch.value = readRequiredValueString(
      raw,
      'value',
      PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME,
      'patch.value',
    );
  }
  if (hasFormat) {
    patch.format = readAnnotationFormat(raw.format, 'patch.format');
  }
  if (hasVisibility) {
    patch.visibility = readAnnotationVisibility(raw.visibility, 'patch.visibility');
  }
  return Object.freeze(patch);
}

function projectCreateOutput(
  outcome: CreateAnnotationResult,
): Phase4bMcpLowRiskAnnotationCreateCompleteOutput {
  if (outcome.kind === 'created') {
    return projectCreatedAnnotation(outcome.annotation);
  }
  if (outcome.kind === 'replay') {
    return decodeReplayCreate(outcome.body);
  }
  throw new Phase4bMcpLowRiskNodeCreateError(
    'commit_unknown',
    'annotations.create did not produce a durable committed or replayable result.',
  );
}

function projectUpdateOutput(
  outcome: UpdateAnnotationResult,
): Phase4bMcpLowRiskAnnotationUpdateCompleteOutput {
  if (outcome.kind === 'updated') {
    return Object.freeze({
      resultType: 'complete',
      annotationId: outcome.annotation.id,
      collectionId: outcome.annotation.collectionId,
      revision: outcome.annotation.revision,
    });
  }
  if (outcome.kind === 'replay') {
    return decodeReplayUpdate(outcome.body);
  }
  throw new Phase4bMcpLowRiskNodeCreateError(
    'commit_unknown',
    'annotations.update did not produce a durable committed or replayable result.',
  );
}

function projectCreatedAnnotation(annotation: {
  readonly id: string;
  readonly collectionId: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly type: string;
  readonly revision: string;
}): Phase4bMcpLowRiskAnnotationCreateCompleteOutput {
  const subject = annotation.subject;
  if (subject.type !== 'node') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'annotations.create durable result subject must be a node.',
    );
  }
  return Object.freeze({
    resultType: 'complete',
    annotationId: annotation.id,
    collectionId: annotation.collectionId,
    nodeId: subject.id,
    type: asMcpAnnotationType(annotation.type),
    revision: annotation.revision,
  });
}

function decodeReplayCreate(body: Uint8Array): Phase4bMcpLowRiskAnnotationCreateCompleteOutput {
  const record = decodeReplayRecord(body, PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME);
  const annotationId = record.id;
  const collectionId = record.collectionId;
  const revision = record.revision;
  const type = record.type;
  const subject = record.subject;
  if (typeof annotationId !== 'string' || typeof collectionId !== 'string'
    || typeof revision !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'annotations.create durable receipt is missing annotation identity.',
    );
  }
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'annotations.create durable receipt subject is required.',
    );
  }
  const subjectRecord = subject as Readonly<Record<string, unknown>>;
  if (subjectRecord.type !== 'node' || typeof subjectRecord.id !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'annotations.create durable receipt subject must be a node.',
    );
  }
  return Object.freeze({
    resultType: 'complete',
    annotationId,
    collectionId,
    nodeId: subjectRecord.id,
    type: asMcpAnnotationType(type),
    revision,
  });
}

function decodeReplayUpdate(body: Uint8Array): Phase4bMcpLowRiskAnnotationUpdateCompleteOutput {
  const record = decodeReplayRecord(body, PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME);
  const annotationId = record.id;
  const collectionId = record.collectionId;
  const revision = record.revision;
  if (typeof annotationId !== 'string' || typeof collectionId !== 'string'
    || typeof revision !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      'annotations.update durable receipt is missing annotation identity.',
    );
  }
  return Object.freeze({
    resultType: 'complete',
    annotationId,
    collectionId,
    revision,
  });
}

function decodeReplayRecord(
  body: Uint8Array,
  operation: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      `${operation} durable receipt is not valid JSON.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'output_invalid',
      `${operation} durable receipt must be a JSON object.`,
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function asMcpAnnotationType(value: unknown): Phase4bMcpAnnotationType {
  if (value === 'note' || value === 'tldr' || value === 'summary') return value;
  throw new Phase4bMcpLowRiskNodeCreateError(
    'output_invalid',
    'annotations.create durable result type is not a one-shot annotation type.',
  );
}

async function resolveTrustedCreator(
  resolveAnnotationCreator: Phase4bMcpResolveAnnotationCreator,
  accountId: string,
): Promise<Phase4bMcpAnnotationCreator> {
  const creator = await resolveAnnotationCreator(accountId);
  if (
    creator === null
    || typeof creator !== 'object'
    || typeof creator.id !== 'string'
    || creator.id.length === 0
    || typeof creator.name !== 'string'
    || creator.name.length === 0
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError('policy_denied', MISSING_PROFILE_MESSAGE);
  }
  return Object.freeze({ id: creator.id, name: creator.name });
}

function mapAnnotationMutationError(error: unknown, operation: string): never {
  if (error instanceof Phase4bMcpLowRiskNodeCreateError) throw error;
  if (error instanceof AnnotationCreateError || error instanceof AnnotationUpdateError) {
    throw mappedFromAnnotationCode(error.code, operation);
  }
  throw error;
}

function mappedFromAnnotationCode(
  code: string,
  operation: string,
): Phase4bMcpLowRiskNodeCreateError {
  if (
    code === 'annotation_not_found'
    || code === 'invalid_annotation_subject'
    || code === 'insufficient_annotation_permission'
  ) {
    return new Phase4bMcpLowRiskNodeCreateError(
      'policy_denied',
      `${operation} was rejected.`,
    );
  }
  if (code === 'annotation_precondition_failed') {
    return new Phase4bMcpLowRiskNodeCreateError(
      'stale_revision',
      PHASE4B_MCP_STALE_REVISION_MESSAGE,
    );
  }
  if (
    code === 'annotation_value_too_large'
    || code === 'annotation_json_too_deep'
    || code === 'annotation_json_too_many_members'
    || code === 'annotation_candidate_too_large'
    || code === 'annotation_subject_limit_reached'
  ) {
    return new Phase4bMcpLowRiskNodeCreateError(
      'budget_exceeded',
      `${operation} exceeded the resource budget.`,
    );
  }
  return new Phase4bMcpLowRiskNodeCreateError(
    'invalid_catalog_input',
    `${operation} input was rejected.`,
  );
}

function unwrapEntityTag(fence: string): string {
  if (fence.length >= 2 && fence.startsWith('"') && fence.endsWith('"')) {
    return fence.slice(1, -1);
  }
  return fence;
}

function readAnnotationType(value: unknown, field: string): Phase4bMcpAnnotationType {
  if (value === 'highlight' || value === 'reading_state' || value === 'rating' || value === 'custom') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'annotations.create type must be note, tldr, or summary.',
      annotationHint(PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME, field),
    );
  }
  if (value !== 'note' && value !== 'tldr' && value !== 'summary') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'annotations.create type must be note, tldr, or summary.',
      annotationHint(PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME, field),
    );
  }
  return value;
}

function readAnnotationFormat(value: unknown, field: string): Phase4bMcpAnnotationFormat {
  const operation = field.startsWith('patch.')
    ? PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME
    : PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME;
  if (value === 'html' || value === 'json') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} format must be plain or markdown.`,
      annotationHint(operation, field),
    );
  }
  if (value !== 'plain' && value !== 'markdown') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} format must be plain or markdown.`,
      annotationHint(operation, field),
    );
  }
  return value;
}

function readAnnotationVisibility(
  value: unknown,
  field: string,
): Phase4bMcpAnnotationVisibility {
  const operation = field.startsWith('patch.')
    ? PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME
    : PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME;
  if (value === 'public' || value === 'unlisted') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} visibility must be private or protected.`,
      annotationHint(operation, field),
    );
  }
  if (value !== 'private' && value !== 'protected') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} visibility must be private or protected.`,
      annotationHint(operation, field),
    );
  }
  return value;
}

function readRequiredValueString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  operation: string,
  field = name,
): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} ${name} must be a non-empty string.`,
      annotationHint(operation, field),
    );
  }
  if (VALUE_ENCODER.encode(value).byteLength > ANNOTATION_MAX_VALUE_BYTES) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'budget_exceeded',
      `${operation} value exceeds the annotation byte budget.`,
      annotationHint(operation, field),
    );
  }
  return value;
}

function readRequiredOpaqueId(
  input: Readonly<Record<string, unknown>>,
  name: string,
  operation: string,
): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} ${name} must be a non-empty string.`,
      annotationHint(operation, name),
    );
  }
  if (!ID_PATTERN.test(value)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} ${name} must be a canonical opaque id.`,
      annotationHint(operation, name),
    );
  }
  return value;
}

function readRequiredObject(
  input: Readonly<Record<string, unknown>>,
  name: string,
  operation: string,
): Readonly<Record<string, unknown>> {
  const value = input[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `${operation} ${name} must be an object.`,
      annotationHint(operation, name),
    );
  }
  return value as Readonly<Record<string, unknown>>;
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

function assertWriteScope(scope: readonly string[], operation: string): void {
  if (
    !Array.isArray(scope)
    || scope.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || !scope.includes(ANNOTATIONS_WRITE_SCOPE)
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'scope_invalid',
      `${operation} requires the current annotations:write scope.`,
    );
  }
}

function annotationHint(operation: string, field: string): Phase4bMcpWriteErrorHint {
  return Object.freeze({
    field,
    nextTool: operation === PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME
      ? PHASE4B_MCP_ANNOTATIONS_UPDATE_TOOL_NAME
      : PHASE4B_MCP_ANNOTATIONS_CREATE_TOOL_NAME,
  });
}

function readRequiredCreatorResolver(
  options: Phase4bMcpLowRiskAnnotationCreateServiceOptions,
): Phase4bMcpResolveAnnotationCreator {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'resolveAnnotationCreator');
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('annotations.create requires resolveAnnotationCreator.');
  }
  const candidate = descriptor.value;
  if (typeof candidate !== 'function' || nodeTypes.isProxy(candidate)) {
    throw new TypeError('annotations.create resolveAnnotationCreator must be an own-data function.');
  }
  return candidate as Phase4bMcpResolveAnnotationCreator;
}

function readRequiredInspect<Method extends 'create' | 'update'>(
  options: Phase4bMcpLowRiskAnnotationCreateServiceOptions
    | Phase4bMcpLowRiskAnnotationUpdateServiceOptions,
  method: Method,
): Pick<Phase4bMcpLowRiskAnnotationInspect, Method> {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'inspect');
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'object'
    || descriptor.value === null
    || nodeTypes.isProxy(descriptor.value)
  ) {
    throw new TypeError(`annotations.${method} requires an own-data inspect port.`);
  }
  const inspect = descriptor.value as Pick<Phase4bMcpLowRiskAnnotationInspect, Method>;
  const inspectMethod = Object.getOwnPropertyDescriptor(inspect, method)?.value;
  if (typeof inspectMethod !== 'function' || nodeTypes.isProxy(inspectMethod)) {
    throw new TypeError(`annotations.${method} inspect.${method} must be an own-data function.`);
  }
  return inspect;
}

async function executeAnnotationPreview(
  unitOfWork: AnnotationMutationUnitOfWork,
  work: (ports: AnnotationMutationPorts) => Promise<unknown>,
): Promise<void> {
  try {
    await unitOfWork.execute(async (ports) => {
      const previewPorts: AnnotationMutationPorts = Object.freeze({
        ...ports,
        receipts: Object.freeze({
          ...ports.receipts,
          claim: async () => Object.freeze({ kind: 'claimed' as const }),
          complete: async () => {
            throw new TypeError('Annotation preview attempted to persist a receipt.');
          },
        }),
        canonical: Object.freeze({
          execute: async () => {
            throw ANNOTATION_PREVIEW_COMPLETE;
          },
        }),
      });
      await work(previewPorts);
      throw new TypeError('Annotation preview completed without reaching canonical admission.');
    });
  } catch (error) {
    // Let the sentinel escape the UoW callback so PostgreSQL rolls the whole
    // preview transaction back before treating successful admission as done.
    if (error === ANNOTATION_PREVIEW_COMPLETE) return;
    throw error;
  }
}
