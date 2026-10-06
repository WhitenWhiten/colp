export * from './endpoint-contracts.js';
export * from './annotation-provenance.js';
export * from './bookmark-url-hash.js';
export * from './manifest.js';
export * from './publication-endpoint-templates.js';
export * from './publication-endpoints.js';
export * from './publication-snapshot-replacement.js';
export * from './snapshot.js';
export * from '../shared/resource-identity.js';
export * from '../shared/url-hash.js';

export interface SemanticIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type SemanticValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly SemanticIssue[] };

export interface SemanticValidator<Value = unknown, Context = unknown> {
  validate(value: Value, context: Context): SemanticValidationResult;
}
