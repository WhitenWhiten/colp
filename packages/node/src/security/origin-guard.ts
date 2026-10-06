import {
  assertPlainRecord,
  exactOwnStringKeys,
  readOwnDataProperty,
  snapshotDenseArray,
} from './input-snapshot.js';

/** Applicability supplied by the transport adapter. */
export type OriginGuardApplicability = 'applicable' | 'not_applicable';

export interface OriginGuardInput {
  readonly protocol: string;
  readonly remote: boolean;
  readonly applicability: OriginGuardApplicability;
  readonly requestOrigin: string | readonly string[];
  readonly allowedOrigins: readonly string[];
}

export type OriginGuardDenialReason =
  | 'invalid_input'
  | 'applicability_mismatch'
  | 'origin_invalid'
  | 'origin_not_allowed';

export type OriginGuardDecision =
  | {
      readonly allowed: true;
      readonly disposition: 'enforced';
      readonly location: 'remote' | 'local';
      readonly reason: 'origin_allowed';
    }
  | {
      readonly allowed: true;
      readonly disposition: 'not_applicable';
      readonly location: 'local';
      readonly reason: 'not_applicable';
    }
  | {
      readonly allowed: false;
      readonly reason: OriginGuardDenialReason;
    };

const notApplicableDecision = Object.freeze({
  allowed: true,
  disposition: 'not_applicable',
  location: 'local',
  reason: 'not_applicable',
} as const);
const allowedDecision = Object.freeze({
  allowed: true,
  disposition: 'enforced',
  location: 'remote',
  reason: 'origin_allowed',
} as const);
const allowedLocalDecision = Object.freeze({
  ...allowedDecision,
  location: 'local',
} as const);
const denialDecisions = Object.freeze(
  Object.fromEntries(
    ['invalid_input', 'applicability_mismatch', 'origin_invalid', 'origin_not_allowed'].map((reason) => [
      reason,
      Object.freeze({ allowed: false, reason }),
    ]),
  ) as Record<OriginGuardDenialReason, OriginGuardDecision>,
);

const controls = /[\u0000-\u001f\u007f]/u;
const originText = /^[\x21-\x7e]+$/u;
const authorityPattern = /^(?<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(?<port>[0-9]{1,5}))?$/u;

function denied(reason: OriginGuardDenialReason): OriginGuardDecision {
  return denialDecisions[reason];
}

/** Canonical HTTPS origin; local transports may explicitly allow loopback HTTP origins. */
function canonicalOrigin(value: unknown, allowLoopbackHttp = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || controls.test(value) || !originText.test(value)) return undefined;
  if (value === 'null' || value === '*' || value.includes('%') || value.includes('\\') || value.includes(',')) {
    return undefined;
  }
  if (!/^https?:\/\//iu.test(value)) return undefined;
  const authority = value.slice(value.indexOf('//') + 2);
  if (authority.length === 0 || /[/?#]/u.test(authority) || authority.includes('@')) return undefined;
  const match = authorityPattern.exec(authority);
  if (match === null) return undefined;
  const host = match.groups?.host;
  const rawPort = match.groups?.port;
  if (host === undefined || host.length === 0) return undefined;
  if (!host.startsWith('[')) {
    if (host.startsWith('.') || host.endsWith('.') || host.includes('..') || host.includes('_')) return undefined;
    for (const label of host.split('.')) {
      if (label.length === 0 || label.startsWith('-') || label.endsWith('-')) return undefined;
    }
  }
  const port = rawPort === undefined ? undefined : Number(rawPort);
  if (
    port !== undefined &&
    (rawPort !== String(port) || !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const loopbackHttp = allowLoopbackHttp && parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  if ((parsed.protocol !== 'https:' && !loopbackHttp) || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return undefined;
  }
  // URL may rewrite a host (for example, an IPv4 variant); compare the raw
  // ASCII authority to its canonical spelling to prevent host confusion.
  const canonicalHost = parsed.hostname.toLowerCase();
  const rawHostCanonical = host.toLowerCase();
  // IPv6 textual forms may legitimately compress/expand while denoting the
  // same address; URL provides the canonical bracketed representation.
  if (!host.startsWith('[') && canonicalHost !== rawHostCanonical) {
    return undefined;
  }
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  const normalizedPort = port === undefined || port === defaultPort ? '' : `:${port}`;
  return `${parsed.protocol}//${canonicalHost}${normalizedPort}`;
}

function requestOriginSnapshot(value: unknown, allowLoopbackHttp: boolean): string | undefined {
  if (typeof value === 'string') return canonicalOrigin(value, allowLoopbackHttp);
  const values = snapshotDenseArray(value, 'requestOrigin');
  if (values.length !== 1 || typeof values[0] !== 'string') return undefined;
  return canonicalOrigin(values[0], allowLoopbackHttp);
}

/** Enforce an exact Origin allowlist for every Streamable HTTP MCP request, including loopback. */
export function enforceOriginGuard(input: unknown): OriginGuardDecision {
  try {
    assertPlainRecord(input, 'origin guard input');
    const protocolField = readOwnDataProperty(input, 'protocol');
    const remoteField = readOwnDataProperty(input, 'remote');
    const applicabilityField = readOwnDataProperty(input, 'applicability');
    if (!protocolField.found || !remoteField.found || !applicabilityField.found) return denied('invalid_input');
    const protocol = protocolField.value;
    const remote = remoteField.value;
    const applicability = applicabilityField.value;
    if (typeof protocol !== 'string' || (remote !== true && remote !== false)) return denied('invalid_input');
    if (protocol !== 'streamable-http') {
      if (applicability !== 'not_applicable') return denied('applicability_mismatch');
      return notApplicableDecision;
    }
    if (applicability !== 'applicable') return denied('applicability_mismatch');
    exactOwnStringKeys(
      input,
      ['protocol', 'remote', 'applicability', 'requestOrigin', 'allowedOrigins'],
      'origin guard input',
    );
    const requestOriginField = readOwnDataProperty(input, 'requestOrigin');
    const allowedOriginsField = readOwnDataProperty(input, 'allowedOrigins');
    if (!requestOriginField.found || !allowedOriginsField.found) return denied('invalid_input');
    const requestOrigin = requestOriginSnapshot(requestOriginField.value, !remote);
    const allowedValues = snapshotDenseArray(allowedOriginsField.value, 'allowedOrigins');
    if (allowedValues.length === 0) return denied('invalid_input');
    const allowed = new Set<string>();
    for (const candidate of allowedValues) {
      const origin = canonicalOrigin(candidate, !remote);
      if (origin === undefined || allowed.has(origin)) return denied('origin_invalid');
      allowed.add(origin);
    }
    if (requestOrigin === undefined) return denied('origin_invalid');
    if (!allowed.has(requestOrigin)) return denied('origin_not_allowed');
    return remote ? allowedDecision : allowedLocalDecision;
  } catch {
    return denied('invalid_input');
  }
}
