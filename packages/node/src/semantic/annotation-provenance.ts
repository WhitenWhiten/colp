import { isRfc3339DateTime } from '../shared/date-time.js';
import type {
  Annotation,
  AnnotationCreate,
  AnnotationMergePatch,
  Provenance,
} from '../types/index.js';
import type { SemanticIssue, SemanticValidationResult } from './index.js';

export type AnnotationContentOrigin = Provenance['kind'];

export interface ProvenanceNodeReference {
  readonly collectionId: string;
}

export type ProvenanceNodeResolver = (nodeId: string) => ProvenanceNodeReference | undefined;

export type AnnotationProvenanceValidationContext =
  | {
      readonly operation: 'create' | 'complete';
      /** Trusted server-side origin, never a field deserialized from the request body. */
      readonly contentOrigin: AnnotationContentOrigin;
      readonly collectionId: string;
      readonly resolveNode?: ProvenanceNodeResolver;
    }
  | {
      readonly operation: 'merge-patch';
      /** Trusted server-side origin of the resulting content. */
      readonly contentOrigin: AnnotationContentOrigin;
      readonly collectionId: string;
      readonly current: Annotation;
      readonly resolveNode?: ProvenanceNodeResolver;
    };

/**
 * Semantic Provenance validation for already-parsed Annotation wire values.
 * Structural validation remains the caller's responsibility and should run first.
 */
export function validateAnnotationProvenance(
  value: AnnotationCreate | Annotation | AnnotationMergePatch,
  context: AnnotationProvenanceValidationContext,
): SemanticValidationResult {
  if (context.contentOrigin !== 'ai') {
    const asserted = context.operation === 'merge-patch'
      ? Object.hasOwn(value, 'provenance')
        ? (value as AnnotationMergePatch).provenance
        : undefined
      : (value as AnnotationCreate | Annotation).provenance;
    const preservesExistingAi = context.operation === 'merge-patch'
      && context.current.provenance?.kind === 'ai';
    return asserted?.kind === 'ai' && !preservesExistingAi
      ? invalid(
          'untrusted_ai_provenance',
          'Caller-controlled provenance cannot establish AI generation origin.',
          '/provenance/kind',
        )
      : { valid: true, issues: [] };
  }

  let provenance: Provenance | null | undefined;
  if (context.operation === 'merge-patch') {
    const patch = value as AnnotationMergePatch;
    if (Object.hasOwn(patch, 'provenance')) {
      provenance = patch.provenance;
      if (provenance === null) {
        return invalid(
          'ai_provenance_removal_forbidden',
          'AI provenance cannot be removed while the resulting content remains AI-derived.',
          '/provenance',
        );
      }
      if (provenance?.kind !== 'ai') {
        return invalid(
          'ai_provenance_downgrade_forbidden',
          'AI provenance cannot be changed to another kind.',
          '/provenance/kind',
        );
      }
    } else {
      provenance = context.current.provenance;
    }
  } else {
    provenance = (value as AnnotationCreate | Annotation).provenance;
  }

  if (provenance === undefined || provenance === null) {
    return invalid('ai_provenance_required', 'AI-generated content must carry provenance.', '/provenance');
  }
  if (provenance.kind !== 'ai') {
    return invalid(
      'ai_provenance_kind_required',
      'Trusted AI-generated content requires provenance kind ai.',
      '/provenance/kind',
    );
  }
  if (provenance.generatedAt === undefined) {
    return invalid(
      'ai_generated_at_required',
      'AI provenance requires generatedAt.',
      '/provenance/generatedAt',
    );
  }
  if (!isRfc3339DateTime(provenance.generatedAt)) {
    return invalid(
      'invalid_ai_generated_at',
      'AI provenance generatedAt must be a valid RFC 3339 date-time.',
      '/provenance/generatedAt',
    );
  }

  for (const [index, nodeId] of (provenance.sourceNodeIds ?? []).entries()) {
    const resolved = context.resolveNode?.(nodeId);
    if (resolved === undefined || resolved.collectionId !== context.collectionId) {
      return invalid(
        'missing_provenance_source',
        'Provenance source must resolve to a Node in the Annotation Collection.',
        `/provenance/sourceNodeIds/${index}`,
      );
    }
  }
  return { valid: true, issues: [] };
}

function invalid(code: string, message: string, path: string): SemanticValidationResult {
  const issue: SemanticIssue = Object.freeze({ code, message, path });
  return { valid: false, issues: Object.freeze([issue]) };
}
