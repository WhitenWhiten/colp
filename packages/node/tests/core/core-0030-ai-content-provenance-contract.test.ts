import { describe, expect, expectTypeOf, it } from 'vitest';

import * as packageBoundary from '../../src/server/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as semanticBoundary from '../../src/semantic/index.js';
import * as serverBoundary from '../../src/server/index.js';
import type {
  Annotation,
  AnnotationCreate,
  AnnotationMergePatch,
  Provenance,
} from '../../src/types/index.js';

const evidence = '[evidence:core.ai-content-provenance]';
const validators = createValidatorRegistry();
const generatedAt = '2026-07-17T06:30:00Z';
const collectionId = 'collection-ai-provenance';

type ContentOrigin = Provenance['kind'];
type ProvenanceNode = { readonly collectionId: string };
type ProvenanceNodeResolver = (nodeId: string) => ProvenanceNode | undefined;

type AnnotationProvenanceContext = {
  readonly operation: 'create' | 'complete';
  readonly contentOrigin: ContentOrigin;
  readonly collectionId: string;
  readonly resolveNode?: ProvenanceNodeResolver;
} | {
  readonly operation: 'merge-patch';
  readonly contentOrigin: ContentOrigin;
  readonly collectionId: string;
  readonly current: Annotation;
  readonly resolveNode?: ProvenanceNodeResolver;
};

type ProvenanceIssue = {
  readonly code: string;
  readonly message: string;
  readonly path: string;
};

type ProvenanceResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ProvenanceIssue[] };

type ValidateAnnotationProvenance = (
  value: AnnotationCreate | Annotation | AnnotationMergePatch,
  context: AnnotationProvenanceContext,
) => ProvenanceResult;

type ProvenanceApi = {
  readonly validateAnnotationProvenance?: ValidateAnnotationProvenance;
};

const serverApi = serverBoundary as ProvenanceApi;
const packageApi = packageBoundary as ProvenanceApi;

function validator(): ValidateAnnotationProvenance {
  expect(serverApi.validateAnnotationProvenance).toBeTypeOf('function');
  return serverApi.validateAnnotationProvenance as ValidateAnnotationProvenance;
}

function aiProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    kind: 'ai',
    provider: 'user-configured',
    generatedAt,
    ...overrides,
  };
}

function annotationCreate(provenance: Provenance | null | undefined = undefined): AnnotationCreate {
  const value: AnnotationCreate = {
    subject: { type: 'node', id: 'node-source' },
    type: 'summary',
    format: 'markdown',
    value: 'Generated summary',
    visibility: 'private',
  };
  if (provenance !== undefined) {
    (value as unknown as { provenance: Provenance | null }).provenance = provenance;
  }
  return value;
}

function completeAnnotation(provenance: Provenance | null | undefined = undefined): Annotation {
  const value: Annotation = {
    id: 'annotation-ai-provenance',
    collectionId,
    ...annotationCreate(),
    createdAt: generatedAt,
    updatedAt: generatedAt,
    revision: 'revision-ai-provenance',
  };
  if (provenance !== undefined) {
    (value as unknown as { provenance: Provenance | null }).provenance = provenance;
  }
  return value;
}

function context(
  operation: 'create' | 'complete',
  contentOrigin: ContentOrigin = 'ai',
  resolveNode?: ProvenanceNodeResolver,
): AnnotationProvenanceContext {
  return { operation, contentOrigin, collectionId, ...(resolveNode === undefined ? {} : { resolveNode }) };
}

function patchContext(
  current: Annotation,
  contentOrigin: ContentOrigin = 'ai',
  resolveNode?: ProvenanceNodeResolver,
): AnnotationProvenanceContext {
  return {
    operation: 'merge-patch',
    contentOrigin,
    collectionId,
    current,
    ...(resolveNode === undefined ? {} : { resolveNode }),
  };
}

function expectOnlyIssue(result: ProvenanceResult, code: string, path: string): void {
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => ({ code: issue.code, path: issue.path }))).toEqual([
    { code, path },
  ]);
}

function structuralErrorPath(
  definition: 'annotationCreate' | 'annotation' | 'annotationMergePatch',
  value: unknown,
  path: string,
): void {
  const result = validators.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ instancePath: path }),
  ]));
}

describe(`CORE-0030 trusted AI content Provenance ${evidence}`, () => {
  it('exports one validator from server and package boundaries with the exact contract type', () => {
    expect(serverApi.validateAnnotationProvenance).toBeTypeOf('function');
    expect(packageApi.validateAnnotationProvenance).toBe(serverApi.validateAnnotationProvenance);
    expectTypeOf(serverApi.validateAnnotationProvenance).toEqualTypeOf<
      ValidateAnnotationProvenance | undefined
    >();
  });

  it('keeps Provenance optional on public Annotation create and complete wire contracts', () => {
    expect(validators.validate('annotationCreate', annotationCreate())).toEqual({ valid: true, errors: [] });
    expect(validators.validate('annotation', completeAnnotation())).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['create', 'annotationCreate', annotationCreate] as const,
    ['complete', 'annotation', completeAnnotation] as const,
  ])('rejects null Provenance structurally on an Annotation %s', (_operation, definition, build) => {
    structuralErrorPath(definition, build(null), '/provenance');
  });

  it.each([
    ['create', annotationCreate] as const,
    ['complete', completeAnnotation] as const,
  ])('rejects absent Provenance semantically for trusted AI-origin %s', (operation, build) => {
    expectOnlyIssue(
      validator()(build(), context(operation)),
      'ai_provenance_required',
      '/provenance',
    );
  });

  it.each([
    ['create', annotationCreate] as const,
    ['complete', completeAnnotation] as const,
  ])('rejects null Provenance semantically for trusted AI-origin %s', (operation, build) => {
    expectOnlyIssue(
      validator()(build(null), context(operation)),
      'ai_provenance_required',
      '/provenance',
    );
  });

  it.each([
    ['create', 'human', annotationCreate] as const,
    ['create', 'imported', annotationCreate] as const,
    ['create', 'derived', annotationCreate] as const,
    ['complete', 'human', completeAnnotation] as const,
    ['complete', 'imported', completeAnnotation] as const,
    ['complete', 'derived', completeAnnotation] as const,
  ])('rejects kind=%s on a trusted AI-origin %s', (operation, kind, build) => {
    expectOnlyIssue(
      validator()(build({ kind }), context(operation)),
      'ai_provenance_kind_required',
      '/provenance/kind',
    );
  });

  it.each([
    ['create', 'without model', undefined, annotationCreate] as const,
    ['create', 'with model', 'optional-model-name', annotationCreate] as const,
    ['complete', 'without model', undefined, completeAnnotation] as const,
    ['complete', 'with model', 'optional-model-name', completeAnnotation] as const,
  ])('accepts trusted AI-origin %s %s', (operation, _modelCase, model, build) => {
    const provenance = aiProvenance(model === undefined ? {} : { model });
    const value = build(provenance);
    const definition = operation === 'create' ? 'annotationCreate' : 'annotation';

    expect(validators.validate(definition, value)).toEqual({ valid: true, errors: [] });
    expect(validator()(value, context(operation))).toEqual({ valid: true, issues: [] });
  });

  it.each([
    ['create', 'annotationCreate', annotationCreate] as const,
    ['complete', 'annotation', completeAnnotation] as const,
  ])('requires generatedAt structurally and semantically for trusted AI-origin %s', (
    operation,
    definition,
    build,
  ) => {
    const value = build({ kind: 'ai' });
    structuralErrorPath(definition, value, '/provenance');
    expectOnlyIssue(
      validator()(value, context(operation)),
      'ai_generated_at_required',
      '/provenance/generatedAt',
    );
  });

  it.each([
    ['create', 'annotationCreate', annotationCreate, 'not-a-date-time'] as const,
    ['create', 'annotationCreate', annotationCreate, '2026-07-17T06:30:00'] as const,
    ['create', 'annotationCreate', annotationCreate, '2023-02-29T06:30:00Z'] as const,
    ['create', 'annotationCreate', annotationCreate, '2026-07-17T06:30:00+24:00'] as const,
    ['complete', 'annotation', completeAnnotation, 'not-a-date-time'] as const,
    ['complete', 'annotation', completeAnnotation, '2026-07-17T06:30:00'] as const,
    ['complete', 'annotation', completeAnnotation, '2023-02-29T06:30:00Z'] as const,
    ['complete', 'annotation', completeAnnotation, '2026-07-17T06:30:00+24:00'] as const,
  ])('rejects malformed generatedAt=%j structurally and semantically for %s', (
    operation,
    definition,
    build,
    malformed,
  ) => {
    const value = build(aiProvenance({ generatedAt: malformed }));
    structuralErrorPath(definition, value, '/provenance/generatedAt');
    expectOnlyIssue(
      validator()(value, context(operation)),
      'invalid_ai_generated_at',
      '/provenance/generatedAt',
    );
  });

  it.each([
    ['explicit removal', { provenance: null }] as const,
    ['human downgrade', { provenance: { kind: 'human' } }] as const,
    ['imported downgrade', { provenance: { kind: 'imported' } }] as const,
    ['derived downgrade', { provenance: { kind: 'derived' } }] as const,
  ])('rejects AI Provenance %s in a merge patch while content remains AI-derived', (_case, patch) => {
    const current = completeAnnotation(aiProvenance());
    expect(validators.validate('annotationMergePatch', patch).valid).toBe(true);
    expectOnlyIssue(
      validator()(patch, patchContext(current)),
      patch.provenance === null ? 'ai_provenance_removal_forbidden' : 'ai_provenance_downgrade_forbidden',
      patch.provenance === null ? '/provenance' : '/provenance/kind',
    );
  });

  it('inherits current AI Provenance when a merge patch omits the field', () => {
    const current = completeAnnotation(aiProvenance());
    const patch: AnnotationMergePatch = { value: 'Revised generated summary' };

    expect(validators.validate('annotationMergePatch', patch)).toEqual({ valid: true, errors: [] });
    expect(validator()(patch, patchContext(current))).toEqual({ valid: true, issues: [] });
  });

  it('allows an AI Provenance refresh but rejects a malformed replacement timestamp', () => {
    const current = completeAnnotation(aiProvenance());
    const valid: AnnotationMergePatch = {
      provenance: aiProvenance({ generatedAt: '2026-07-17T07:00:00Z' }),
    };
    const malformed: AnnotationMergePatch = {
      provenance: aiProvenance({ generatedAt: '2026-07-17 07:00:00Z' }),
    };

    expect(validator()(valid, patchContext(current))).toEqual({ valid: true, issues: [] });
    structuralErrorPath('annotationMergePatch', malformed, '/provenance/generatedAt');
    expectOnlyIssue(
      validator()(malformed, patchContext(current)),
      'invalid_ai_generated_at',
      '/provenance/generatedAt',
    );
  });

  it('retains kind=ai when generated content is marked editedByHuman=true', () => {
    const provenance = aiProvenance({ editedByHuman: true });
    const value = annotationCreate(provenance);

    expect(provenance.kind).toBe('ai');
    expect(validators.validate('annotationCreate', value)).toEqual({ valid: true, errors: [] });
    expect(validator()(value, context('create'))).toEqual({ valid: true, issues: [] });
  });

  it.each([
    ['create', 'human', annotationCreate] as const,
    ['create', 'imported', annotationCreate] as const,
    ['create', 'derived', annotationCreate] as const,
    ['complete', 'human', completeAnnotation] as const,
    ['complete', 'imported', completeAnnotation] as const,
    ['complete', 'derived', completeAnnotation] as const,
  ])('keeps absent Provenance valid for trusted non-AI %s-origin %s', (operation, origin, build) => {
    expect(validator()(build(), context(operation, origin))).toEqual({ valid: true, issues: [] });
  });

  it('rejects caller-controlled AI Provenance under a trusted non-AI origin', () => {
    const assertedAi = annotationCreate(aiProvenance());

    expectOnlyIssue(
      validator()(assertedAi, context('create', 'human')),
      'untrusted_ai_provenance',
      '/provenance/kind',
    );
    expect(validator()(annotationCreate(), context('create', 'human'))).toEqual({ valid: true, issues: [] });
    expectOnlyIssue(
      validator()(annotationCreate(), context('create', 'ai')),
      'ai_provenance_required',
      '/provenance',
    );
  });

  it('accepts same-Collection sourceNodeIds and preserves their order', () => {
    const sourceNodeIds = ['source-b', 'source-a'];
    const value = annotationCreate(aiProvenance({ sourceNodeIds }));
    const resolveNode: ProvenanceNodeResolver = () => ({ collectionId });

    expect(validator()(value, context('create', 'ai', resolveNode))).toEqual({ valid: true, issues: [] });
    expect(value.provenance?.sourceNodeIds).toEqual(sourceNodeIds);
  });

  it.each([
    ['unresolved', (): ProvenanceNode | undefined => undefined] as const,
    ['foreign Collection', (): ProvenanceNode => ({ collectionId: 'other-collection' })] as const,
  ])('rejects a %s Provenance source with a stable indexed path', (_case, resolveNode) => {
    const value = annotationCreate(aiProvenance({ sourceNodeIds: ['source-ok', 'source-bad'] }));
    const resolver: ProvenanceNodeResolver = (nodeId): ProvenanceNode | undefined =>
      nodeId === 'source-ok' ? { collectionId } : resolveNode();

    expectOnlyIssue(
      validator()(value, context('create', 'ai', resolver)),
      'missing_provenance_source',
      '/provenance/sourceNodeIds/1',
    );
  });

  it('does not mutate create, complete, patch, current, context, or resolver-owned values', () => {
    const create = annotationCreate(aiProvenance({ sourceNodeIds: ['source-a'] }));
    const complete = completeAnnotation(aiProvenance());
    const patch: AnnotationMergePatch = { provenance: aiProvenance({ editedByHuman: true }) };
    const createContext = context('create', 'ai', () => Object.freeze({ collectionId }));
    const updateContext = patchContext(complete);
    const before = JSON.stringify({ create, complete, patch, createContext, updateContext });

    validator()(create, createContext);
    validator()(complete, context('complete'));
    validator()(patch, updateContext);

    expect(JSON.stringify({ create, complete, patch, createContext, updateContext })).toBe(before);
  });

  it('does not default missing trusted AI Provenance to human or write a field into the payload', () => {
    const value = annotationCreate();
    const before = JSON.stringify(value);

    expectOnlyIssue(
      validator()(value, context('create', 'ai')),
      'ai_provenance_required',
      '/provenance',
    );
    expect(value).not.toHaveProperty('provenance');
    expect(JSON.stringify(value)).toBe(before);
  });

  it('keeps publisher endpoints bound to Annotation create and merge-patch wire definitions', () => {
    const endpoints = semanticBoundary.endpointContracts;
    expect(endpoints.annotations.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', request: 'annotationCreate', response: 'annotation' }),
    ]));
    expect(endpoints.annotation.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'PATCH', request: 'annotationMergePatch', response: 'annotation' }),
    ]));
  });

  it('exports the trusted preparation API from the server public boundary', () => {
    for (const name of [
      'createAiAnnotationGenerationContext',
      'createHumanAnnotationEditContext',
      'createNonAiAnnotationMutationContext',
      'prepareAnnotationCreate',
      'prepareAnnotationResource',
      'prepareAnnotationMergePatch',
    ] as const) {
      expect(serverBoundary[name]).toBeTypeOf('function');
      expect(packageBoundary[name]).toBe(serverBoundary[name]);
    }
  });

  it.each([
    ['2026-07-17T14:30:00+08:00', '2026-07-17T06:30:00.000Z'],
    [new Date('2026-07-17T06:30:00Z'), '2026-07-17T06:30:00.000Z'],
  ])('canonicalizes trusted generatedAt input %s', (input, expected) => {
    const trusted = serverBoundary.createAiAnnotationGenerationContext({ generatedAt: input });
    expect(trusted.provenance).toEqual({ kind: 'ai', generatedAt: expected });
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted.provenance)).toBe(true);
  });

  it('normalizes malformed trusted timestamps to a stable context error', () => {
    expect(() => serverBoundary.createAiAnnotationGenerationContext({ generatedAt: 'not-a-date' }))
      .toThrow(expect.objectContaining({
        code: 'invalid_generation_context',
        path: '/generatedAt',
      }));
  });

  it.each(['create', 'resource', 'merge-patch'] as const)(
    'authoritatively emits AI Provenance for %s',
    (operation) => {
      const trusted = serverBoundary.createAiAnnotationGenerationContext({
        generatedAt: '2026-07-17T14:30:00+08:00',
        provider: 'server-provider',
        model: 'optional-model',
      });
      const result = operation === 'create'
        ? serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, { collectionId })
        : operation === 'resource'
          ? serverBoundary.prepareAnnotationResource(completeAnnotation(), trusted)
          : serverBoundary.prepareAnnotationMergePatch(
              completeAnnotation(aiProvenance()),
              { value: 'Fresh generated summary' },
              trusted,
            );
      expect(result.provenance).toEqual({
        kind: 'ai',
        provider: 'server-provider',
        model: 'optional-model',
        generatedAt: '2026-07-17T06:30:00.000Z',
      });
    },
  );

  it('ignores caller provenance assertions at the trusted AI create boundary', () => {
    const input = annotationCreate({ kind: 'human', provider: 'caller-controlled' });
    const trusted = serverBoundary.createAiAnnotationGenerationContext({ generatedAt });
    const result = serverBoundary.prepareAnnotationCreate(input, trusted, { collectionId });
    expect(result.provenance).toEqual({ kind: 'ai', generatedAt: '2026-07-17T06:30:00.000Z' });
    expect(input.provenance).toEqual({ kind: 'human', provider: 'caller-controlled' });
  });

  it('keeps provider, model, and sources optional in trusted AI context', () => {
    const trusted = serverBoundary.createAiAnnotationGenerationContext({ generatedAt });
    const result = serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, { collectionId });
    expect(result.provenance).toEqual({ kind: 'ai', generatedAt: '2026-07-17T06:30:00.000Z' });
  });

  it('resolves AI sourceNodeIds against the Annotation Collection and preserves order', () => {
    const calls: Array<[string, string]> = [];
    const trusted = serverBoundary.createAiAnnotationGenerationContext({
      generatedAt,
      sourceNodeIds: ['source-b', 'source-a'],
    });
    const result = serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, {
      collectionId,
      sourceResolver: {
        hasNode(resolvedCollectionId, nodeId) {
          calls.push([resolvedCollectionId, nodeId]);
          return true;
        },
      },
    });
    expect(calls).toEqual([[collectionId, 'source-b'], [collectionId, 'source-a']]);
    expect(result.provenance?.sourceNodeIds).toEqual(['source-b', 'source-a']);
  });

  it.each([['without resolver', undefined], ['unresolved', { hasNode: () => false }]] as const)(
    'rejects an AI source %s with a stable indexed error',
    (_case, sourceResolver) => {
      const trusted = serverBoundary.createAiAnnotationGenerationContext({
        generatedAt,
        sourceNodeIds: ['source-missing'],
      });
      expect(() => serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, {
        collectionId,
        ...(sourceResolver === undefined ? {} : { sourceResolver }),
      })).toThrow(expect.objectContaining({
        code: 'missing_provenance_source',
        path: '/provenance/sourceNodeIds/0',
      }));
    },
  );

  it.each(['human', 'imported', 'derived'] as const)('allows ordinary trusted %s creates', (origin) => {
    const trusted = serverBoundary.createNonAiAnnotationMutationContext(origin);
    const result = serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, { collectionId });
    expect(result).not.toHaveProperty('provenance');
  });

  it.each(['human', 'imported', 'derived'] as const)(
    'rejects caller-asserted AI Provenance on a trusted %s create',
    (origin) => {
      expect(() => serverBoundary.prepareAnnotationCreate(
        annotationCreate(aiProvenance()),
        serverBoundary.createNonAiAnnotationMutationContext(origin),
        { collectionId },
      )).toThrow(expect.objectContaining({
        code: 'untrusted_ai_provenance',
        path: '/provenance/kind',
      }));
    },
  );

  it('rejects caller-asserted AI Provenance on a fresh complete resource', () => {
    expect(() => serverBoundary.prepareAnnotationResource(
      completeAnnotation(aiProvenance()),
      serverBoundary.createHumanAnnotationEditContext(),
    )).toThrow(expect.objectContaining({ code: 'untrusted_ai_provenance' }));
  });

  it('rejects caller promotion from non-AI to AI in a merge patch', () => {
    expect(() => serverBoundary.prepareAnnotationMergePatch(
      completeAnnotation({ kind: 'human' }),
      { provenance: aiProvenance() },
      serverBoundary.createHumanAnnotationEditContext(),
    )).toThrow(expect.objectContaining({ code: 'untrusted_ai_provenance' }));
  });

  it('preserves AI identity and timestamp and marks a trusted human content edit', () => {
    const previous = completeAnnotation(aiProvenance({ model: 'original-model' }));
    const incoming = { ...previous, value: 'Human revised summary' };
    const result = serverBoundary.prepareAnnotationResource(
      incoming,
      serverBoundary.createHumanAnnotationEditContext(),
      { previous },
    );
    expect(result.provenance).toEqual({
      ...previous.provenance,
      editedByHuman: true,
    });
  });

  it.each(['imported', 'derived'] as const)(
    'preserves AI identity for a trusted %s mutation without claiming a human edit',
    (origin) => {
      const previous = completeAnnotation(aiProvenance());
      const result = serverBoundary.prepareAnnotationResource(
        { ...previous, value: `${origin} transform` },
        serverBoundary.createNonAiAnnotationMutationContext(origin),
        { previous },
      );
      expect(result.provenance).toEqual(previous.provenance);
    },
  );

  it.each([
    ['removal', { provenance: null }],
    ['human replacement', { provenance: { kind: 'human' } }],
    ['imported replacement', { provenance: { kind: 'imported' } }],
    ['derived replacement', { provenance: { kind: 'derived' } }],
  ] as const)('ignores AI Provenance %s at the trusted merge-patch boundary', (_case, patch) => {
    const current = completeAnnotation(aiProvenance({ model: 'authoritative' }));
    const result = serverBoundary.prepareAnnotationMergePatch(
      current,
      patch as AnnotationMergePatch,
      serverBoundary.createHumanAnnotationEditContext(),
    );
    expect(result.provenance).toEqual(current.provenance);
  });

  it.each([
    ['kind', { kind: 'human' }],
    ['provider', aiProvenance({ provider: 'caller-provider', model: 'authoritative-model', sourceNodeIds: ['source-a'] })],
    ['model removal', aiProvenance({ provider: 'authoritative-provider', sourceNodeIds: ['source-a'] })],
    ['generatedAt', aiProvenance({ provider: 'authoritative-provider', model: 'authoritative-model', generatedAt: '2026-07-17T07:30:00Z', sourceNodeIds: ['source-a'] })],
    ['sourceNodeIds', aiProvenance({ provider: 'authoritative-provider', model: 'authoritative-model', sourceNodeIds: ['source-b'] })],
  ] as const)('rebuilds protected AI identity when caller changes %s', (_case, provenance) => {
    const previous = completeAnnotation(aiProvenance({
      provider: 'authoritative-provider',
      model: 'authoritative-model',
      sourceNodeIds: ['source-a'],
    }));
    const result = serverBoundary.prepareAnnotationResource(
      { ...previous, provenance: provenance as Provenance },
      serverBoundary.createHumanAnnotationEditContext(),
      { previous, sourceResolver: { hasNode: () => true } },
    );
    expect(result.provenance).toEqual(previous.provenance);
  });

  it('prevents caller additions to optional AI identity fields', () => {
    const previous = completeAnnotation({ kind: 'ai', generatedAt });
    const result = serverBoundary.prepareAnnotationResource(
      {
        ...previous,
        provenance: aiProvenance({
          provider: 'caller-provider',
          model: 'caller-model',
          sourceNodeIds: ['source-a'],
        }),
      },
      serverBoundary.createHumanAnnotationEditContext(),
      { previous },
    );
    expect(result.provenance).toEqual(previous.provenance);
  });

  it.each([
    ['format', { format: 'plain' as const }],
    ['value', { value: 'Human revised summary' }],
  ])('sets editedByHuman only when human content %s changes', (_case, change) => {
    const previous = completeAnnotation(aiProvenance());
    const result = serverBoundary.prepareAnnotationResource(
      { ...previous, ...change },
      serverBoundary.createHumanAnnotationEditContext(),
      { previous },
    );
    expect(result.provenance).toEqual({ ...previous.provenance, editedByHuman: true });
  });

  it('ignores caller editedByHuman assertions when content is unchanged', () => {
    const previous = completeAnnotation(aiProvenance());
    const result = serverBoundary.prepareAnnotationResource(
      { ...previous, provenance: aiProvenance({ editedByHuman: true }) },
      serverBoundary.createHumanAnnotationEditContext(),
      { previous },
    );
    expect(result.provenance).toEqual(previous.provenance);
  });

  it('never downgrades an authoritative editedByHuman=true value', () => {
    const previous = completeAnnotation(aiProvenance({ editedByHuman: true }));
    const result = serverBoundary.prepareAnnotationResource(
      { ...previous, provenance: aiProvenance({ editedByHuman: false }) },
      serverBoundary.createHumanAnnotationEditContext(),
      { previous },
    );
    expect(result.provenance?.editedByHuman).toBe(true);
  });

  it('distinguishes omission from null and preserves omitted AI Provenance', () => {
    const previous = completeAnnotation(aiProvenance());
    const result = serverBoundary.prepareAnnotationMergePatch(
      previous,
      { visibility: 'protected' },
      serverBoundary.createHumanAnnotationEditContext(),
    );
    expect(result.provenance).toEqual(previous.provenance);
  });

  it('rejects missing and forged mutation contexts', () => {
    for (const contextValue of [undefined, { origin: 'ai', provenance: aiProvenance() }]) {
      expect(() => serverBoundary.prepareAnnotationCreate(
        annotationCreate(),
        contextValue as never,
        { collectionId },
      )).toThrow(expect.objectContaining({ code: 'untrusted_generation_context', path: '' }));
    }
  });

  it('rejects reuse of a consumed trusted context', () => {
    const trusted = serverBoundary.createHumanAnnotationEditContext();
    serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, { collectionId });
    expect(() => serverBoundary.prepareAnnotationCreate(annotationCreate(), trusted, { collectionId }))
      .toThrow(expect.objectContaining({ code: 'untrusted_generation_context', path: '' }));
  });

  it('freezes contexts against mutation and rejects a mutated clone as forged', () => {
    const trusted = serverBoundary.createAiAnnotationGenerationContext({ generatedAt });
    expect(Reflect.set(trusted, 'origin', 'human')).toBe(false);
    expect(trusted.origin).toBe('ai');
    expect(() => serverBoundary.prepareAnnotationCreate(
      annotationCreate(),
      { ...trusted, origin: 'human' } as never,
      { collectionId },
    )).toThrow(expect.objectContaining({ code: 'untrusted_generation_context' }));
  });

  it('returns recursively immutable, detached create and merge-patch outputs', () => {
    const createInput = annotationCreate();
    const created = serverBoundary.prepareAnnotationCreate(
      createInput,
      serverBoundary.createAiAnnotationGenerationContext({ generatedAt }),
      { collectionId },
    );
    const current = completeAnnotation(aiProvenance());
    const patch: AnnotationMergePatch = { value: 'changed' };
    const updated = serverBoundary.prepareAnnotationMergePatch(
      current,
      patch,
      serverBoundary.createHumanAnnotationEditContext(),
    );
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.provenance)).toBe(true);
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(updated.provenance)).toBe(true);
    expect(updated).not.toBe(current);
    expect(updated.provenance).not.toBe(current.provenance);
    expect(createInput).not.toHaveProperty('provenance');
  });

  it('reports structural errors before consulting provenance sources', () => {
    let resolverCalled = false;
    const trusted = serverBoundary.createAiAnnotationGenerationContext({
      generatedAt,
      sourceNodeIds: ['source-a'],
    });
    expect(() => serverBoundary.prepareAnnotationCreate(
      { ...annotationCreate(), visibility: 'invalid' } as unknown as AnnotationCreate,
      trusted,
      {
        collectionId,
        sourceResolver: {
          hasNode() {
            resolverCalled = true;
            return true;
          },
        },
      },
    )).toThrow(expect.objectContaining({ code: 'invalid_annotation_document', path: '/visibility' }));
    expect(resolverCalled).toBe(false);
  });
});
