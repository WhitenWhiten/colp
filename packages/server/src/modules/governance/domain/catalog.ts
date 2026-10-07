export class GovernanceCatalogError extends Error {
  readonly code: 'invalid_request' | 'invalid_query';
  readonly path?: string;

  constructor(code: 'invalid_request' | 'invalid_query', message: string, path?: string) {
    super(message);
    this.name = 'GovernanceCatalogError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export interface CatalogFields {
  readonly tags: readonly string[];
  readonly language: string | null;
}

export interface CatalogPatch {
  readonly tags?: readonly string[];
  readonly language?: string | null;
}

export interface CatalogPreferencesPatch {
  readonly hiddenOwnerAccountIds?: readonly string[];
  readonly hiddenTags?: readonly string[];
  readonly hiddenTitleKeywords?: readonly string[];
  readonly preferredLanguages?: readonly string[];
}

export interface CatalogPreferencesView {
  readonly hiddenOwnerAccountIds: readonly string[];
  readonly hiddenTags: readonly string[];
  readonly hiddenTitleKeywords: readonly string[];
  readonly preferredLanguages: readonly string[];
  readonly revision: string;
  readonly updatedAt: string;
}

export interface CatalogDisplayTarget {
  readonly ownerAccountId: string;
  readonly tags: readonly string[];
  readonly title: string;
  readonly language: string | null;
}

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const TAG_MAX_ITEMS = 64;
const TAG_MAX_LENGTH = 64;
const PREF_TAG_MAX_ITEMS = 100;
const KEYWORD_MAX_ITEMS = 100;
const KEYWORD_MAX_LENGTH = 100;
const LANGUAGE_MAX_ITEMS = 20;
const LANGUAGE_MAX_LENGTH = 35;
const OWNER_MAX_ITEMS = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizeUserText(value: string): string {
  return value.trim().normalize('NFC');
}

export function canonicalizeBcp47(value: string, code: 'invalid_request' | 'invalid_query'): string {
  if (typeof value !== 'string') {
    throw new GovernanceCatalogError(code, 'language must be a string');
  }
  const trimmed = normalizeUserText(value);
  if (trimmed.length < 1 || codePointLength(trimmed) > LANGUAGE_MAX_LENGTH) {
    throw new GovernanceCatalogError(code, 'language is invalid');
  }
  let canonical: string;
  try {
    const [tag] = Intl.getCanonicalLocales(trimmed);
    if (typeof tag !== 'string') throw new RangeError('language is invalid');
    canonical = tag;
  } catch {
    throw new GovernanceCatalogError(code, 'language is not a valid BCP47 tag');
  }
  if (codePointLength(canonical) > LANGUAGE_MAX_LENGTH) {
    throw new GovernanceCatalogError(code, 'language is invalid');
  }
  return canonical;
}

function parseTags(value: unknown, maxItems: number, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GovernanceCatalogError('invalid_request', `${path} must be an array`, path);
  }
  if (value.length > maxItems) {
    throw new GovernanceCatalogError('invalid_request', `${path} has too many items`, path);
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new GovernanceCatalogError('invalid_request', `${path}[${index}] must be a string`, `${path}/${index}`);
    }
    const tag = normalizeUserText(item);
    if (tag.length < 1 || codePointLength(tag) > TAG_MAX_LENGTH) {
      throw new GovernanceCatalogError('invalid_request', `${path}[${index}] is invalid`, `${path}/${index}`);
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return Object.freeze(tags);
}

function parseOpaqueIds(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GovernanceCatalogError('invalid_request', `${path} must be an array`, path);
  }
  if (value.length > OWNER_MAX_ITEMS) {
    throw new GovernanceCatalogError('invalid_request', `${path} has too many items`, path);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !OPAQUE_ID.test(item)) {
      throw new GovernanceCatalogError('invalid_request', `${path}[${index}] is invalid`, `${path}/${index}`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return Object.freeze(ids);
}

function parseKeywords(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GovernanceCatalogError('invalid_request', `${path} must be an array`, path);
  }
  if (value.length > KEYWORD_MAX_ITEMS) {
    throw new GovernanceCatalogError('invalid_request', `${path} has too many items`, path);
  }
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new GovernanceCatalogError('invalid_request', `${path}[${index}] must be a string`, `${path}/${index}`);
    }
    const keyword = normalizeUserText(item).toLowerCase();
    if (keyword.length < 1 || codePointLength(keyword) > KEYWORD_MAX_LENGTH) {
      throw new GovernanceCatalogError('invalid_request', `${path}[${index}] is invalid`, `${path}/${index}`);
    }
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return Object.freeze(keywords);
}

function parseLanguages(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GovernanceCatalogError('invalid_request', `${path} must be an array`, path);
  }
  if (value.length > LANGUAGE_MAX_ITEMS) {
    throw new GovernanceCatalogError('invalid_request', `${path} has too many items`, path);
  }
  const seen = new Set<string>();
  const languages: string[] = [];
  for (const [index, item] of value.entries()) {
    const language = canonicalizeBcp47(item as string, 'invalid_request');
    if (seen.has(language)) continue;
    seen.add(language);
    languages.push(language);
  }
  return Object.freeze(languages);
}

export function parseCatalogPatch(body: unknown): CatalogPatch {
  if (!isPlainObject(body)) {
    throw new GovernanceCatalogError('invalid_request', 'Catalog patch must be a JSON object');
  }
  const allowed = new Set(['tags', 'language']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new GovernanceCatalogError('invalid_request', `Property "${key}" is not allowed`, `/${key}`);
    }
  }
  const hasTags = Object.hasOwn(body, 'tags');
  const hasLanguage = Object.hasOwn(body, 'language');
  if (!hasTags && !hasLanguage) {
    throw new GovernanceCatalogError('invalid_request', 'Catalog patch must include at least one field');
  }
  const patch: { tags?: readonly string[]; language?: string | null } = {};
  if (hasTags) {
    if (body.tags === null) {
      throw new GovernanceCatalogError('invalid_request', 'tags cannot be null', '/tags');
    }
    patch.tags = parseTags(body.tags, TAG_MAX_ITEMS, '/tags');
  }
  if (hasLanguage) {
    patch.language = body.language === null ? null : canonicalizeBcp47(body.language as string, 'invalid_request');
  }
  return Object.freeze(patch);
}

export function parseCatalogPreferencesPatch(body: unknown): CatalogPreferencesPatch {
  if (!isPlainObject(body)) {
    throw new GovernanceCatalogError('invalid_request', 'Preferences patch must be a JSON object');
  }
  const allowed = new Set([
    'hiddenOwnerAccountIds', 'hiddenTags', 'hiddenTitleKeywords', 'preferredLanguages',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new GovernanceCatalogError('invalid_request', `Property "${key}" is not allowed`, `/${key}`);
    }
  }
  const patch: {
    hiddenOwnerAccountIds?: readonly string[];
    hiddenTags?: readonly string[];
    hiddenTitleKeywords?: readonly string[];
    preferredLanguages?: readonly string[];
  } = {};
  if (Object.hasOwn(body, 'hiddenOwnerAccountIds')) {
    if (body.hiddenOwnerAccountIds === null) {
      throw new GovernanceCatalogError('invalid_request', 'hiddenOwnerAccountIds cannot be null');
    }
    patch.hiddenOwnerAccountIds = parseOpaqueIds(body.hiddenOwnerAccountIds, '/hiddenOwnerAccountIds');
  }
  if (Object.hasOwn(body, 'hiddenTags')) {
    if (body.hiddenTags === null) {
      throw new GovernanceCatalogError('invalid_request', 'hiddenTags cannot be null');
    }
    patch.hiddenTags = parseTags(body.hiddenTags, PREF_TAG_MAX_ITEMS, '/hiddenTags');
  }
  if (Object.hasOwn(body, 'hiddenTitleKeywords')) {
    if (body.hiddenTitleKeywords === null) {
      throw new GovernanceCatalogError('invalid_request', 'hiddenTitleKeywords cannot be null');
    }
    patch.hiddenTitleKeywords = parseKeywords(body.hiddenTitleKeywords, '/hiddenTitleKeywords');
  }
  if (Object.hasOwn(body, 'preferredLanguages')) {
    if (body.preferredLanguages === null) {
      throw new GovernanceCatalogError('invalid_request', 'preferredLanguages cannot be null');
    }
    patch.preferredLanguages = parseLanguages(body.preferredLanguages, '/preferredLanguages');
  }
  if (Object.keys(patch).length === 0) {
    throw new GovernanceCatalogError('invalid_request', 'Preferences patch must include at least one field');
  }
  return Object.freeze(patch);
}

export function readCatalogFromExtensions(extensions: unknown): CatalogFields {
  const record = isPlainObject(extensions) ? extensions : {};
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((item): item is string => typeof item === 'string')
    : [];
  const language = typeof record.language === 'string' && record.language.length > 0
    ? record.language
    : null;
  return Object.freeze({ tags: Object.freeze([...tags]), language });
}

export function mergeCatalogExtensions(
  current: Readonly<Record<string, unknown>> | null | undefined,
  patch: CatalogPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(isPlainObject(current) ? current : {}) };
  if (patch.tags !== undefined) next.tags = [...patch.tags];
  if (patch.language !== undefined) {
    if (patch.language === null) delete next.language;
    else next.language = patch.language;
  }
  return next;
}

export function parseLanguageQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new GovernanceCatalogError('invalid_query', 'language is invalid');
  }
  return canonicalizeBcp47(raw, 'invalid_query');
}

export function isHiddenByCatalogPreferences(
  target: CatalogDisplayTarget,
  prefs: Pick<
    CatalogPreferencesView,
    'hiddenOwnerAccountIds' | 'hiddenTags' | 'hiddenTitleKeywords' | 'preferredLanguages'
  >,
): boolean {
  if (prefs.hiddenOwnerAccountIds.includes(target.ownerAccountId)) return true;
  if (prefs.hiddenTags.some((tag) => target.tags.includes(tag))) return true;
  if (prefs.hiddenTitleKeywords.length > 0) {
    const haystack = target.title.normalize('NFC').toLowerCase();
    if (prefs.hiddenTitleKeywords.some((keyword) => haystack.includes(keyword))) return true;
  }
  if (prefs.preferredLanguages.length > 0) {
    if (target.language === null || !prefs.preferredLanguages.includes(target.language)) return true;
  }
  return false;
}

export function emptyCatalogPreferences(
  revision: string,
  updatedAt: string,
): CatalogPreferencesView {
  return Object.freeze({
    hiddenOwnerAccountIds: Object.freeze([]),
    hiddenTags: Object.freeze([]),
    hiddenTitleKeywords: Object.freeze([]),
    preferredLanguages: Object.freeze([]),
    revision,
    updatedAt,
  });
}

export function applyCatalogPreferencesPatch(
  current: CatalogPreferencesView,
  patch: CatalogPreferencesPatch,
  revision: string,
  updatedAt: string,
): CatalogPreferencesView {
  return Object.freeze({
    hiddenOwnerAccountIds: Object.freeze([
      ...(patch.hiddenOwnerAccountIds ?? current.hiddenOwnerAccountIds),
    ]),
    hiddenTags: Object.freeze([...(patch.hiddenTags ?? current.hiddenTags)]),
    hiddenTitleKeywords: Object.freeze([
      ...(patch.hiddenTitleKeywords ?? current.hiddenTitleKeywords),
    ]),
    preferredLanguages: Object.freeze([
      ...(patch.preferredLanguages ?? current.preferredLanguages),
    ]),
    revision,
    updatedAt,
  });
}

export function governanceTimestamp(value: Date): string {
  return value.toISOString();
}
