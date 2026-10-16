import type { ImportRequest } from './types.js';
import { t } from './i18n.js';

export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;

type NativePreviewRequest = Extract<ImportRequest, { kind: 'known.import.previewNative' }>;

/**
 * Builds the native-import preview request. Prefers embedding the tree read in
 * the calling document, but falls back to a worker-side read (no `tree` field)
 * when the read fails — a page opened before the runtime permission grant may
 * not expose the chrome.bookmarks binding yet — or when the serialized tree
 * cannot cross the message boundary.
 */
export async function nativeImportMessage(readTree: () => Promise<unknown>,
  maxBytes = MAX_IMPORT_FILE_BYTES): Promise<NativePreviewRequest> {
  try {
    const encoded = JSON.stringify(await readTree());
    if (typeof encoded !== 'string' || encoded.length > maxBytes) return { kind: 'known.import.previewNative' };
    return { kind: 'known.import.previewNative', tree: JSON.parse(encoded) };
  } catch { return { kind: 'known.import.previewNative' }; }
}

/** Maps a background import error code to user copy; returns null for codes with no curated message. */
function knownImportError(code: string): string | null {
  if (code === 'input_too_large') return t('import_bookmarkFileTooLarge', 'The bookmark file is too large.');
  if (code === 'unsupported_format') {
    return t('import_useHtmlBookmarkFile', "Use an HTML bookmark file, or This browser's bookmarks.");
  }
  if (code === 'import_empty') return t('import_sourceHasNoBookmarks', 'The source has no bookmarks to import.');
  if (code === 'input_invalid') return t('import_chooseBookmarkFileIsnt', "Choose a bookmark file that isn't empty.");
  if (code === 'folder_choice_invalid') return t('import_destinationOutsideSelectedSync', 'That destination is outside the selected sync folders.');
  if (code === 'folder_choice_required') return t('import_mapSkipEveryImported', 'Map or skip every imported folder before importing.');
  if (code === 'permission_required') return t('import_allowBookmarkAccessBefore', "Allow bookmark access before reading this browser's bookmarks.");
  if (code === 'not_connected') return t('import_signBeforeImporting', 'Sign in before importing.');
  if (code === 'collection_required') return t('import_libraryConnecting', 'Your bookmark library is connecting. Try importing again in a moment.');
  if (code === 'chrome_tree_invalid' || code === 'preview_invalid' || code === 'operation_failed'
      || code === 'operation_typeerror') {
    return t('import_browsersBookmarkTreeCould', "This browser's bookmark tree could not be read. Try again, or import an HTML bookmark file.");
  }
  if (code === 'depth_limit' || code === 'node_limit' || code === 'member_limit') {
    return t('import_bookmarkTreeTooLarge', 'The bookmark tree is too large to import in one pass.');
  }
  if (code === 'preview_expired') return t('import_previewSourceAgainBefore', 'Preview the source again before importing.');
  if (code === 'import_in_progress') return t('import_finishResolveCurrentImport', 'Finish or resolve the current import before starting another.');
  if (code === 'session_expired') return t('import_reconnectThenResumeImport', 'Reconnect, then resume the import.');
  if (code === 'extension_unavailable') return t('import_extensionCouldNotFinish', 'The extension could not finish this import. Close this page and try again.');
  if (code === 'offline') return t('import_knowNServerCould', 'The Know-N server could not be reached. Check your connection, then try again.');
  if (code.startsWith('session_') || code.startsWith('credential_') || code === 'authentication_required') {
    return t('import_signSessionNoLonger', 'Your sign-in session is no longer valid. Sign in again, then retry the import.');
  }
  return null;
}

/** Maps a background import error code to user copy; a code with no curated message gets a general sentence. */
export function importErrorMessage(code: string): string {
  return knownImportError(code) ?? t('import_importCouldNotContinue', 'The import could not continue. Review the source and try again.');
}

/** import-preview.ts stays chrome-free, so its English warnings are translated where they are shown. */
export function importWarningCopy(message: string): string {
  const fixed: Record<string, string> = {
    'Bookmark without HREF was omitted.': t('import_bookmarkWithoutHrefOmitted', 'Bookmark without HREF was omitted.'),
    'URL is not permitted by the Collection Protocol bookmark URL contract and was omitted.': t('import_urlNotPermittedCollection', 'URL is not permitted by the Collection Protocol bookmark URL contract and was omitted.'),
    'Favicon data is previewed as sidecar-only and is never fetched.': t('import_faviconDataPreviewedSidecar', 'Favicon data is previewed as sidecar-only and is never fetched.'),
    'URL scheme is preserved for authority but may require an explicit target mount policy.': t('import_urlSchemePreservedAuthority', 'URL scheme is preserved for authority but may require an explicit target mount policy.'),
    'Invalid browser timestamp was omitted.': t('import_invalidBrowserTimestampOmitted', 'Invalid browser timestamp was omitted.'),
    'Invalid bookmark timestamp was omitted.': t('import_invalidBookmarkTimestampOmitted', 'Invalid bookmark timestamp was omitted.'),
    'Unknown Netscape attributes are preserved in the source extension namespace.': t('import_unknownNetscapeAttributesPreserved', 'Unknown Netscape attributes are preserved in the source extension namespace.'),
  };
  if (fixed[message]) return fixed[message];
  const duplicate = /^Duplicate title and URL preserved as a distinct occurrence; first occurrence is (.+)\.$/u.exec(message);
  if (duplicate) return t('import_duplicateTitleUrlPreserved', 'Duplicate title and URL preserved as a distinct occurrence; first occurrence is $1.', duplicate[1]!);
  const inert = /^(.+) element was ignored as inert data\.$/u.exec(message);
  if (inert) return t('import_elementIgnoredInertData', '$1 element was ignored as inert data.', inert[1]!);
  return message;
}
