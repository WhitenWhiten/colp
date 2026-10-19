import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ConversionPreview, Warning } from '@know-n/colp/types';
import { parse } from 'parse5';
import { normalizeAnnotationNote, normalizeAnnotationTags } from './bookmark-annotation-store.js';

import { bookmarkUrl as bookmarkUrlValidator,
  conversionPreview as conversionPreviewValidator } from './generated/import-preview-validators.js';
import { SNAPSHOT_V02_SUPPORT } from './snapshot-v02-pages.js';
import { canonicalJson as canonicalJsonValue } from './canonical-json.js';

export interface ImportLimits {
  readonly maxInputBytes: number;
  readonly maxDepth: number;
  readonly maxMembers: number;
  readonly maxNodes: number;
}

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxInputBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxMembers: 64,
  maxNodes: SNAPSHOT_V02_SUPPORT.maxNodes,
});

export type ImportErrorCode = 'input_invalid' | 'input_too_large' | 'depth_limit' | 'member_limit'
  | 'node_limit' | 'chrome_tree_invalid' | 'unsupported_format' | 'import_empty';

export class ImportPreviewError extends Error {
  constructor(readonly code: ImportErrorCode) { super(code); this.name = 'ImportPreviewError'; }
}

export interface ImportSourceRef {
  readonly nativeId?: string;
  readonly nativeParentId?: string;
  readonly nativeIndex?: number;
  readonly dateAdded?: number;
  readonly dateGroupModified?: number;
  readonly dateLastUsed?: number;
  readonly syncing?: boolean;
}

export interface NormalizedImportNode {
  readonly sourceNodeId: string;
  readonly kind: 'Folder' | 'Bookmark' | 'Separator';
  readonly title?: string;
  readonly url?: string;
  readonly icon?: string;
  readonly folderRole?: 'bookmarks-bar' | 'other-bookmarks' | 'mobile-bookmarks' | 'managed-bookmarks';
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly childrenModifiedAt?: string;
  readonly lastUsedAt?: string;
  readonly readOnly?: boolean;
  readonly sourceRef: Readonly<ImportSourceRef>;
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** Netscape TAGS attribute and the DD line after a bookmark. Used by the local import only. */
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly description?: string;
  readonly children: readonly NormalizedImportNode[];
}

export interface ImportConversionResult {
  readonly source: { readonly profile: 'netscape-bookmarks-v1' | 'chromium-bookmarks-v1'; readonly identity: string };
  readonly duplicatePolicy: 'preserve-occurrences';
  readonly preview: ConversionPreview;
  readonly tree: readonly NormalizedImportNode[];
  readonly digest: string;
}

export interface ChromeImportBookmarkNode {
  readonly id: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly title: string;
  readonly url?: string;
  readonly type?: 'bookmark' | 'folder' | 'separator';
  readonly children?: readonly ChromeImportBookmarkNode[];
  readonly dateAdded?: number;
  readonly dateGroupModified?: number;
  readonly dateLastUsed?: number;
  readonly folderType?: 'bookmarks-bar' | 'other' | 'mobile' | 'managed';
  readonly syncing?: boolean;
  readonly unmodifiable?: string;
}

interface HtmlNode {
  readonly nodeName?: unknown;
  readonly tagName?: unknown;
  readonly value?: unknown;
  readonly attrs?: unknown;
  readonly childNodes?: unknown;
}

interface HtmlAttribute { readonly name: string; readonly value: string }
interface PendingNode extends Omit<NormalizedImportNode, 'sourceNodeId' | 'children'> {
  readonly path: string;
  readonly omit?: boolean;
  readonly children: readonly PendingNode[];
}
interface PreviewState { nodes: number; visitedNodes: number; sidecarOnly: number; lossy: number;
  readonly warnings: Warning[]; readonly duplicates: Map<string, string> }

/** Supported: Netscape HTML bookmark export; Chromium JSON/tree via native preview only. */
const NETSCAPE_NS = 'https://know-n.com/colp/ns/netscape-bookmark-html/v1';
const CHROME_KEYS = new Set(['id', 'parentId', 'index', 'title', 'url', 'type', 'children', 'dateAdded',
  'dateGroupModified', 'dateLastUsed', 'folderType', 'syncing', 'unmodifiable']);
const utf8 = new TextEncoder();

export function previewNetscapeBookmarkImport(bytes: Uint8Array, overrides: Partial<ImportLimits> = {}): ImportConversionResult {
  const limits = resolveLimits(overrides);
  if (!(bytes instanceof Uint8Array)) fail('input_invalid');
  if (bytes.byteLength > limits.maxInputBytes) fail('input_too_large');
  let input: string;
  try { input = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('input_invalid'); }
  sniffNetscapeSource(input);
  const document = parse(input) as unknown as HtmlNode;
  validateParsedHtml(document, limits);
  const state = createState();
  scanUnsafeElements(document, state);
  const roots = topLevelElements(document, 'dl');
  if (roots.length === 0) fail(/netscape-bookmark-file-1/i.test(input) ? 'import_empty' : 'unsupported_format');
  const pending = roots.flatMap((root, index) => parseNetscapeList(root, 0, `r${index}`, limits, state));
  const sourceIdentity = digestBytes(bytes);
  return finish('netscape-bookmarks-v1', sourceIdentity, pending, state);
}

export function previewChromeBookmarkImport(input: unknown, overrides: Partial<ImportLimits> = {}): ImportConversionResult {
  const limits = resolveLimits(overrides); const state = createState();
  if (!Array.isArray(input) || input.length !== 1) fail('chrome_tree_invalid');
  const seenIds = new Set<string>(); const active = new Set<object>();
  const root = parseChromeNode(input[0], undefined, undefined, 0, 'root', limits, state, seenIds, active, true);
  const canonicalSource = canonicalJson(toCanonicalChrome(root));
  if (utf8.encode(canonicalSource).byteLength > limits.maxInputBytes) fail('input_too_large');
  const sourceIdentity = digestText(canonicalSource);
  return finish('chromium-bookmarks-v1', sourceIdentity, root.children, state);
}

/** Copies a live Chromium bookmark tree into the strict preview shape. */
export function normalizeChromeBookmarkTree(input: unknown): unknown {
  const nodes = asUnknownArray(input, 8);
  if (nodes.length === 0) fail('chrome_tree_invalid');
  const seen = new Set<string>();
  const active = new Set<object>();
  if (nodes.length === 1) return [normalizeLiveChromeNode(nodes[0], true, undefined, 0, seen, active)];
  return [{ id: 'known-native-root', title: '', children: nodes.map((node, index) =>
    normalizeLiveChromeNode(node, false, 'known-native-root', index, seen, active)) }];
}

function parseNetscapeList(list: HtmlNode, depth: number, path: string, limits: ImportLimits, state: PreviewState): PendingNode[] {
  if (depth > limits.maxDepth) fail('depth_limit');
  const children = elementChildren(list); const consumedLists = new Set<HtmlNode>(); const output: PendingNode[] = [];
  let entryIndex = 0;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]; if (!child || tag(child) !== 'dt') continue;
    const entry = findEntryElement(child); if (!entry) continue;
    visitNode(state, limits);
    const entryPath = `${path}.${entryIndex}`; entryIndex += 1;
    const entryTag = tag(entry); const attributes = attrs(entry, limits); const attributeMap = new Map(attributes.map((item) => [item.name, item.value]));
    if (entryTag === 'h3') {
      const nested = firstDescendant(child, 'dl') ?? nextList(children, index, consumedLists);
      if (nested) consumedLists.add(nested);
      const folderChildren = nested ? parseNetscapeList(nested, depth + 1, `${entryPath}.c`, limits, state) : [];
      const extension = unknownNetscapeAttributes(attributes, new Set(['add_date', 'last_modified', 'personal_toolbar_folder']));
      const description = normalizeAnnotationNote(folderDescriptionAfter(children, index));
      const node: PendingNode = {
        path: entryPath, kind: 'Folder', title: textContent(entry), sourceRef: {}, children: folderChildren,
        ...(description ? { description } : {}),
        ...(attributeMap.get('personal_toolbar_folder')?.toLowerCase() === 'true' ? { folderRole: 'bookmarks-bar' as const } : {}),
        ...timestampFields(attributeMap, entryPath, state, 'netscape-folder'),
        ...(extension ? { extensions: { [NETSCAPE_NS]: { attributes: extension } } } : {}),
      };
      preserveUnknownWarning(extension, entryPath, state); addNode(state); output.push(node); continue;
    }
    if (entryTag === 'hr') {
      addNode(state); output.push({ path: entryPath, kind: 'Separator', sourceRef: {}, children: [] }); continue;
    }
    const href = attributeMap.get('href');
    if (href === undefined || href.length === 0) {
      warn(state, 'bookmark_missing_href', 'Bookmark without HREF was omitted.', entryPath, true); state.lossy += 1; continue;
    }
    if (!bookmarkUrlValidator(href)) {
      warn(state, 'unsupported_url_scheme', 'URL is not permitted by the Collection Protocol bookmark URL contract and was omitted.', entryPath, true);
      state.lossy += 1; continue;
    }
    const extension = unknownNetscapeAttributes(attributes, new Set(['href', 'add_date', 'last_modified', 'icon', 'icon_uri']));
    const icon = attributeMap.get('icon');
    const tags = normalizeAnnotationTags((attributeMap.get('tags') ?? '').split(',')), note = normalizeAnnotationNote(noteAfter(children, index));
    const node: PendingNode = {
      path: entryPath, kind: 'Bookmark', title: textContent(entry), url: href, sourceRef: {}, children: [],
      ...(typeof icon === 'string' && icon.length > 0 ? { icon } : {}),
      ...(tags.length ? { tags } : {}), ...(note === null ? {} : { note }),
      ...timestampFields(attributeMap, entryPath, state, 'netscape-bookmark'),
      ...(extension ? { extensions: { [NETSCAPE_NS]: { attributes: extension } } } : {}),
    };
    addUrlWarnings(node, entryPath, state); preserveUnknownWarning(extension, entryPath, state);
    if (attributeMap.has('icon') || attributeMap.has('icon_uri')) {
      warn(state, 'favicon_sidecar_only', 'Favicon data is previewed as sidecar-only and is never fetched.', entryPath, false); state.sidecarOnly += 1;
    }
    addNode(state); output.push(node);
  }
  return output;
}

function parseChromeNode(value: unknown, expectedParentId: string | undefined, expectedIndex: number | undefined, depth: number,
  path: string, limits: ImportLimits, state: PreviewState, seenIds: Set<string>, active: Set<object>, isRoot: boolean): PendingNode {
  if (depth > limits.maxDepth) fail('depth_limit');
  const record = chromeRecord(value, limits); const identity = record as object;
  visitNode(state, limits);
  if (active.has(identity) || seenIds.has(record.id as string)) fail('chrome_tree_invalid');
  active.add(identity); seenIds.add(record.id as string);
  const id = requiredString(record.id); const title = requiredString(record.title, true);
  const parentId = optionalString(record.parentId); const index = optionalInteger(record.index);
  if (isRoot ? parentId !== undefined || index !== undefined : parentId !== expectedParentId || index !== expectedIndex) {
    fail('chrome_tree_invalid');
  }
  const url = optionalString(record.url, true); const type = optionalEnum(record.type, ['bookmark', 'folder', 'separator'] as const);
  const rawChildren = record.children;
  if (rawChildren !== undefined && !Array.isArray(rawChildren)) fail('chrome_tree_invalid');
  if ((type === 'folder' && url !== undefined) || (type === 'bookmark' && url === undefined)
    || (type === 'separator' && url !== undefined)) fail('chrome_tree_invalid');
  const kind = type === 'separator' ? 'Separator' : (type === 'bookmark' || url !== undefined) ? 'Bookmark' : 'Folder';
  if ((isRoot && kind !== 'Folder') || (kind === 'Folder' && !Array.isArray(rawChildren))
    || (kind !== 'Folder' && rawChildren !== undefined)) fail('chrome_tree_invalid');
  const children = (rawChildren as readonly unknown[] | undefined ?? []).map((child, childIndex) => parseChromeNode(
    child, id, childIndex, depth + 1, `${path}.${childIndex}`, limits, state, seenIds, active, false));
  active.delete(identity);
  const folderType = optionalEnum(record.folderType, ['bookmarks-bar', 'other', 'mobile', 'managed'] as const);
  const unmodifiable = optionalString(record.unmodifiable, true); const syncing = optionalBoolean(record.syncing);
  const dateAdded = optionalFiniteNumber(record.dateAdded); const dateGroupModified = optionalFiniteNumber(record.dateGroupModified);
  const dateLastUsed = optionalFiniteNumber(record.dateLastUsed);
  if ((dateGroupModified !== undefined && kind !== 'Folder') || (dateLastUsed !== undefined && kind !== 'Bookmark')) {
    fail('chrome_tree_invalid');
  }
  const sourceRef: ImportSourceRef = { nativeId: id, ...(parentId === undefined ? {} : { nativeParentId: parentId }),
    ...(index === undefined ? {} : { nativeIndex: index }), ...(dateAdded === undefined ? {} : { dateAdded }),
    ...(dateGroupModified === undefined ? {} : { dateGroupModified }), ...(dateLastUsed === undefined ? {} : { dateLastUsed }),
    ...(syncing === undefined ? {} : { syncing }) };
  if (folderType !== undefined && kind !== 'Folder') fail('chrome_tree_invalid');
  const omit = kind === 'Bookmark' && !bookmarkUrlValidator(url);
  const node: PendingNode = { path, kind, ...(omit ? { omit: true } : {}), ...(kind === 'Separator' ? {} : { title }),
    ...(kind === 'Bookmark' ? { url } : {}),
    ...(folderType ? { folderRole: chromeFolderRole(folderType) } : {}), ...(unmodifiable === 'managed' ? { readOnly: true } : {}),
    sourceRef, children, ...chromeTimestampFields(dateAdded, dateGroupModified, dateLastUsed, path, state) };
  if (!isRoot) {
    if (omit) { warn(state, 'unsupported_url_scheme', 'URL is not permitted by the Collection Protocol bookmark URL contract and was omitted.', path, true);
      state.lossy += 1; }
    else { addNode(state); if (kind === 'Bookmark') addUrlWarnings(node, path, state); }
  }
  return node;
}

function finish(profile: ImportConversionResult['source']['profile'], sourceIdentity: string, pending: readonly PendingNode[],
  state: PreviewState): ImportConversionResult {
  const tree = pending.filter((node) => !node.omit).map((node) => finalizeNode(node, sourceIdentity));
  if (tree.length === 0) fail('import_empty');
  const conversionPreview: ConversionPreview = { creates: state.nodes, updates: 0, moves: 0, deletes: 0,
    sidecarOnly: state.sidecarOnly, lossy: state.lossy, warnings: state.warnings };
  if (!conversionPreviewValidator(conversionPreview)) fail('input_invalid');
  const body = { source: { profile, identity: sourceIdentity }, duplicatePolicy: 'preserve-occurrences' as const,
    preview: conversionPreview, tree };
  return deepFreeze({ ...body, digest: digestText(canonicalJson(body)) });
}

/**
 * Rehydrates a conversion persisted across MV3 worker restarts. The digest is
 * recomputed over the canonical body exactly as `finish` produced it, so any
 * corruption or tampering of the stored bytes fails closed.
 */
export function parseStoredImportConversion(value: unknown): ImportConversionResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const profile = (source as Record<string, unknown>).profile;
  const identity = (source as Record<string, unknown>).identity;
  if (profile !== 'netscape-bookmarks-v1' && profile !== 'chromium-bookmarks-v1') return undefined;
  if (typeof identity !== 'string' || record.duplicatePolicy !== 'preserve-occurrences') return undefined;
  if (!conversionPreviewValidator(record.preview) || !Array.isArray(record.tree)) return undefined;
  if (typeof record.digest !== 'string') return undefined;
  // Clone before freezing: the caller's stored record must not be mutated,
  // and the returned conversion must not share state with storage.
  const body = { source: { profile, identity }, duplicatePolicy: 'preserve-occurrences' as const,
    preview: structuredClone(record.preview), tree: structuredClone(record.tree) };
  try { if (digestText(canonicalJson(body)) !== record.digest) return undefined; } catch { return undefined; }
  return deepFreeze({ ...body, digest: record.digest }) as ImportConversionResult;
}

function finalizeNode(node: PendingNode, sourceIdentity: string): NormalizedImportNode {
  const { path, children, omit: _omit, ...fields } = node;
  return { sourceNodeId: `source-${bytesToHex(sha256(utf8.encode(`${sourceIdentity}\u0000${path}`)))}`,
    ...fields, children: children.filter((child) => !child.omit).map((child) => finalizeNode(child, sourceIdentity)) };
}

function addUrlWarnings(node: PendingNode, path: string, state: PreviewState): void {
  if (!node.url) return;
  const scheme = node.url.slice(0, node.url.indexOf(':')).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') warn(state, 'unsupported_url_scheme',
    'URL scheme is preserved for authority but may require an explicit target mount policy.', path, false);
  const duplicateKey = `${node.title ?? ''}\u0000${node.url}`; const first = state.duplicates.get(duplicateKey);
  if (first) warn(state, 'duplicate_candidate', `Duplicate title and URL preserved as a distinct occurrence; first occurrence is ${first}.`, path, false);
  else state.duplicates.set(duplicateKey, path);
}

function timestampFields(attributes: ReadonlyMap<string, string>, path: string, state: PreviewState,
  kind: 'netscape-folder' | 'netscape-bookmark'): Partial<PendingNode> {
  const createdAt = secondsTimestamp(attributes.get('add_date'), path, state);
  const modified = secondsTimestamp(attributes.get('last_modified'), path, state);
  return { ...(createdAt ? { createdAt } : {}), ...(modified ? kind === 'netscape-folder'
    ? { childrenModifiedAt: modified } : { updatedAt: modified } : {}) };
}

function chromeTimestampFields(added: number | undefined, groupModified: number | undefined, lastUsed: number | undefined,
  path: string, state: PreviewState): Partial<PendingNode> {
  return { ...millisField('createdAt', added, path, state), ...millisField('childrenModifiedAt', groupModified, path, state),
    ...millisField('lastUsedAt', lastUsed, path, state) };
}

function millisField<Key extends 'createdAt' | 'childrenModifiedAt' | 'lastUsedAt'>(key: Key, value: number | undefined,
  path: string, state: PreviewState): Partial<Record<Key, string>> {
  if (value === undefined) return {}; const timestamp = dateTime(value);
  if (!timestamp) { warn(state, 'timestamp_invalid', 'Invalid browser timestamp was omitted.', path, true);
    state.lossy += 1; return {}; }
  return { [key]: timestamp } as Record<Key, string>;
}

function secondsTimestamp(value: string | undefined, path: string, state: PreviewState): string | undefined {
  if (value === undefined) return undefined; const seconds = Number(value);
  const timestamp = Number.isFinite(seconds) ? dateTime(seconds * 1000) : undefined;
  if (!timestamp) { warn(state, 'timestamp_invalid', 'Invalid bookmark timestamp was omitted.', path, true); state.lossy += 1; }
  return timestamp;
}

function dateTime(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) return undefined;
  try { return new Date(milliseconds).toISOString(); } catch { return undefined; }
}

function chromeRecord(value: unknown, limits: ImportLimits): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('chrome_tree_invalid');
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) fail('chrome_tree_invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) fail('chrome_tree_invalid');
  if (keys.length > limits.maxMembers) fail('member_limit');
  if ((keys as string[]).some((key) => !CHROME_KEYS.has(key))) fail('chrome_tree_invalid');
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]; if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('chrome_tree_invalid');
    output[key] = descriptor.value;
  }
  if (typeof output.id !== 'string' || output.id.length === 0 || typeof output.title !== 'string') fail('chrome_tree_invalid');
  return output;
}

function toCanonicalChrome(node: PendingNode): unknown {
  return { path: node.path, kind: node.kind, ...(node.title === undefined ? {} : { title: node.title }),
    ...(node.url === undefined ? {} : { url: node.url }), ...(node.folderRole === undefined ? {} : { folderRole: node.folderRole }),
    ...(node.readOnly === undefined ? {} : { readOnly: node.readOnly }), sourceRef: node.sourceRef,
    children: node.children.map(toCanonicalChrome) };
}

function requiredString(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) fail('chrome_tree_invalid'); return value;
}
function optionalString(value: unknown, empty = false): string | undefined {
  if (value === undefined) return undefined; return requiredString(value, empty);
}
function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined; if (!Number.isSafeInteger(value) || (value as number) < 0) fail('chrome_tree_invalid'); return value as number;
}
function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isFinite(value)) fail('chrome_tree_invalid'); return value;
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined; if (typeof value !== 'boolean') fail('chrome_tree_invalid'); return value;
}
function optionalEnum<Value extends string>(value: unknown, values: readonly Value[]): Value | undefined {
  if (value === undefined) return undefined; if (typeof value !== 'string' || !values.includes(value as Value)) fail('chrome_tree_invalid'); return value as Value;
}
function chromeFolderRole(value: NonNullable<ChromeImportBookmarkNode['folderType']>): NormalizedImportNode['folderRole'] {
  if (value === 'bookmarks-bar') return 'bookmarks-bar'; if (value === 'other') return 'other-bookmarks';
  if (value === 'mobile') return 'mobile-bookmarks'; return 'managed-bookmarks';
}

function normalizeLiveChromeNode(value: unknown, isRoot: boolean, parentId: string | undefined, index: number,
  seen: Set<string>, active: Set<object>): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('chrome_tree_invalid');
  if (active.has(value)) fail('chrome_tree_invalid');
  const record = value as Record<string, unknown>;
  const id = chromeNodeId(record.id);
  if (seen.has(id)) fail('chrome_tree_invalid');
  const title = typeof record.title === 'string' ? record.title
    : record.title === undefined || record.title === null ? '' : fail('chrome_tree_invalid');
  const type = record.type === 'bookmark' || record.type === 'folder' || record.type === 'separator'
    ? record.type : undefined;
  const rawUrl = typeof record.url === 'string' ? record.url : undefined;
  const isSeparator = type === 'separator';
  const isBookmark = type === 'bookmark' || (type !== 'folder' && !isSeparator && rawUrl !== undefined);
  const isFolder = !isBookmark && !isSeparator;
  const url = isBookmark ? rawUrl : undefined;
  const childArray = record.children === undefined ? undefined : asUnknownArray(record.children);
  if (isRoot && !isFolder) fail('chrome_tree_invalid');
  if (!isFolder && childArray !== undefined && childArray.length > 0) fail('chrome_tree_invalid');
  seen.add(id); active.add(value);
  const children = isFolder
    ? (childArray ?? []).map((child, childIndex) => normalizeLiveChromeNode(child, false, id, childIndex, seen, active))
    : undefined;
  active.delete(value);
  const node: Record<string, unknown> = { id, title };
  if (!isRoot) { node.parentId = parentId; node.index = index; }
  if (url !== undefined) node.url = url;
  if (children) node.children = children;
  if (isSeparator) node.type = 'separator';
  else if (type === 'folder' || type === 'bookmark') node.type = type;
  const folderType = record.folderType;
  if (folderType === 'bookmarks-bar' || folderType === 'other' || folderType === 'mobile' || folderType === 'managed') {
    node.folderType = folderType;
  }
  if (record.unmodifiable === 'managed' || record.unmodifiable === true) node.unmodifiable = 'managed';
  if (typeof record.syncing === 'boolean') node.syncing = record.syncing;
  if (typeof record.dateAdded === 'number' && Number.isFinite(record.dateAdded)) node.dateAdded = record.dateAdded;
  if (isFolder && typeof record.dateGroupModified === 'number' && Number.isFinite(record.dateGroupModified)) {
    node.dateGroupModified = record.dateGroupModified;
  }
  if (isBookmark && typeof record.dateLastUsed === 'number' && Number.isFinite(record.dateLastUsed)) {
    node.dateLastUsed = record.dateLastUsed;
  }
  return node;
}

function topLevelElements(root: HtmlNode, wanted: string): HtmlNode[] {
  const found: HtmlNode[] = [];
  function visit(node: HtmlNode, insideWanted: boolean): void {
    const matches = tag(node) === wanted; if (matches && !insideWanted) found.push(node);
    for (const child of childNodes(node)) visit(child, insideWanted || matches);
  }
  visit(root, false); return found;
}

function validateParsedHtml(root: HtmlNode, limits: ImportLimits): void {
  const stack: Array<{ node: HtmlNode; depth: number }> = [{ node: root, depth: -1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop(); if (!current) continue;
    const name = tag(current.node); const wrapper = name === 'html' || name === 'head' || name === 'body';
    const depth = name && !wrapper ? current.depth + 1 : current.depth;
    if (depth > limits.maxDepth) fail('depth_limit');
    if (current.node.nodeName !== '#document' && !wrapper) {
      nodes += 1; if (nodes > limits.maxNodes) fail('node_limit');
    }
    if (name) attrs(current.node, limits);
    const children = childNodes(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]; if (child) stack.push({ node: child, depth });
    }
  }
}

function scanUnsafeElements(root: HtmlNode, state: PreviewState): void {
  const visit = (node: HtmlNode, path: string): void => { const name = tag(node);
    if (name === 'script' || name === 'style') { warn(state, 'unsafe_element_ignored', `${name} element was ignored as inert data.`, path, true); state.lossy += 1; }
    childNodes(node).forEach((child, index) => visit(child, `${path}.${index}`));
  }; visit(root, 'document');
}

function findEntryElement(node: HtmlNode): HtmlNode | undefined {
  for (const child of elementChildren(node)) {
    if (['h3', 'a', 'hr'].includes(tag(child))) return child;
    if (tag(child) !== 'dl') { const nested = findEntryElement(child); if (nested) return nested; }
  }
  return undefined;
}

function firstDescendant(node: HtmlNode, wanted: string): HtmlNode | undefined {
  for (const child of elementChildren(node)) { if (tag(child) === wanted) return child;
    const nested = firstDescendant(child, wanted); if (nested) return nested; }
  return undefined;
}

/** The DD line that directly follows a bookmark's DT is its note (Firefox, Pinboard and Raindrop write it that way). */
function noteAfter(children: readonly HtmlNode[], start: number): string | undefined {
  const next = children[start + 1];
  return next && tag(next) === 'dd' ? textContent(next) : undefined;
}

function folderDescriptionAfter(children: readonly HtmlNode[], start: number): string | undefined {
  const next = children[start + 1];
  const text = (node: HtmlNode): string => tag(node) === 'dl' ? '' : node.nodeName === '#text' && typeof node.value === 'string'
    ? node.value : childNodes(node).map(text).join('');
  return next && tag(next) === 'dd' ? text(next) : undefined;
}

function nextList(children: readonly HtmlNode[], start: number, consumed: ReadonlySet<HtmlNode>): HtmlNode | undefined {
  for (let index = start + 1; index < children.length; index += 1) { const candidate = children[index]; if (!candidate) continue;
    if (tag(candidate) === 'dt') return undefined; if (tag(candidate) === 'dl' && !consumed.has(candidate)) return candidate;
    // Firefox writes a folder description as a DD between the H3 and its list, which the parser nests the list inside.
    if (tag(candidate) === 'dd') { const nested = firstDescendant(candidate, 'dl'); if (nested && !consumed.has(nested)) return nested; } }
  return undefined;
}

function unknownNetscapeAttributes(attributes: readonly HtmlAttribute[], known: ReadonlySet<string>): Record<string, string> | undefined {
  const unknown = attributes.filter((item) => !known.has(item.name)).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return unknown.length ? Object.fromEntries(unknown.map((item) => [item.name.toUpperCase(), item.value])) : undefined;
}

function preserveUnknownWarning(extension: Record<string, string> | undefined, path: string, state: PreviewState): void {
  if (extension) warn(state, 'unknown_extension_preserved_remote_only', 'Unknown Netscape attributes are preserved in the source extension namespace.', path, false);
}

function attrs(node: HtmlNode, limits: ImportLimits): HtmlAttribute[] {
  if (!Array.isArray(node.attrs)) return []; if (node.attrs.length > limits.maxMembers) fail('member_limit');
  return node.attrs.map((attribute) => {
    if (!attribute || typeof attribute !== 'object') fail('input_invalid'); const candidate = attribute as { name?: unknown; value?: unknown };
    if (typeof candidate.name !== 'string' || typeof candidate.value !== 'string') fail('input_invalid');
    return { name: candidate.name.toLowerCase(), value: candidate.value };
  });
}
function elementChildren(node: HtmlNode): HtmlNode[] { return childNodes(node).filter((child) => typeof child.tagName === 'string'); }
function childNodes(node: HtmlNode): HtmlNode[] { return Array.isArray(node.childNodes) ? node.childNodes as HtmlNode[] : []; }
function tag(node: HtmlNode): string { return typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''; }
function textContent(node: HtmlNode): string { return childNodes(node).map((child) => child.nodeName === '#text' && typeof child.value === 'string'
  ? child.value : textContent(child)).join(''); }

function createState(): PreviewState { return { nodes: 0, visitedNodes: 0, sidecarOnly: 0, lossy: 0, warnings: [], duplicates: new Map() }; }
function visitNode(state: PreviewState, limits: ImportLimits): void { state.visitedNodes += 1;
  if (state.visitedNodes > limits.maxNodes) fail('node_limit'); }
function addNode(state: PreviewState): void { state.nodes += 1; }
function warn(state: PreviewState, code: string, message: string, path: string, lossy: boolean): void {
  state.warnings.push({ code, message, path, lossy });
}

function sniffNetscapeSource(input: string): void {
  const trimmed = input.trimStart();
  if (trimmed.length === 0) fail('import_empty');
  const first = trimmed.charCodeAt(0);
  if (first === 123 || first === 91) fail('unsupported_format');
}

function resolveLimits(overrides: Partial<ImportLimits>): ImportLimits {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('input_invalid');
  return Object.freeze(limits);
}
function digestBytes(value: Uint8Array): string { return `sha256:${bytesToHex(sha256(value))}`; }
function digestText(value: string): string { return digestBytes(utf8.encode(value)); }
function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, () => fail('input_invalid'));
}
function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value);
  }
  return value;
}
function asUnknownArray(value: unknown, maxLength = DEFAULT_IMPORT_LIMITS.maxNodes): unknown[] {
  if (Array.isArray(value)) {
    if (value.length > maxLength) fail('node_limit');
    return value;
  }
  if (value && typeof value === 'object' && typeof (value as { readonly length?: unknown }).length === 'number') {
    const length = (value as { readonly length: number }).length;
    if (!Number.isSafeInteger(length) || length < 0) fail('chrome_tree_invalid');
    if (length > maxLength) fail('node_limit');
    try { return Array.from(value as ArrayLike<unknown>); } catch { fail('chrome_tree_invalid'); }
  }
  fail('chrome_tree_invalid');
}
function chromeNodeId(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return fail('chrome_tree_invalid');
}
function fail(code: ImportErrorCode): never { throw new ImportPreviewError(code); }
