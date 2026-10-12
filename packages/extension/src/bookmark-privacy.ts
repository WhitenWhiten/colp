export type BrowserRootStatus = 'ready' | 'nested_normalized' | 'root_missing' | 'permission_required'
  | 'tree_unavailable' | 'corrupt';

export interface PrivacyDecisionInput {
  readonly rootStatus: BrowserRootStatus;
  readonly mapped: boolean;
  readonly selected: boolean;
  readonly privateLocal: boolean;
  readonly managed?: boolean;
}
export type PrivacyDecision = { readonly allowOperationCandidate: true; readonly reason: 'selected' }
  | { readonly allowOperationCandidate: false; readonly reason: 'private_local' | 'not_selected'
    | 'mapping_unavailable' | 'root_unavailable' | 'invalid_input' | 'managed' };

// P3-30 calls this before it constructs a candidate or materializes bookmark content.
export function decideLocalPrivacy(input: PrivacyDecisionInput | null | undefined): PrivacyDecision {
  if (!input || typeof input !== 'object') return { allowOperationCandidate: false, reason: 'invalid_input' };
  if (input.rootStatus !== 'ready' && input.rootStatus !== 'nested_normalized') {
    return { allowOperationCandidate: false, reason: 'root_unavailable' };
  }
  if (input.managed) return { allowOperationCandidate: false, reason: 'managed' };
  if (input.privateLocal) return { allowOperationCandidate: false, reason: 'private_local' };
  if (!input.selected) return { allowOperationCandidate: false, reason: 'not_selected' };
  if (!input.mapped) return { allowOperationCandidate: false, reason: 'mapping_unavailable' };
  return { allowOperationCandidate: true, reason: 'selected' };
}
