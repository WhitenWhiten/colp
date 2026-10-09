import { isDeepStrictEqual } from 'node:util';

import { createValidatorRegistry, type DefinitionName } from '../schema/index.js';
import { formatCanonicalDateTime } from '../shared/date-time.js';
import { immutableJsonSnapshot } from '../shared/immutable-json.js';
import type {
  Annotation,
  AnnotationCreate,
  AnnotationMergePatch,
  Provenance,
} from '../types/index.js';
import { deepFreeze } from './deep-freeze.js';

const contextBrand: unique symbol = Symbol('annotation-mutation-context');
const trustedContexts = new WeakSet<object>();
const validators = createValidatorRegistry();
const MAX_PROVENANCE_SOURCE_IDS = 128;
const MAX_PROVENANCE_TEXT_LENGTH = 512;

export type AnnotationProvenanceErrorCode =
  | 'invalid_annotation_document'
  | 'invalid_generation_context'
  | 'missing_provenance_source'
  | 'provenance_downgrade'
  | 'untrusted_ai_provenance'
  | 'untrusted_generation_context';

export class AnnotationProvenanceError extends Error {
  readonly code: AnnotationProvenanceErrorCode;
  readonly path: string;

  constructor(code: AnnotationProvenanceErrorCode, message: string, path = '/provenance') {
    super(message);
    this.name = 'AnnotationProvenanceError';
    this.code = code;
    this.path = path;
  }
}

export interface AiAnnotationGenerationInput {
  readonly generatedAt: Date | string;
  readonly provider?: string;
  /** Model disclosure is optional under the protocol. */
  readonly model?: string;
  readonly sourceNodeIds?: readonly string[];
}

export interface AiAnnotationGenerationContext {
  readonly origin: 'ai';
  readonly provenance: Readonly<Provenance>;
  readonly [contextBrand]: true;
}

export interface NonAiAnnotationMutationContext {
  readonly origin: 'human' | 'imported' | 'derived';
  readonly [contextBrand]: true;
}

export type AnnotationMutationContext =
  | AiAnnotationGenerationContext
  | NonAiAnnotationMutationContext;

export interface ProvenanceSourceResolver {
  /** Resolve against authoritative state in the annotation's Collection. */
  hasNode(collectionId: string, nodeId: string): boolean;
}

export interface AnnotationCreateProvenanceOptions {
  readonly collectionId: string;
  readonly sourceResolver?: ProvenanceSourceResolver;
}

export interface AnnotationResourceProvenanceOptions {
  readonly previous?: Annotation;
  readonly sourceResolver?: ProvenanceSourceResolver;
}

/**
 * Creates the opaque context that an application passes from its trusted AI execution
 * boundary. HTTP/MCP request bodies must never be deserialized into this context.
 */
export function createAiAnnotationGenerationContext(
  input: AiAnnotationGenerationInput,
): AiAnnotationGenerationContext {
  let generatedAt: string;
  try {
    generatedAt = formatCanonicalDateTime(input.generatedAt);
  } catch (cause) {
    throw new AnnotationProvenanceError(
      'invalid_generation_context',
      cause instanceof Error ? cause.message : 'Invalid AI generation timestamp.',
      '/generatedAt',
    );
  }
  if (input.provider !== undefined && (typeof input.provider !== 'string'
    || input.provider.length > MAX_PROVENANCE_TEXT_LENGTH)
    || input.model !== undefined && (typeof input.model !== 'string'
      || input.model.length > MAX_PROVENANCE_TEXT_LENGTH)
    || input.sourceNodeIds !== undefined && (
      !Array.isArray(input.sourceNodeIds)
      || input.sourceNodeIds.length > MAX_PROVENANCE_SOURCE_IDS
      || input.sourceNodeIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)
    )) {
    throw new AnnotationProvenanceError(
      'invalid_generation_context',
      'AI generation provenance exceeds its input budget.',
      '/provenance',
    );
  }
  const provenance: Provenance = {
    kind: 'ai',
    generatedAt,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.sourceNodeIds === undefined ? {} : { sourceNodeIds: [...input.sourceNodeIds] }),
  };
  assertSchema('provenance', provenance, 'invalid_generation_context');
  const context = deepFreeze({ origin: 'ai' as const, provenance, [contextBrand]: true as const });
  trustedContexts.add(context);
  return context;
}

/** Declares a trusted non-AI mutation origin, distinct from caller provenance fields. */
export function createNonAiAnnotationMutationContext(
  origin: NonAiAnnotationMutationContext['origin'],
): NonAiAnnotationMutationContext {
  if (origin !== 'human' && origin !== 'imported' && origin !== 'derived') {
    throw new AnnotationProvenanceError(
      'invalid_generation_context',
      'Non-AI annotation origin must be human, imported, or derived.',
      '/origin',
    );
  }
  const context = Object.freeze({ origin, [contextBrand]: true as const });
  trustedContexts.add(context);
  return context;
}

/** Convenience context for a human-authored create or edit. */
export function createHumanAnnotationEditContext(): NonAiAnnotationMutationContext {
  return createNonAiAnnotationMutationContext('human');
}

/** Validates and prepares a create DTO without mutating caller-owned data. */
export function prepareAnnotationCreate(
  value: AnnotationCreate,
  context: AnnotationMutationContext,
  options: AnnotationCreateProvenanceOptions,
): Readonly<AnnotationCreate> {
  assertContext(context);
  assertSchema('annotationCreate', value);
  const candidate = clone(value);
  if (context.origin === 'ai') candidate.provenance = clone(context.provenance);
  else assertNoCallerAiProvenance(candidate.provenance, undefined);
  assertSchema('annotationCreate', candidate);
  assertSources(candidate.provenance, options.collectionId, options.sourceResolver);
  return deepFreeze(candidate);
}

/**
 * Validates a complete Annotation at storage/service boundaries. AI context is
 * authoritative; human edits retain AI origin and acquire editedByHuman=true.
 */
export function prepareAnnotationResource(
  value: Annotation,
  context: AnnotationMutationContext,
  options: AnnotationResourceProvenanceOptions = {},
): Readonly<Annotation> {
  assertContext(context);
  const candidate = clone(value);
  applyTrustedProvenance(candidate, context, options.previous);
  assertSchema('annotation', candidate);
  assertSources(candidate.provenance, candidate.collectionId, options.sourceResolver);
  return deepFreeze(candidate);
}

/** Applies an Annotation JSON Merge Patch and validates the complete result. */
export function prepareAnnotationMergePatch(
  current: Annotation,
  patch: AnnotationMergePatch,
  context: AnnotationMutationContext,
  sourceResolver?: ProvenanceSourceResolver,
): Readonly<Annotation> {
  assertContext(context);
  assertSchema('annotation', current);
  assertSchema('annotationMergePatch', patch);

  const candidate = clone(current) as Annotation & Record<string, unknown>;
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === null) delete candidate[key];
    else candidate[key] = clone(patchValue);
  }
  applyTrustedProvenance(candidate, context, current);
  assertSchema('annotation', candidate);
  assertSources(candidate.provenance, candidate.collectionId, sourceResolver);
  return deepFreeze(candidate);
}

function applyTrustedProvenance(
  candidate: Annotation,
  context: AnnotationMutationContext,
  previous: Annotation | undefined,
): void {
  if (context.origin === 'ai') {
    candidate.provenance = clone(context.provenance);
    return;
  }
  if (previous?.provenance?.kind !== 'ai') {
    assertNoCallerAiProvenance(candidate.provenance, previous);
    return;
  }
  const provenance = clone(previous.provenance);
  if (
    context.origin === 'human'
    && (
    candidate.format !== previous.format
    || !isDeepStrictEqual(candidate.value, previous.value)
    )
  ) {
    provenance.editedByHuman = true;
  }
  candidate.provenance = provenance;
}

function assertNoCallerAiProvenance(
  provenance: Provenance | undefined,
  previous: Annotation | undefined,
): void {
  if (provenance?.kind !== 'ai' || previous?.provenance?.kind === 'ai') return;
  throw new AnnotationProvenanceError(
    'untrusted_ai_provenance',
    'Caller-controlled provenance cannot establish AI generation origin.',
    '/provenance/kind',
  );
}

function assertContext(context: AnnotationMutationContext): void {
  if (typeof context !== 'object' || context === null || !trustedContexts.has(context)) {
    throw new AnnotationProvenanceError(
      'untrusted_generation_context',
      'Annotation mutation context must be created by the trusted server API.',
      '',
    );
  }
  trustedContexts.delete(context);
}

function assertSources(
  provenance: Provenance | undefined,
  collectionId: string,
  resolver: ProvenanceSourceResolver | undefined,
): void {
  for (const [index, nodeId] of (provenance?.sourceNodeIds ?? []).entries()) {
    if (resolver === undefined || !resolver.hasNode(collectionId, nodeId)) {
      throw new AnnotationProvenanceError(
        'missing_provenance_source',
        `Provenance source node ${JSON.stringify(nodeId)} does not resolve in Collection ${JSON.stringify(collectionId)}.`,
        `/provenance/sourceNodeIds/${index}`,
      );
    }
  }
}

function assertSchema(
  definition: DefinitionName,
  value: unknown,
  code: AnnotationProvenanceErrorCode = 'invalid_annotation_document',
): void {
  const result = validators.validate(definition, value);
  if (result.valid) return;
  const first = result.errors[0];
  throw new AnnotationProvenanceError(
    code,
    `Invalid ${definition}: ${first?.message ?? 'schema validation failed'}.`,
    first?.instancePath ?? '',
  );
}

function clone<Value>(value: Value): Value {
  const snapshot = immutableJsonSnapshot(value, 'Annotation document', {
    maxDepth: 64,
    maxMembers: 100_000,
    maxBytes: 8 * 1024 * 1024,
  });
  return mutableClone(snapshot) as Value;
}

function mutableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => mutableClone(entry));
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = mutableClone(child);
    return copy;
  }
  return value;
}


