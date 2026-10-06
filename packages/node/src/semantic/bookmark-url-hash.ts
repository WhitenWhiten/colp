import type {
  CreateNodeOperationPayload,
  Node,
  NodeCreate,
  NodeMergePatch,
} from '../types/generated.js';
import { urlHashMatches } from '../shared/url-hash.js';
import type { SemanticIssue, SemanticValidationResult } from './index.js';

type BookmarkUrlHashCarrier = {
  readonly url?: unknown;
  readonly urlHash?: unknown;
};

function valid(): SemanticValidationResult {
  return { valid: true, issues: [] };
}

function mismatch(path: string): SemanticValidationResult {
  const issue: SemanticIssue = {
    code: 'url_hash_mismatch',
    path,
    message: 'URL hash must be SHA-256 over the exact UTF-8 bytes of the preserved Bookmark URL.',
  };
  return { valid: false, issues: Object.freeze([issue]) };
}

/** Validates a complete, non-redacted Bookmark without parsing or rewriting its URL. */
export function validateBookmarkUrlHashSemantics(
  bookmark: BookmarkUrlHashCarrier,
  path = '/urlHash',
): SemanticValidationResult {
  if (bookmark.urlHash === undefined) return valid();
  if (
    typeof bookmark.url !== 'string' ||
    typeof bookmark.urlHash !== 'string' ||
    !urlHashMatches(bookmark.url, bookmark.urlHash)
  ) {
    return mismatch(path);
  }
  return valid();
}

/** Validates an authoritative or response Node when it is a URL-bearing Bookmark. */
export function validateNodeUrlHashSemantics(
  node: Node,
  path = '/urlHash',
): SemanticValidationResult {
  return node.kind === 'bookmark' && node.redacted !== true
    ? validateBookmarkUrlHashSemantics(node, path)
    : valid();
}

/** Validates a Bookmark create DTO, where url and urlHash are available together. */
export function validateNodeCreateUrlHashSemantics(
  create: NodeCreate,
  path = '/urlHash',
): SemanticValidationResult {
  return create.kind === 'bookmark'
    ? validateBookmarkUrlHashSemantics(create, path)
    : valid();
}

/** Validates the Node nested in the Publisher and Sync create payload shape. */
export function validateNodeCreateRequestUrlHashSemantics(
  request: CreateNodeOperationPayload,
  path = '/node/urlHash',
): SemanticValidationResult {
  return validateNodeCreateUrlHashSemantics(request.node, path);
}

/**
 * Validates URL/hash semantics after applying a JSON Merge Patch to the current Node.
 * A missing patch member preserves its current value; null removes it.
 */
export function validateNodeMergePatchUrlHashSemantics(
  current: Node,
  patch: NodeMergePatch,
  path = '/urlHash',
): SemanticValidationResult {
  if (current.kind !== 'bookmark' || current.redacted === true) return valid();

  const resultingUrl = patch.url === undefined ? current.url : patch.url ?? undefined;
  const resultingUrlHash =
    patch.urlHash === undefined ? current.urlHash : patch.urlHash ?? undefined;

  return validateBookmarkUrlHashSemantics(
    { url: resultingUrl, urlHash: resultingUrlHash },
    path,
  );
}
