/**
 * Classify inbox eligibility (§5.1). Pure in-memory predicate: no I/O, no
 * created_at window. Any single failure returns false. Never throws.
 */
export type ClassifyInboxNodeKind = 'root' | 'folder' | 'bookmark';

export type ClassifyInboxEligibilitySnapshot = {
  readonly isOwner: boolean;
  readonly kind: ClassifyInboxNodeKind;
  readonly softDeleted: boolean;
  readonly url: string;
  readonly parentKind: ClassifyInboxNodeKind;
  readonly hasSidecar: boolean;
};

export function isClassifyInboxEligible(
  snapshot: ClassifyInboxEligibilitySnapshot,
): boolean {
  try {
    if (snapshot === null || typeof snapshot !== 'object') {
      return false;
    }
    if (snapshot.isOwner !== true) {
      return false;
    }
    if (snapshot.kind !== 'bookmark') {
      return false;
    }
    if (snapshot.softDeleted !== false) {
      return false;
    }
    if (typeof snapshot.url !== 'string' || snapshot.url.trim().length < 1) {
      return false;
    }
    if (snapshot.parentKind !== 'root') {
      return false;
    }
    if (snapshot.hasSidecar !== false) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
