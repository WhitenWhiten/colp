import { mergePublicationVary } from './publication-vary.js';

const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const INVALID_HEADER_VALUE_CHARACTER_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u;
const MAX_HEADER_VALUE_LENGTH = 16 * 1024;
const POLICY_INPUT_KEYS = new Set(['kind', 'existingCacheControl', 'existingVary']);

export type PublicationCacheHeaderValue = string | readonly string[];
export type PublicationCacheControlHeaderValue = PublicationCacheHeaderValue;
export type PublicationVaryHeaderValue = PublicationCacheHeaderValue;

interface PublicationCachePolicyBase {
  readonly existingCacheControl?: PublicationCacheControlHeaderValue | undefined;
  readonly existingVary?: PublicationVaryHeaderValue | undefined;
}

export interface AuthorizationVaryingPublicationCachePolicyInput extends PublicationCachePolicyBase {
  readonly kind: 'authorization-varying';
}

export interface AnonymousPublicPublicationCachePolicyInput extends PublicationCachePolicyBase {
  readonly kind: 'anonymous-public';
}

export type PublicationCachePolicyInput =
  | AuthorizationVaryingPublicationCachePolicyInput
  | AnonymousPublicPublicationCachePolicyInput;

export type PublicationCachePolicyHeaders = Readonly<{
  readonly 'Cache-Control'?: string;
  readonly Vary?: string;
}>;

/**
 * Selects response cache headers after the adapter has made its authorization decision.
 *
 * Authorization-varying representations always replace Cache-Control with the
 * mandatory private policy. Anonymous public representations retain a validated
 * caller policy and therefore remain the only branch capable of shared caching.
 */
export function createPublicationCachePolicy(
  input: PublicationCachePolicyInput,
): PublicationCachePolicyHeaders {
  assertPolicyInput(input);
  const cacheControl = normalizeCacheControl(input.existingCacheControl);
  const vary = mergePublicationVary(
    input.existingVary,
    input.kind === 'authorization-varying' ? ['Authorization'] : [],
  );

  if (input.kind === 'authorization-varying') {
    return Object.freeze({
      'Cache-Control': 'private, no-store',
      Vary: vary ?? 'Authorization',
    });
  }

  const headers: { 'Cache-Control'?: string; Vary?: string } = {};
  if (cacheControl !== undefined) headers['Cache-Control'] = cacheControl;
  if (vary !== undefined) headers.Vary = vary;
  return Object.freeze(headers);
}

function assertPolicyInput(input: PublicationCachePolicyInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Publication cache policy input must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!POLICY_INPUT_KEYS.has(key)) {
      throw new TypeError(`Publication cache policy input contains unsupported field ${key}.`);
    }
  }
  if (input.kind !== 'authorization-varying' && input.kind !== 'anonymous-public') {
    throw new TypeError('Publication cache policy kind must be authorization-varying or anonymous-public.');
  }
}

function normalizeCacheControl(value: PublicationCacheControlHeaderValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const fields = normalizeRepeatedHeader(value, 'Cache-Control');
  const directives = splitCacheDirectives(fields.join(','));
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawDirective of directives) {
    const directive = trimOws(rawDirective);
    if (directive.length === 0) throw new TypeError('Cache-Control must not contain empty directives.');
    const equals = directive.indexOf('=');
    const name = trimOws(equals < 0 ? directive : directive.slice(0, equals));
    if (!HEADER_TOKEN_PATTERN.test(name)) throw new TypeError('Cache-Control contains an invalid directive name.');
    const identity = name.toLowerCase();
    if (seen.has(identity)) throw new TypeError(`Cache-Control contains duplicate ${name} directives.`);
    seen.add(identity);

    if (equals < 0) {
      normalized.push(name);
      continue;
    }
    const parameter = trimOws(directive.slice(equals + 1));
    if (!HEADER_TOKEN_PATTERN.test(parameter) && !isQuotedString(parameter)) {
      throw new TypeError(`Cache-Control directive ${name} has an invalid value.`);
    }
    normalized.push(`${name}=${parameter}`);
  }
  if (seen.has('public') && seen.has('private')) {
    throw new TypeError('Cache-Control cannot combine public and private directives.');
  }
  return normalized.join(', ');
}

function normalizeRepeatedHeader(value: PublicationCacheHeaderValue, name: string): readonly string[] {
  const fields = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new TypeError(`${name} must be a string or a non-empty array of strings.`);
  }
  let combinedLength = 0;
  for (const field of fields) {
    if (
      typeof field !== 'string'
      || field.length === 0
      || field.length > MAX_HEADER_VALUE_LENGTH
      || INVALID_HEADER_VALUE_CHARACTER_PATTERN.test(field)
    ) {
      throw new TypeError(`${name} contains an invalid HTTP header field value.`);
    }
    combinedLength += field.length;
    if (combinedLength > MAX_HEADER_VALUE_LENGTH) {
      throw new RangeError(`${name} must not exceed ${MAX_HEADER_VALUE_LENGTH} characters across repeated fields.`);
    }
  }
  return fields;
}

function splitCacheDirectives(value: string): readonly string[] {
  const directives: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      directives.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new TypeError('Cache-Control contains an unterminated quoted string.');
  directives.push(value.slice(start));
  return directives;
}

function isQuotedString(value: string): boolean {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length - 1) return false;
      const escaped = value.charCodeAt(index);
      if (escaped !== 0x09 && (escaped < 0x20 || escaped > 0x7e)) return false;
    } else if (code !== 0x09 && code !== 0x20 && (code < 0x21 || code > 0x7e || code === 0x22)) {
      return false;
    }
  }
  return true;
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, '');
}
