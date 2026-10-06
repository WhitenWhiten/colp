import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { scanNetscapeBookmarkTags } from './netscape-bookmark-tags.js';
import { readNetscapeBookmarkHref } from './netscape-bookmark-href.js';

/**
 * Production Netscape Bookmark HTML (`NETSCAPE-Bookmark-file-1`) parser.
 *
 * Maps the common interchange shape to a folder/bookmark tree aligned with
 * protocol browser-mapping §4. Unknown attribute materialization (ICON, etc.)
 * is intentionally out of scope for this parser boundary; callers may hang
 * raw attributes off an extensions bag after import.
 *
 * HREF safety (fail-closed): after entity decode and trim, only absolute
 * `http:` / `https:` URLs and scheme-less relative references are accepted.
 * Executable or non-web schemes (`javascript:`, `data:`, `file:`, `vbscript:`,
 * `about:`, etc.) and colon-before-path scheme tricks are rejected.
 */

const NETSCAPE_MARKER = 'NETSCAPE-Bookmark-file-1';

/** Hard import budgets. Node count excludes the synthetic root; depth counts folders. */
export const NETSCAPE_BOOKMARK_LIMITS = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxNodes: 50_000,
  maxDepth: 64,
});

/** Leaf bookmark entry derived from an `<A HREF>` anchor. */
export interface NetscapeBookmarkEntry {
  readonly kind: 'bookmark';
  readonly title: string;
  readonly url: string;
}

/** Folder node derived from an `<H3>` heading with nested `<DL>`. */
export interface NetscapeBookmarkFolder {
  readonly kind: 'folder';
  readonly title: string;
  readonly children: readonly NetscapeBookmarkItem[];
}

export type NetscapeBookmarkItem = NetscapeBookmarkEntry | NetscapeBookmarkFolder;

/**
 * Root of a parsed Netscape document. The synthetic root title is `Bookmarks`
 * when the document does not supply a mapped top-level folder heading.
 */
export interface NetscapeBookmarkDocument {
  readonly kind: 'folder';
  readonly title: string;
  readonly children: readonly NetscapeBookmarkItem[];
}

function freezeBookmark(title: string, url: string): NetscapeBookmarkEntry {
  return Object.freeze({
    kind: 'bookmark' as const,
    title,
    url,
  });
}

/**
 * Whether a decoded Netscape bookmark HREF is allowed for import.
 *
 * Allow:
 * - absolute URLs whose scheme is exactly `http` or `https` (case-insensitive)
 * - scheme-less relative references (`/path`, `foo/bar`, `//host/path`, `?q`, `#frag`)
 *   that do not place a `:` before the first `/`
 *
 * Reject:
 * - empty / whitespace-only values
 * - non-http(s) schemes (`javascript:`, `data:`, `file:`, `vbscript:`, `about:`, …)
 * - values with `:` before the first `/` that are not a valid http(s) scheme form
 *   (covers empty-scheme and other colon tricks)
 */
function isAllowedNetscapeBookmarkHref(href: string): boolean {
  if (href.length === 0) {
    return false;
  }

  // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  const normalized = href.replace(/[\t\r\n]/gu, '');
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(normalized);
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1]!.toLowerCase();
    return scheme === 'http' || scheme === 'https';
  }

  // No recognized scheme. Reject colon-before-first-slash tricks (e.g. ":foo", "1http:x").
  const slashIndex = normalized.indexOf('/');
  const beforeSlash = slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);
  if (beforeSlash.includes(':')) {
    return false;
  }

  return true;
}

/**
 * Parses a Netscape Bookmark HTML document into a frozen folder/bookmark tree.
 *
 * Fail-closed:
 * - malformed tags/attributes, missing marker, empty or non-web HREF → TypeError
 * - UTF-8 input size, node count, or folder depth over budget → RangeError
 */
export function parseNetscapeBookmarkHtml(input: string): NetscapeBookmarkDocument {
  if (typeof input !== 'string') {
    throw new TypeError('Netscape bookmark input must be a string.');
  }
  // Bound allocation before encoding, then account for multibyte UTF-8 input.
  if (input.length > NETSCAPE_BOOKMARK_LIMITS.maxInputBytes
    || new TextEncoder().encode(input).byteLength > NETSCAPE_BOOKMARK_LIMITS.maxInputBytes) {
    throw new RangeError('Netscape bookmark input exceeds the byte budget.');
  }
  if (!input.includes(NETSCAPE_MARKER)) {
    throw new TypeError('Netscape bookmark document must include the NETSCAPE-Bookmark-file-1 marker.');
  }

  type MutableFolder = {
    readonly kind: 'folder';
    title: string;
    children: NetscapeBookmarkItem[];
  };

  const root: MutableFolder = { kind: 'folder', title: 'Bookmarks', children: [] };
  const stack: MutableFolder[] = [root];
  const folders: MutableFolder[] = [root];
  let nodes = 0;
  let pendingFolder: MutableFolder | undefined;

  for (const { closing, tag, attributes, text: rawText } of scanNetscapeBookmarkTags(input)) {
    if (!closing && (tag === 'H3' || tag === 'A')) {
      if (++nodes > NETSCAPE_BOOKMARK_LIMITS.maxNodes) {
        throw new RangeError('Netscape bookmark input exceeds the node budget.');
      }
    }
    const text = decodeHTML(rawText.trim());

    if (tag === 'H3' && !closing) {
      // Check at folder creation, including headings without a subsequent DL.
      if (stack.length > NETSCAPE_BOOKMARK_LIMITS.maxDepth) {
        throw new RangeError('Netscape bookmark input exceeds the folder depth budget.');
      }
      pendingFolder = { kind: 'folder', title: text, children: [] };
      stack.at(-1)!.children.push(pendingFolder);
      folders.push(pendingFolder);
    } else if (tag === 'A' && !closing) {
      const rawHref = readNetscapeBookmarkHref(attributes);
      if (rawHref === undefined || rawHref.length === 0) {
        throw new TypeError('Bookmark anchors must have a non-empty HREF.');
      }
      const href = decodeHTMLAttribute(rawHref).trim();
      if (href.length === 0) {
        throw new TypeError('Bookmark anchors must have a non-empty HREF.');
      }
      if (!isAllowedNetscapeBookmarkHref(href)) {
        throw new TypeError(
          'Bookmark anchors must use only http(s) HREFs (absolute http/https or scheme-less relative).',
        );
      }
      stack.at(-1)!.children.push(freezeBookmark(text, href));
    } else if (tag === 'DL' && !closing && pendingFolder !== undefined) {
      stack.push(pendingFolder);
      pendingFolder = undefined;
    } else if (tag === 'DL' && closing && stack.length > 1) {
      stack.pop();
      pendingFolder = undefined;
    }
  }

  // Freeze bottom-up without recursively walking attacker-controlled nesting.
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const folder = folders[index]!;
    Object.freeze(folder.children);
    Object.freeze(folder);
  }
  return root;
}

/** Marker string fragment recognized by {@link parseNetscapeBookmarkHtml}. */
export const NETSCAPE_BOOKMARK_FILE_MARKER = NETSCAPE_MARKER;
