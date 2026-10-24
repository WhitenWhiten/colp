import type { ClassificationNativeFolder } from './classification-folder.js';
import type { ClassificationPreviewResponse } from './classification-product-client.js';

/** Only the fields the popup needs, without provider output or confidence distributions. */
export interface ClassificationSuggestion {
  readonly folder: Pick<NonNullable<ClassificationPreviewResponse['folder']>, 'decision' | 'folderId'> | null;
  readonly tags: { readonly candidates: readonly { readonly tag: string; readonly selected: boolean }[] };
  readonly candidateCoverage: ClassificationPreviewResponse['candidateCoverage'];
}

export interface ClassificationPreviewReply {
  readonly ok: boolean;
  readonly destinationPolicyDigest?: string;
  readonly result?: ClassificationSuggestion;
  readonly nativeFolder?: ClassificationNativeFolder | null;
  readonly error?: string;
  readonly status?: number;
  readonly sameRequestRetrySafe?: boolean;
  /** The worker's command survives a popup reopening or a lost response. */
  readonly commandId?: string;
  readonly skipped?: 'already_saved' | 'existence_unavailable' | 'session_limit';
}

/** Session retention stores UI suggestions, never raw model responses, probabilities, or keys. */
export function retainClassificationReply(reply: ClassificationPreviewReply): ClassificationPreviewReply {
  if (!reply.ok || !reply.result) return { ok: reply.ok, ...(reply.error ? { error: reply.error } : {}),
    ...(reply.status === undefined ? {} : { status: reply.status }),
    ...(reply.sameRequestRetrySafe === undefined ? {} : { sameRequestRetrySafe: reply.sameRequestRetrySafe }) };
  const { folder, tags, candidateCoverage: coverage } = reply.result;
  return { ok: true, ...(reply.destinationPolicyDigest ? { destinationPolicyDigest: reply.destinationPolicyDigest } : {}), result: {
    folder: folder ? { decision: folder.decision, folderId: folder.folderId } : null,
    tags: { candidates: tags.candidates.map(tag => ({ tag: tag.tag, selected: tag.selected !== false })) },
    candidateCoverage: { policyVersion: coverage.policyVersion, l1Total: coverage.l1Total, l1Included: coverage.l1Included,
      descendantTotal: coverage.descendantTotal, descendantIncluded: coverage.descendantIncluded,
      tagTotal: coverage.tagTotal, tagIncluded: coverage.tagIncluded },
  }, nativeFolder: reply.nativeFolder ? { folderId: reply.nativeFolder.folderId, nativeId: reply.nativeFolder.nativeId, title: reply.nativeFolder.title } : null };
}
