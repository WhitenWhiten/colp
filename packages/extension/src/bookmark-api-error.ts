/**
 * Chromium/Edge bookmark API failures. Only verified not_found is absent.
 * Empty get() arrays are a dishonest fake, not the real contract.
 */
export const CHROME_BOOKMARK_NOT_FOUND = "Can't find bookmark for id.";

export type BookmarkApiFailureClass =
  | 'not_found'
  | 'permission_denied'
  | 'managed_not_writable'
  | 'other_failure';

export class BookmarkApiError extends Error {
  readonly failureClass: BookmarkApiFailureClass;
  /**
   * Set only when the refusal says nothing about the bookmark it was about (a write quota): the engine then
   * names the cause (`code`) and waits (`retryAfterMilliseconds`) instead of treating the node as unappliable.
   */
  readonly code?: string;
  readonly retryAfterMilliseconds?: number;
  constructor(failureClass: BookmarkApiFailureClass, message: string,
    cause?: { readonly code: string; readonly retryAfterMilliseconds: number }) {
    super(message);
    this.name = 'BookmarkApiError';
    this.failureClass = failureClass;
    if (cause) { this.code = cause.code; this.retryAfterMilliseconds = cause.retryAfterMilliseconds; }
  }
}

/** `chrome.bookmarks` allows 100 writes a minute (sustained) and 1000 an hour; past either, every write is refused. */
export const BOOKMARK_WRITE_QUOTA_CODE = 'bookmark_write_quota';
const QUOTA_MESSAGE = /This request exceeds the (\S+) quota/iu;
const QUOTA_MINUTE_MS = 60_000;
const QUOTA_HOUR_MS = 5 * 60_000;

/** The wait a quota refusal asks for, or undefined when the message is not a quota refusal. */
export function bookmarkWriteQuotaWait(message: string): number | undefined {
  const name = QUOTA_MESSAGE.exec(message)?.[1];
  if (!name) return undefined;
  return /MINUTE/iu.test(name) ? QUOTA_MINUTE_MS : QUOTA_HOUR_MS;
}

export type BookmarkNode = {
  readonly id: string; readonly parentId?: string; readonly index?: number;
  readonly title?: string; readonly url?: string; readonly unmodifiable?: string;
};

export type BookmarkLookup =
  | { readonly class: 'present'; readonly nodes: readonly BookmarkNode[] }
  | { readonly class: 'not_found' }
  | { readonly class: 'permission_denied'; readonly message: string }
  | { readonly class: 'managed_not_writable'; readonly message: string }
  | { readonly class: 'other_failure'; readonly message: string };

export function classifyBookmarkApiFailure(error: unknown): BookmarkApiFailureClass {
  if (error instanceof BookmarkApiError) return error.failureClass;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (isNotFoundMessage(message)) return 'not_found';
  // The root folders (Bookmarks bar, Other bookmarks, ...) can never be written by an extension, with or without
  // permission; Chromium says "Can't modify the root bookmark folders." That is about one node, not about the
  // extension's permission, so it is not `permission_denied` (which stops the whole replica).
  if (/unmodifiable|managed bookmark|Can't modify (a )?managed|root bookmark folders|Bookmark roots can't be modified|Can't remove (the )?root/iu
    .test(message)) return 'managed_not_writable';
  if (/permission|not authorized|denied/iu.test(message)) return 'permission_denied';
  return 'other_failure';
}

export function bookmarkApiErrorFromUnknown(error: unknown): BookmarkApiError {
  if (error instanceof BookmarkApiError) return error;
  const message = error instanceof Error ? error.message : String(error ?? 'bookmark_api_failed');
  const wait = bookmarkWriteQuotaWait(message);
  if (wait !== undefined) {
    return new BookmarkApiError('other_failure', message, { code: BOOKMARK_WRITE_QUOTA_CODE, retryAfterMilliseconds: wait });
  }
  return new BookmarkApiError(classifyBookmarkApiFailure(error), message);
}

export async function lookupBookmark(
  get: (id: string) => Promise<readonly BookmarkNode[]>, id: string,
): Promise<BookmarkLookup> {
  try {
    const nodes = await get(id);
    // Real Chromium rejects missing ids. An empty array is not verified not_found.
    if (nodes.length === 0) {
      return { class: 'other_failure', message: 'bookmark_lookup_empty' };
    }
    return { class: 'present', nodes };
  } catch (error) {
    return failureLookup(error);
  }
}

export async function lookupBookmarkChildren(
  getChildren: (id: string) => Promise<readonly BookmarkNode[]>, id: string,
): Promise<BookmarkLookup> {
  try {
    const nodes = await getChildren(id);
    return { class: 'present', nodes };
  } catch (error) {
    return failureLookup(error);
  }
}

function failureLookup(error: unknown): BookmarkLookup {
  const failureClass = classifyBookmarkApiFailure(error);
  const message = error instanceof Error ? error.message : String(error ?? 'bookmark_api_failed');
  if (failureClass === 'not_found') return { class: 'not_found' };
  if (failureClass === 'permission_denied') return { class: 'permission_denied', message };
  if (failureClass === 'managed_not_writable') return { class: 'managed_not_writable', message };
  return { class: 'other_failure', message };
}

function isNotFoundMessage(message: string): boolean {
  // Chromium words a missing parent (create, move) and a missing node (update) as "Can't find parent bookmark for id."
  return message === CHROME_BOOKMARK_NOT_FOUND
    || /Can't find (parent )?bookmark for id/iu.test(message)
    || /Bookmark not found/iu.test(message);
}
