/**
 * SPECIFICATION §12 version negotiation for Publication reads.
 *
 * A read request asserts a protocol version through the exact
 * `Collection-Protocol-Version` header value and/or a `version` parameter on
 * a Collection Protocol media range in `Accept`. When an asserted version is
 * not supported the server answers `406 unsupported_version` listing
 * `supportedVersions`. Requests that assert no version are admitted, and
 * `Accept` ranges that are not Collection Protocol JSON (for example
 * `text/html`) are left to the host. Collection Protocol ranges whose
 * assertion cannot be read (malformed, or past the bounded examination
 * budget) fail closed with the same 406 rather than passing as supported.
 */

import { isProxy } from 'node:util/types';

export const DEFAULT_PUBLICATION_SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['0.1']);

const MAX_SUPPORTED_VERSIONS = 16;

/**
 * Bounds the per-request work on a hostile `Accept` header. The header is
 * examined only up to these budgets. Because §12 lets a client assert its
 * version through `Accept` alone, an unexamined remainder could hide an
 * unsupported assertion, so a header that exceeds a budget is admitted only
 * when an acceptable Collection Protocol range was already seen inside it;
 * otherwise it fails closed with `406 unsupported_version`.
 */
export const MAX_ACCEPT_LENGTH = 8_192;
export const MAX_ACCEPT_RANGES = 64;

const PROTOCOL_VERSION_TOKEN = /^[0-9]+(?:\.[0-9]+)*$/u;
const COLLECTION_PROTOCOL_VENDOR_TYPE = /^application\/vnd\.collection-protocol\.[a-z][a-z0-9-]*\+json$/u;
const MEDIA_PARAMETER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const QUALITY_VALUE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u;

export interface PublicationVersionNegotiationInput {
  /** Raw `Collection-Protocol-Version` request header, or null/undefined when absent. */
  readonly protocolVersionHeader?: string | null | undefined;
  /** Raw `Accept` request header, or null/undefined when absent. */
  readonly accept?: string | null | undefined;
  /** Versions the host implements for this read; defaults to `['0.1']`. */
  readonly supportedVersions?: readonly string[] | undefined;
}

export type PublicationVersionNegotiationResult =
  | { readonly supported: true; readonly supportedVersions: readonly string[] }
  | { readonly supported: false; readonly supportedVersions: readonly string[] };

/**
 * Validates the host's declared versions once so misconfiguration fails at
 * composition time rather than as a per-request 500.
 */
export function normalizePublicationSupportedVersions(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_PUBLICATION_SUPPORTED_VERSIONS;
  // Read own data elements by descriptor: no Proxy traps, accessors, or
  // custom iterators run, matching the other composition-boundary guards.
  if (!Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Publication supportedVersions must be a non-Proxy array of version strings.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > MAX_SUPPORTED_VERSIONS) {
    throw new TypeError(`Publication supportedVersions must list between 1 and ${MAX_SUPPORTED_VERSIONS} versions.`);
  }
  const copy: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Publication supportedVersions[${index}] must be a data element.`);
    }
    const version: unknown = descriptor.value;
    if (typeof version !== 'string' || !PROTOCOL_VERSION_TOKEN.test(version)) {
      throw new TypeError('Publication supportedVersions entries must be dotted numeric versions such as "0.1".');
    }
    if (seen.has(version)) throw new TypeError('Publication supportedVersions must not repeat a version.');
    seen.add(version);
    copy.push(version);
  }
  return Object.freeze(copy);
}

/**
 * Decides whether a read request's asserted protocol version is supported.
 *
 * - The header is compared as one exact, trimmed token. A header that lists
 *   several versions or anything else is not a supported version.
 * - In `Accept`, only Collection Protocol vendor ranges (and their generic
 *   fall-backs `application/json`, `application/*`, `* / *`) take part;
 *   ranges of any other type are left to the host whatever their parameters.
 *   Ranges with `q=0` are excluded. The request is admitted when some
 *   participating range accepts a supported version (or names none). It is
 *   rejected when a participating range asks for an unsupported `version`,
 *   when a participating range is malformed (bad quoting, invalid `q`,
 *   repeated parameter), when quoting is unbalanced, or when the header
 *   exceeds the length or range budget, and no acceptable participating
 *   range was seen. Fail-closed: a version assertion that cannot be read is
 *   never treated as a supported one.
 */
export function negotiatePublicationVersion(
  input: PublicationVersionNegotiationInput,
): PublicationVersionNegotiationResult {
  const supportedVersions = normalizePublicationSupportedVersions(input.supportedVersions);
  const supported = new Set(supportedVersions);

  const header = input.protocolVersionHeader;
  if (typeof header === 'string') {
    const asserted = header.trim();
    if (asserted !== '' && !supported.has(asserted)) {
      return { supported: false, supportedVersions };
    }
  }

  const accept = input.accept;
  if (typeof accept === 'string' && accept.trim() !== '') {
    if (!acceptAdmits(accept, supported)) return { supported: false, supportedVersions };
  }
  return { supported: true, supportedVersions };
}

function acceptAdmits(accept: string, supported: ReadonlySet<string>): boolean {
  // Only the budgeted prefix is ever scanned; anything past it is unexamined.
  const truncated = accept.length > MAX_ACCEPT_LENGTH;
  const examined = truncated ? accept.slice(0, MAX_ACCEPT_LENGTH) : accept;
  const ranges = splitHeaderList(examined, ',');
  if (ranges === null) return false; // unbalanced quoting: unreadable assertion
  const overBudget = truncated || ranges.length > MAX_ACCEPT_RANGES;
  // A sliced prefix may end inside a range; that fragment is indeterminate.
  const determinate = truncated ? ranges.slice(0, -1) : ranges;
  let acceptableRange = false;
  let rejecting = overBudget;
  for (const range of determinate.slice(0, MAX_ACCEPT_RANGES)) {
    const parsed = parseRange(range);
    if (!parsed.participates) continue;
    if (parsed.malformed) {
      rejecting = true;
    } else if (parsed.quality === 0) {
      continue;
    } else if (parsed.version === undefined || supported.has(parsed.version)) {
      acceptableRange = true;
    } else {
      rejecting = true;
    }
  }
  return acceptableRange || !rejecting;
}

type ParsedRange =
  | { readonly participates: false }
  | { readonly participates: true; readonly malformed: true }
  | { readonly participates: true; readonly malformed: false; readonly quality: number; readonly version?: string };

function parseRange(range: string): ParsedRange {
  const segments = splitHeaderList(range, ';');
  if (segments === null || segments.length === 0) return { participates: false };
  const type = segments[0]!.trim().toLowerCase();
  const participates = type === '*/*'
    || type === 'application/*'
    || type === 'application/json'
    || COLLECTION_PROTOCOL_VENDOR_TYPE.test(type);
  if (!participates) return { participates: false };
  let quality = 1;
  let version: string | undefined;
  const seen = new Set<string>();
  for (const rawParameter of segments.slice(1)) {
    const parameter = parseMediaParameter(rawParameter);
    if (parameter === null || seen.has(parameter.name)) return { participates: true, malformed: true };
    seen.add(parameter.name);
    if (parameter.name === 'q') {
      if (parameter.quoted || !QUALITY_VALUE.test(parameter.value)) return { participates: true, malformed: true };
      quality = Number(parameter.value);
    } else if (parameter.name === 'version') {
      version = parameter.value;
    }
  }
  return version === undefined
    ? { participates: true, malformed: false, quality }
    : { participates: true, malformed: false, quality, version };
}

function parseMediaParameter(raw: string): { readonly name: string; readonly value: string; readonly quoted: boolean } | null {
  const separator = raw.indexOf('=');
  if (separator <= 0) return null;
  const name = raw.slice(0, separator).trim().toLowerCase();
  let value = raw.slice(separator + 1).trim();
  if (!MEDIA_PARAMETER_TOKEN.test(name)) return null;
  let quoted = false;
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) return null;
    quoted = true;
    value = unescapeQuotedString(value.slice(1, -1));
  } else if (!MEDIA_PARAMETER_TOKEN.test(value)) {
    return null;
  }
  return { name, value, quoted };
}

function unescapeQuotedString(inner: string): string {
  let result = '';
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]!;
    if (character === '\\' && index + 1 < inner.length) {
      result += inner[index + 1];
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

/** Splits on `separator` outside quoted strings; null when quoting is unbalanced. */
function splitHeaderList(value: string, separator: ',' | ';'): string[] | null {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === '\\' && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === separator && !quoted) {
      const part = value.slice(start, index).trim();
      if (part !== '') result.push(part);
      start = index + 1;
    }
  }
  if (quoted) return null;
  const last = value.slice(start).trim();
  if (last !== '') result.push(last);
  return result;
}
