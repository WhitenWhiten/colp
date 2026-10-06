const MAX_IF_NONE_MATCH_LENGTH = 16 * 1024;
const CONTROL_OR_OBS_FOLD_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]/u;
/** Strong opaque-tag: DQUOTE *etagc DQUOTE (RFC 9110 §8.8.3). */
const STRONG_ENTITY_TAG_PATTERN = /^"[\x21\x23-\x7E\x80-\u00FF]*"$/u;
const INPUT_KEYS = new Set(['ifNoneMatch', 'etag']);

export interface EvaluatePublicationConditionalGetInput {
  /**
   * Raw `If-None-Match` field value from the request. Accepts a single strong
   * or weak entity-tag, a comma-separated list, or `*`. `null` / `undefined` /
   * empty means the precondition is absent.
   */
  readonly ifNoneMatch?: string | null | undefined;
  /** Current selected representation's strong quoted ETag. */
  readonly etag: string;
}

export interface EvaluatePublicationConditionalGetResult {
  /** `304` when the precondition matches; otherwise `200` (serve the body). */
  readonly status: 200 | 304;
}

/**
 * Evaluates a Publication GET/HEAD `If-None-Match` precondition against the
 * current representation ETag.
 *
 * Intended for adapter-side conditional GET before body materialization:
 * return `304 Not Modified` when the client already holds the selected
 * representation, otherwise `200` so the full response can be built.
 *
 * Comparison is weak as required by RFC 9110 §13.1.2: validator strength is
 * ignored and matching is based on the opaque-tag. Publication still emits a
 * strong current ETag, so either `"tag"` or `W/"tag"` in the request matches
 * that selected representation. Supports:
 * - a single entity-tag
 * - a multi-tag list (`1#entity-tag`)
 * - the `*` wildcard (matches when a current ETag is present, per RFC 9110)
 *
 * Malformed client validators fail open to `200` so content is still served
 * rather than incorrectly suppressed. Invalid server-supplied `etag` values
 * throw (programming error).
 */
export function evaluatePublicationConditionalGet(
  input: EvaluatePublicationConditionalGetInput,
): EvaluatePublicationConditionalGetResult {
  assertInput(input);
  const current = normalizeStrongEtag(input.etag, 'etag');
  const raw = input.ifNoneMatch;

  if (raw === null || raw === undefined) {
    return status200();
  }
  if (typeof raw !== 'string') {
    return status200();
  }
  if (raw.length === 0 || raw.length > MAX_IF_NONE_MATCH_LENGTH) {
    return status200();
  }
  if (CONTROL_OR_OBS_FOLD_PATTERN.test(raw)) {
    return status200();
  }

  const trimmed = trimOws(raw);
  if (trimmed.length === 0) {
    return status200();
  }

  // RFC 9110: If-None-Match = "*" / 1#entity-tag
  if (trimmed === '*') {
    // Any current representation exists (we validated a strong etag above).
    return status304();
  }

  const candidates = parseEntityTagList(trimmed);
  if (candidates === null) {
    return status200();
  }

  for (const candidate of candidates) {
    if (weakMatch(current, candidate)) {
      return status304();
    }
  }
  return status200();
}

function assertInput(input: EvaluatePublicationConditionalGetInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Publication conditional GET input must be an object.');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Publication conditional GET input must be a plain object.');
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) {
      throw new TypeError(`Publication conditional GET input contains unsupported field ${key}.`);
    }
  }
}

/**
 * Server-controlled current ETag must be a strong quoted entity-tag.
 * Weak tags and lists are rejected as programming errors.
 */
function normalizeStrongEtag(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty strong quoted entity-tag.`);
  }
  if (value.length > MAX_IF_NONE_MATCH_LENGTH) {
    throw new RangeError(`${name} must not exceed ${MAX_IF_NONE_MATCH_LENGTH} characters.`);
  }
  if (CONTROL_OR_OBS_FOLD_PATTERN.test(value)) {
    throw new TypeError(`${name} must not contain control characters.`);
  }
  if (value.startsWith('W/') || !STRONG_ENTITY_TAG_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a single strong quoted entity-tag.`);
  }
  return value;
}

/**
 * Parse `1#entity-tag` with OWS around commas.
 *
 * RFC 9110 §5.6.1 requires recipients to parse and ignore a reasonable number
 * of empty HTTP list members. The overall field-size limit above bounds that
 * tolerance, while a value containing no entity-tags remains invalid.
 * Returns null when the list yields no tags or any non-empty member is malformed
 * (including a bare `*` mixed into a list).
 */
function parseEntityTagList(value: string): readonly EntityTag[] | null {
  const tags: EntityTag[] = [];
  let index = 0;

  while (index < value.length) {
    index = skipOws(value, index);
    // HTTP list recipients ignore empty members, including leading, repeated,
    // and trailing commas (RFC 9110 §5.6.1).
    while (value[index] === ',') {
      index += 1;
      index = skipOws(value, index);
    }
    if (index >= value.length) break;

    const parsed = parseEntityTagAt(value, index);
    if (parsed === null) return null;
    tags.push(parsed.tag);
    index = skipOws(value, parsed.nextIndex);

    if (index >= value.length) break;
    if (value[index] !== ',') return null;
    index += 1;
  }

  return tags.length === 0 ? null : tags;
}

interface EntityTag {
  /** Full quoted opaque-tag including surrounding DQUOTE characters. */
  readonly opaqueTag: string;
}

function parseEntityTagAt(
  value: string,
  start: number,
): { readonly tag: EntityTag; readonly nextIndex: number } | null {
  let index = start;

  if (value.startsWith('W/', index)) {
    index += 2;
  }

  if (value[index] !== '"') return null;
  const close = value.indexOf('"', index + 1);
  if (close < 0) return null;

  const opaqueTag = value.slice(index, close + 1);
  if (!STRONG_ENTITY_TAG_PATTERN.test(opaqueTag)) return null;

  return {
    tag: { opaqueTag },
    nextIndex: close + 1,
  };
}

/**
 * Weak comparison (RFC 9110 §8.8.3.2): validator strength is ignored and the
 * two opaque-tags match character-for-character.
 */
function weakMatch(currentStrongOpaqueTag: string, candidate: EntityTag): boolean {
  return candidate.opaqueTag === currentStrongOpaqueTag;
}

function skipOws(value: string, index: number): number {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09) break;
    index += 1;
  }
  return index;
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, '');
}

function status200(): EvaluatePublicationConditionalGetResult {
  return Object.freeze({ status: 200 as const });
}

function status304(): EvaluatePublicationConditionalGetResult {
  return Object.freeze({ status: 304 as const });
}
