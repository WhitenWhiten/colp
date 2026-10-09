import {
  enforceHttpsEndpoint,
  type HttpsEndpointApplicability,
  type HttpsEndpointDecision,
} from './https-enforcement.js';
import {
  assertPlainRecord,
  exactOwnStringKeys,
  readOwnDataProperty,
  snapshotDenseArray,
  type PlainRecord,
} from './input-snapshot.js';

const MAX_BOUNDARY_ORIGINS = 128;
import {
  enforceOriginGuard,
  type OriginGuardApplicability,
  type OriginGuardDecision,
} from './origin-guard.js';

/**
 * Trusted transport evidence for request-boundary composition.
 *
 * Values must be derived by the *deployment/framework* from listen address,
 * TLS terminator signals, and the request line — never from untrusted body
 * fields alone. Handlers must not call atomic guards with a self-asserted
 * `remote: false`; they should pass this evidence into the composition API.
 */
export interface TrustedTransportEvidence {
  /** Network exposure of the listen / peer address as classified by the deployment. */
  readonly networkExposure: 'loopback' | 'private' | 'public';
  /** Trusted reverse-proxy / TLS terminator signal (not a client-supplied header alone). */
  readonly tlsTerminated: boolean;
  /** Observed or terminator-asserted scheme at the application edge. */
  readonly transportScheme: 'https' | 'http' | 'other';
  /** Application protocol classification for origin applicability. */
  readonly protocol: 'streamable-http' | 'other';
  /** Origin-form or absolute request target for HTTPS enforcement. */
  readonly requestTarget: string;
  /** Request Origin header value(s), required for Streamable HTTP, including loopback. */
  readonly origin?: string | readonly string[];
}

export type BoundaryNetworkExposure = TrustedTransportEvidence['networkExposure'];
export type BoundaryTransportScheme = TrustedTransportEvidence['transportScheme'];
export type BoundaryProtocol = TrustedTransportEvidence['protocol'];

export interface RemoteApplicability {
  readonly remote: boolean;
  readonly applicability: HttpsEndpointApplicability;
}

/**
 * Denial reasons for {@link enforcePublisherStreamableHttpBoundary}.
 *
 * - `invalid_evidence` — trusted transport evidence snapshot failed
 * - `invalid_options` — boundary options (allowlist) snapshot failed
 * - `https_denied` / `origin_denied` — ordered stage denials after valid snapshots
 */
export type PublisherBoundaryDenialReason =
  | 'invalid_evidence'
  | 'invalid_options'
  | 'https_denied'
  | 'origin_denied';

export type PublisherStreamableHttpBoundaryDecision =
  | {
      readonly allowed: true;
      readonly remote: boolean;
      readonly https: HttpsEndpointDecision;
      readonly origin: OriginGuardDecision;
    }
  | {
      readonly allowed: false;
      readonly reason: PublisherBoundaryDenialReason;
      readonly remote?: boolean;
      readonly https?: HttpsEndpointDecision;
      readonly origin?: OriginGuardDecision;
    };

export interface PublisherStreamableHttpBoundaryOptions {
  readonly allowedOrigins: readonly string[];
}

const networkExposures = new Set<BoundaryNetworkExposure>(['loopback', 'private', 'public']);
const transportSchemes = new Set<BoundaryTransportScheme>(['https', 'http', 'other']);
const protocols = new Set<BoundaryProtocol>(['streamable-http', 'other']);

const invalidEvidenceDecision = Object.freeze({
  allowed: false,
  reason: 'invalid_evidence',
} as const satisfies PublisherStreamableHttpBoundaryDecision);

const invalidOptionsDecision = Object.freeze({
  allowed: false,
  reason: 'invalid_options',
} as const satisfies PublisherStreamableHttpBoundaryDecision);

interface EvidenceSnapshot {
  readonly networkExposure: BoundaryNetworkExposure;
  readonly tlsTerminated: boolean;
  readonly transportScheme: BoundaryTransportScheme;
  readonly protocol: BoundaryProtocol;
  readonly requestTarget: string;
  readonly origin: string | readonly string[] | undefined;
}

/**
 * Snapshot trusted evidence from plain own data properties.
 * Rejects Proxy values, accessors, unknown keys, and non-data fields.
 */
function snapshotTrustedEvidence(input: unknown): EvidenceSnapshot {
  assertPlainRecord(input, 'transport evidence');
  const allowedKeys = ['networkExposure', 'tlsTerminated', 'transportScheme', 'protocol', 'requestTarget', 'origin'];
  exactOwnStringKeys(input, allowedKeys, 'transport evidence');

  const networkExposureField = readOwnDataProperty(input, 'networkExposure');
  const tlsTerminatedField = readOwnDataProperty(input, 'tlsTerminated');
  const transportSchemeField = readOwnDataProperty(input, 'transportScheme');
  const protocolField = readOwnDataProperty(input, 'protocol');
  const requestTargetField = readOwnDataProperty(input, 'requestTarget');
  const originField = readOwnDataProperty(input, 'origin');

  if (
    !networkExposureField.found ||
    !tlsTerminatedField.found ||
    !transportSchemeField.found ||
    !protocolField.found ||
    !requestTargetField.found
  ) {
    throw new TypeError('transport evidence is incomplete');
  }

  const networkExposure = networkExposureField.value;
  const tlsTerminated = tlsTerminatedField.value;
  const transportScheme = transportSchemeField.value;
  const protocol = protocolField.value;
  const requestTarget = requestTargetField.value;

  if (typeof networkExposure !== 'string' || !networkExposures.has(networkExposure as BoundaryNetworkExposure)) {
    throw new TypeError('invalid networkExposure');
  }
  if (tlsTerminated !== true && tlsTerminated !== false) {
    throw new TypeError('invalid tlsTerminated');
  }
  if (typeof transportScheme !== 'string' || !transportSchemes.has(transportScheme as BoundaryTransportScheme)) {
    throw new TypeError('invalid transportScheme');
  }
  if (typeof protocol !== 'string' || !protocols.has(protocol as BoundaryProtocol)) {
    throw new TypeError('invalid protocol');
  }
  if (typeof requestTarget !== 'string' || requestTarget.length === 0) {
    throw new TypeError('invalid requestTarget');
  }

  let origin: string | readonly string[] | undefined;
  if (originField.found && originField.value !== undefined) {
    if (typeof originField.value === 'string') {
      origin = originField.value;
    } else {
      const values = snapshotDenseArray(originField.value, 'origin', { maxLength: MAX_BOUNDARY_ORIGINS });
      if (values.length > MAX_BOUNDARY_ORIGINS || !values.every((entry) => typeof entry === 'string')) {
        throw new TypeError('origin array entries must be strings');
      }
      origin = values as readonly string[];
    }
  }

  return Object.freeze({
    networkExposure: networkExposure as BoundaryNetworkExposure,
    tlsTerminated,
    transportScheme: transportScheme as BoundaryTransportScheme,
    protocol: protocol as BoundaryProtocol,
    requestTarget,
    origin,
  });
}

/**
 * Snapshot boundary options (Origin allowlist) from plain own data properties.
 * Uses distinct labels from transport evidence so diagnostics stay accurate.
 */
function snapshotBoundaryOptions(options: unknown): readonly string[] {
  assertPlainRecord(options, 'boundary options');
  exactOwnStringKeys(options as PlainRecord, ['allowedOrigins'], 'boundary options');
  const allowlistField = readOwnDataProperty(options, 'allowedOrigins');
  if (!allowlistField.found) {
    throw new TypeError('boundary options.allowedOrigins is required');
  }
  const allowlist = snapshotDenseArray(allowlistField.value, 'allowedOrigins', {
    maxLength: MAX_BOUNDARY_ORIGINS,
  });
  if (allowlist.length > MAX_BOUNDARY_ORIGINS
    || !allowlist.every((entry) => typeof entry === 'string')) {
    throw new TypeError('allowedOrigins entries must be strings');
  }
  return allowlist as readonly string[];
}

/**
 * Derive remote/applicability **only** from trusted deployment evidence.
 *
 * - `public` and `private` network exposure ⇒ remote + HTTPS applicable
 * - `loopback` ⇒ non-remote; HTTPS MUST is not_applicable
 *
 * Callers cannot pass a free-form `remote` override through this API.
 */
export function deriveRemoteApplicability(evidence: unknown): RemoteApplicability {
  const snapshot = snapshotTrustedEvidence(evidence);
  return deriveRemoteApplicabilityFromSnapshot(snapshot);
}

function deriveRemoteApplicabilityFromSnapshot(snapshot: EvidenceSnapshot): RemoteApplicability {
  if (snapshot.networkExposure === 'loopback') {
    return Object.freeze({ remote: false, applicability: 'not_applicable' as const });
  }
  return Object.freeze({ remote: true, applicability: 'applicable' as const });
}

/**
 * Map trusted terminator / scheme evidence into the scheme atom the HTTPS
 * guard accepts. TLS terminated at a trusted reverse proxy counts as https.
 */
function trustedHttpsScheme(snapshot: EvidenceSnapshot): 'https' | string {
  if (snapshot.tlsTerminated === true || snapshot.transportScheme === 'https') {
    return 'https';
  }
  return snapshot.transportScheme;
}

/**
 * HTTPS stage driven from a single trusted {@link EvidenceSnapshot}.
 * Composition and public transport helpers share this path.
 */
function enforceHttpsFromSnapshot(snapshot: EvidenceSnapshot): HttpsEndpointDecision {
  const { remote, applicability } = deriveRemoteApplicabilityFromSnapshot(snapshot);

  if (!remote) {
    return enforceHttpsEndpoint({
      remote: false,
      applicability: 'not_applicable',
    });
  }

  return enforceHttpsEndpoint({
    remote: true,
    applicability,
    requestTarget: snapshot.requestTarget,
    transport: { scheme: trustedHttpsScheme(snapshot) },
  });
}

/**
 * Origin stage driven from one evidence snapshot + one frozen allowlist.
 * Loopback relaxes HTTPS transport, never the browser-origin trust boundary.
 */
function enforceOriginFromSnapshot(
  snapshot: EvidenceSnapshot,
  allowedOrigins: readonly string[],
): OriginGuardDecision {
  const remote = deriveRemoteApplicabilityFromSnapshot(snapshot).remote;

  if (snapshot.protocol !== 'streamable-http') {
    return enforceOriginGuard({
      protocol: snapshot.protocol,
      remote,
      applicability: 'not_applicable' satisfies OriginGuardApplicability,
    });
  }

  if (snapshot.origin === undefined) {
    return Object.freeze({ allowed: false, reason: 'origin_invalid' }) as OriginGuardDecision;
  }

  return enforceOriginGuard({
    protocol: 'streamable-http',
    remote,
    applicability: 'applicable',
    requestOrigin: snapshot.origin,
    allowedOrigins,
  });
}

/**
 * Enforce HTTPS using only derived remote/applicability from trusted evidence.
 * Does **not** accept a free-form `remote` override from the composition caller.
 */
export function enforceHttpsFromTransport(evidence: unknown): HttpsEndpointDecision {
  let snapshot: EvidenceSnapshot;
  try {
    snapshot = snapshotTrustedEvidence(evidence);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' }) as HttpsEndpointDecision;
  }
  return enforceHttpsFromSnapshot(snapshot);
}

/**
 * Enforce the Origin allowlist for all Streamable HTTP requests, including loopback.
 * Other protocols retain the explicit origin-guard not_applicable path.
 */
export function enforceOriginFromTransport(
  evidence: unknown,
  allowedOrigins: readonly string[],
): OriginGuardDecision {
  let snapshot: EvidenceSnapshot;
  let allowlist: readonly string[];
  try {
    snapshot = snapshotTrustedEvidence(evidence);
    // Freeze allowlist once for this decision (same rules as boundary options).
    allowlist = snapshotDenseArray(allowedOrigins, 'allowedOrigins', {
      maxLength: MAX_BOUNDARY_ORIGINS,
    }) as readonly string[];
    if (allowlist.length > MAX_BOUNDARY_ORIGINS
      || !allowlist.every((entry) => typeof entry === 'string')) {
      return Object.freeze({ allowed: false, reason: 'invalid_input' }) as OriginGuardDecision;
    }
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' }) as OriginGuardDecision;
  }

  return enforceOriginFromSnapshot(snapshot, allowlist);
}

/**
 * Ordered publisher Streamable HTTP boundary: HTTPS then Origin.
 * Fail closed on first denial. Returns a frozen decision summary.
 *
 * Snapshots options and evidence **once** each, then drives both stages from
 * those frozen views (single trusted evidence decision).
 *
 * Adapters / handlers must supply {@link TrustedTransportEvidence} derived
 * from deployment signals — not a self-asserted `remote: false` on atomic guards.
 */
export function enforcePublisherStreamableHttpBoundary(
  evidence: unknown,
  options: PublisherStreamableHttpBoundaryOptions,
): PublisherStreamableHttpBoundaryDecision {
  let allowlist: readonly string[];
  try {
    allowlist = snapshotBoundaryOptions(options);
  } catch {
    return invalidOptionsDecision;
  }

  let snapshot: EvidenceSnapshot;
  let remote: boolean;
  try {
    snapshot = snapshotTrustedEvidence(evidence);
    remote = deriveRemoteApplicabilityFromSnapshot(snapshot).remote;
  } catch {
    return invalidEvidenceDecision;
  }

  const https = enforceHttpsFromSnapshot(snapshot);
  if (!https.allowed) {
    return Object.freeze({
      allowed: false,
      reason: 'https_denied' as const,
      remote,
      https,
    });
  }

  const origin = enforceOriginFromSnapshot(snapshot, allowlist);
  if (!origin.allowed) {
    return Object.freeze({
      allowed: false,
      reason: 'origin_denied' as const,
      remote,
      https,
      origin,
    });
  }

  return Object.freeze({
    allowed: true as const,
    remote,
    https,
    origin,
  });
}
