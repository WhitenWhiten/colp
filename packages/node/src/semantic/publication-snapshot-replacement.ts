import type { Snapshot } from '../types/index.js';
import type { SemanticIssue, SemanticValidationResult } from './index.js';
import { validateSnapshotSemantics } from './snapshot.js';

function issue(code: string, path: string, message: string): SemanticIssue {
  return { code, path, message };
}

/** Validates the authoritative logical Snapshot accepted by a Publication state replacement. */
export function validatePublicationSnapshotReplacementSemantics(
  snapshot: Snapshot,
): SemanticValidationResult {
  const issues: SemanticIssue[] = [];

  if (snapshot.mode !== 'publication') {
    issues.push(issue(
      'invalid_publication_replacement_mode',
      '/mode',
      'Publication state replacement requires Snapshot mode publication.',
    ));
  }
  if (!snapshot.complete) {
    issues.push(issue(
      'incomplete_publication_replacement',
      '/complete',
      'Publication state replacement requires a complete logical Snapshot.',
    ));
  }
  if (
    snapshot.page.sequence !== 1
    || snapshot.page.hasMore
    || snapshot.page.nextCursor !== null
  ) {
    issues.push(issue(
      'unnormalized_publication_replacement_page',
      '/page',
      'Publication state replacement requires an assembled terminal page normalized to sequence 1.',
    ));
  }

  const semantic = validateSnapshotSemantics(snapshot, {
    publicationExtensionMode: 'consumer',
  });
  if (!semantic.valid) issues.push(...semantic.issues);

  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues: Object.freeze(issues) };
}
