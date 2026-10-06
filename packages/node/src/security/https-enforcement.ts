import {
  assertPlainRecord,
  exactOwnStringKeys,
  readOwnDataProperty,
} from './input-snapshot.js';

/** The endpoint location supplied by the adapter. */
export type HttpsEndpointLocation = 'remote' | 'local';
export type HttpsEndpointApplicability = 'applicable' | 'not_applicable';

/**
 * Transport evidence is deliberately a small adapter boundary.  The adapter
 * is responsible for obtaining this value from the actual transport; this
 * guard does not perform TLS termination or routing.
 */
export interface HttpsEndpointTransport {
  readonly scheme: string;
}

export interface HttpsEndpointInput {
  /** Whether this endpoint is remote; adapters must provide this discriminator. */
  readonly remote: boolean;
  readonly applicability: HttpsEndpointApplicability;
  readonly requestTarget?: string;
  readonly transport?: HttpsEndpointTransport;
}

export type HttpsEndpointDenialReason =
  | 'invalid_input'
  | 'applicability_mismatch'
  | 'https_required'
  | 'invalid_target'
  | 'transport_evidence_invalid';

export type HttpsEndpointDecision =
  | {
      readonly allowed: true;
      readonly disposition: 'enforced';
      readonly location: 'remote';
      readonly reason: 'https_endpoint';
    }
  | {
      readonly allowed: true;
      readonly disposition: 'not_applicable';
      readonly location: 'local';
      readonly reason: 'not_applicable';
    }
  | {
      readonly allowed: false;
      readonly reason: HttpsEndpointDenialReason;
    };

const notApplicableDecision = Object.freeze({
  allowed: true,
  disposition: 'not_applicable',
  location: 'local',
  reason: 'not_applicable',
} as const);
const enforcedDecision = Object.freeze({
  allowed: true,
  disposition: 'enforced',
  location: 'remote',
  reason: 'https_endpoint',
} as const);
const denialDecisions = Object.freeze(
  Object.fromEntries(
    [
      'invalid_input',
      'applicability_mismatch',
      'https_required',
      'invalid_target',
      'transport_evidence_invalid',
    ].map((reason) => [reason, Object.freeze({ allowed: false, reason })]),
  ) as Record<HttpsEndpointDenialReason, HttpsEndpointDecision>,
);

const controls = /[\u0000-\u001f\u007f]/u;
const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const percentEscape = /%(?![0-9A-Fa-f]{2})/u;
const percentEncodedByte = /%[0-9A-Fa-f]{2}/u;
// Absolute-form hosts are lowercase DNS labels, or bracketed IPv6 literals
// (hex may be mixed case). Aligns with origin-guard's authority shape while
// preserving the stricter lowercase DNS rule used by HTTPS enforcement.
const absoluteAuthorityPattern =
  /^(?<host>\[[0-9A-Fa-f:.]+\]|[a-z0-9.-]+)(?::(?<port>[0-9]{1,5}))?$/u;
const MAX_REQUEST_TARGET_LENGTH = 4_096;

function denied(reason: HttpsEndpointDenialReason): HttpsEndpointDecision {
  return denialDecisions[reason];
}

function hasSafeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_TARGET_LENGTH &&
    !controls.test(value) &&
    !unpairedSurrogate.test(value)
  );
}

function validatePercentAndDecodedCharacters(target: string): boolean {
  // Keep request targets in their literal canonical spelling. Besides
  // separators, rejecting all encoded bytes avoids alternate path spellings
  // that URL normalization could otherwise treat as equivalent.
  if (percentEscape.test(target) || percentEncodedByte.test(target)) return false;
  try {
    const decoded = decodeURIComponent(target);
    return !controls.test(decoded) && !unpairedSurrogate.test(decoded) && !decoded.includes('\\');
  } catch {
    return false;
  }
}

function rawAuthority(target: string): string | undefined {
  const authorityStart = 'https://'.length;
  const rest = target.slice(authorityStart);
  const end = rest.search(/[/?#]/u);
  return end < 0 ? rest : rest.slice(0, end);
}

function validAbsoluteTarget(target: string): boolean {
  // Scheme matching is intentionally case-sensitive: URL would otherwise
  // silently accept `HTTPS:` and create a scheme-confusion boundary.
  if (!target.startsWith('https://') || target.startsWith('//') || target.includes('\\')) return false;
  const authority = rawAuthority(target);
  if (authority === undefined || authority.length === 0 || authority.includes('@') || authority.includes('%')) {
    return false;
  }
  // Keep authority validation on the raw spelling. URL lowercases hostnames
  // and normalizes ports, which would erase the scheme-confusion signals.
  // Bracketed IPv6 is an exception: URL may compress/expand textual forms
  // while denoting the same address (same approach as origin-guard).
  const authorityMatch = absoluteAuthorityPattern.exec(authority);
  if (authorityMatch === null) return false;
  const rawHost = authorityMatch.groups?.host;
  const rawPort = authorityMatch.groups?.port;
  if (rawHost === undefined || rawHost.length === 0) return false;
  const isIpv6Literal = rawHost.startsWith('[');
  if (!isIpv6Literal) {
    if (rawHost.endsWith('.') || rawHost.startsWith('.') || rawHost.includes('..')) {
      return false;
    }
  }
  if (rawPort !== undefined && Number(rawPort) === 443) return false;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return false;
  if (url.hostname.length === 0 || /[^\x21-\x7e]/u.test(url.hostname)) return false;
  if (url.hostname.endsWith('.') || url.port === '443') return false;
  const pathEnd = target.search(/[?#]/u);
  const rawPath = pathEnd < 0 ? target.slice('https://'.length + authority.length) : target.slice('https://'.length + authority.length, pathEnd);
  if (rawPath !== '' && rawPath !== url.pathname) return false;
  return validatePercentAndDecodedCharacters(target);
}

function validOriginFormTarget(target: string): boolean {
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) return false;
  if (!validatePercentAndDecodedCharacters(target)) return false;
  try {
    const url = new URL(target, 'https://transport.invalid');
    const pathEnd = target.search(/[?#]/u);
    const rawPath = pathEnd < 0 ? target : target.slice(0, pathEnd);
    return url.origin === 'https://transport.invalid' && (rawPath === '' || rawPath === url.pathname);
  } catch {
    return false;
  }
}

function validTransport(value: unknown): boolean {
  try {
    assertPlainRecord(value, 'security input');
    exactOwnStringKeys(value, ['scheme'], 'security input');
    const scheme = readOwnDataProperty(value, 'scheme');
    return scheme.found && scheme.value === 'https';
  } catch {
    return false;
  }
}

/** Enforce HTTPS for remote HTTP request targets; local inputs are explicit no-ops. */
export function enforceHttpsEndpoint(input: unknown): HttpsEndpointDecision {
  try {
    assertPlainRecord(input, 'security input');
    const remoteField = readOwnDataProperty(input, 'remote');
    const applicabilityField = readOwnDataProperty(input, 'applicability');
    if (!remoteField.found || !applicabilityField.found) return denied('invalid_input');
    const remote = remoteField.value;
    const applicability = applicabilityField.value;
    if (remote === false) {
      // Deliberately inspect no target or transport value on the non-remote path.
      if (applicability !== 'not_applicable') return denied('applicability_mismatch');
      return notApplicableDecision;
    }
    if (remote !== true) return denied('invalid_input');
    if (applicability !== 'applicable') return denied('applicability_mismatch');
    exactOwnStringKeys(input, ['remote', 'applicability', 'requestTarget', 'transport'], 'security input');

    const targetField = readOwnDataProperty(input, 'requestTarget');
    const transportField = readOwnDataProperty(input, 'transport');
    if (!targetField.found || !transportField.found || !hasSafeString(targetField.value)) {
      return denied('invalid_input');
    }
    if (!validTransport(transportField.value)) return denied('transport_evidence_invalid');
    const target = targetField.value;
    if (typeof target !== 'string') return denied('invalid_input');
    if (target.startsWith('/')) {
      return validOriginFormTarget(target) ? enforcedDecision : denied('invalid_target');
    }
    return validAbsoluteTarget(target) ? enforcedDecision : denied('https_required');
  } catch {
    return denied('invalid_input');
  }
}
