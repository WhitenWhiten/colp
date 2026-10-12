import type { MetadataBinding, MetadataField } from './local-metadata-state.js';

export interface NoteBinding extends MetadataBinding<string | null> {
  readonly annotationId: string | null;
  readonly supported: boolean;
}
export interface NoteIntent {
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly commandId: string;
  readonly version: number;
  readonly action: 'create' | 'update' | 'delete';
  readonly annotationId: string | null;
  readonly revision: string;
  readonly value: string | null;
}
export type NoteField = MetadataField<string | null, NoteBinding>;
export type NoteCompletion = { readonly kind: 'applied'; readonly binding: NoteBinding } | { readonly kind: 'review' };
/** The pin's remote baseline keeps the node's whole extension map (canonical JSON), the base of an update. */
export interface PinBinding extends MetadataBinding<boolean> {
  readonly extensions: string;
}
export type PinField = MetadataField<boolean, PinBinding>;
