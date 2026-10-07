import { createHash, timingSafeEqual } from 'node:crypto';
import {
  assertProfileClaims,
  createDeploymentConformancePlan,
  type ConformancePort,
  type DeploymentConformanceScope,
  type VerifiedDeploymentConformanceEvidence,
  type VerifiedProfileClaims,
} from '@know-n/colp/conformance';
import type { EndpointKey } from '@know-n/colp/semantic';

export type Phase2PublicationRequiredProbe =
  | 'browser'
  | 'cachePartition'
  | 'cursorRotationRestart'
  | 'mutationFences'
  | 'goneRetention'
  | 'purgeTelemetry';

export interface Phase2PublicationAcceptanceArtifact {
  readonly evidence: 'phase2_publication_black_box_acceptance';
  readonly format: 'known.phase2.publication-acceptance.v1';
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly generatedAt: string;
  readonly target: Readonly<Record<string, unknown>> & { readonly collectionId: string };
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly clientChallenge: Readonly<Record<string, unknown>>;
  readonly traversal: Readonly<Record<string, unknown>>;
  readonly cache: Readonly<Record<string, unknown>>;
  readonly latency: Readonly<Record<string, unknown>>;
  readonly probes: Readonly<Record<Phase2PublicationRequiredProbe, Readonly<{
    readonly passed: true;
    readonly durationMs: number;
    readonly detail: unknown;
  }>>>;
  readonly requests: readonly Readonly<Record<string, unknown>>[];
  readonly accepted: true;
  readonly evidenceDigest: string;
}

export const PHASE2_PROFILE_CLAIMS = Object.freeze(['core', 'publication'] as const);
export const PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE = Object.freeze({
  profiles: PHASE2_PROFILE_CLAIMS,
  capabilities: Object.freeze(['core-authoritative-writes'] as const),
}) satisfies DeploymentConformanceScope;
export const PHASE2_DEPLOYMENT_CONFORMANCE_PLAN = createDeploymentConformancePlan(
  PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE,
);
export const PHASE2_PROFILE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const REQUIRED_ENDPOINTS = Object.freeze([
  'directory',
  'collection',
  'snapshot',
] as const satisfies readonly EndpointKey[]);
const REQUIRED_PORTS = Object.freeze(['schema', 'semantic', 'client', 'server'] as const);
const REQUIRED_PROBES = Object.freeze([
  'browser',
  'cachePartition',
  'cursorRotationRestart',
  'mutationFences',
  'goneRetention',
  'purgeTelemetry',
] as const satisfies readonly Phase2PublicationRequiredProbe[]);
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;

export interface Phase2SourceIdentity {
  readonly sourceRevision: string;
  readonly sourceDigest: string;
}

export interface VerifyPhase2PublicationEvidenceOptions extends Phase2SourceIdentity {
  readonly now?: Date | number;
  readonly maxAgeMs?: number;
}

export interface VerifiedPhase2PublicationEvidence {
  readonly evidence: Phase2PublicationAcceptanceArtifact;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly evidenceDigest: string;
  readonly verifiedAt: string;
}

export interface Phase2PublicationProfileClaims extends Phase2SourceIdentity {
  readonly profiles: VerifiedProfileClaims;
  readonly evidenceDigest: string;
  readonly generatedAt: string;
}

export interface Phase2PublicationProfileClaimController {
  current(): Phase2PublicationProfileClaims | undefined;
  activate(claims: Phase2PublicationProfileClaims): void;
}

const issuedEvidence = new WeakSet<object>();
const issuedClaims = new WeakSet<object>();
const issuedControllers = new WeakSet<object>();

/** Validates a detached P2-16 artifact before it may reach the COLP claim gate. */
export function verifyPhase2PublicationEvidence(
  value: unknown,
  options: VerifyPhase2PublicationEvidenceOptions,
): VerifiedPhase2PublicationEvidence {
  const now = instant(options.now ?? Date.now(), 'now');
  const maxAgeMs = options.maxAgeMs ?? PHASE2_PROFILE_EVIDENCE_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new RangeError('Phase 2 evidence maxAgeMs must be a positive safe integer');
  }
  const sourceRevision = fullRevision(options.sourceRevision, 'expected sourceRevision');
  const sourceDigest = sha256(options.sourceDigest, 'expected sourceDigest');
  assertBoundedJson(value);
  const artifact = record(value, 'Phase 2 evidence');
  exactKeys(artifact, [
    'accepted', 'cache', 'clientChallenge', 'evidence', 'evidenceDigest', 'format',
    'generatedAt', 'latency', 'manifest', 'probes', 'requests', 'sourceDigest',
    'sourceRevision', 'target', 'traversal',
  ], 'Phase 2 evidence');
  if (artifact.evidence !== 'phase2_publication_black_box_acceptance') {
    throw new TypeError('Phase 2 evidence marker is invalid');
  }
  if (artifact.format !== 'known.phase2.publication-acceptance.v1') {
    throw new TypeError('Phase 2 evidence format is unsupported');
  }
  if (artifact.accepted !== true) throw new TypeError('Phase 2 evidence is not accepted');
  if (artifact.sourceRevision !== sourceRevision || artifact.sourceDigest !== sourceDigest) {
    throw new TypeError('Phase 2 evidence does not match the current source identity');
  }

  const generatedAt = canonicalInstant(artifact.generatedAt, 'generatedAt');
  const generatedAtMs = Date.parse(generatedAt);
  if (generatedAtMs > now.getTime()) throw new TypeError('Phase 2 evidence was generated in the future');
  if (now.getTime() - generatedAtMs > maxAgeMs) throw new TypeError('Phase 2 evidence is stale');

  const claimedDigest = acceptanceDigest(artifact.evidenceDigest, 'evidenceDigest');
  const payload = { ...artifact };
  delete payload.evidenceDigest;
  const actualDigest = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('base64url');
  if (!constantTimeEqual(claimedDigest, actualDigest)) {
    throw new TypeError('Phase 2 evidence digest does not match its canonical payload');
  }

  assertAcceptancePayload(artifact);
  const detached = deepFreeze(
    JSON.parse(JSON.stringify(artifact)),
  ) as Phase2PublicationAcceptanceArtifact;
  const verified = deepFreeze({
    evidence: detached,
    sourceRevision,
    sourceDigest,
    evidenceDigest: claimedDigest,
    verifiedAt: now.toISOString(),
  });
  issuedEvidence.add(verified);
  return verified;
}

/** Same-process activation point used by release probes and the live Manifest route. */
export function createPhase2PublicationProfileClaimController(): Phase2PublicationProfileClaimController {
  let active: Phase2PublicationProfileClaims | undefined;
  const controller = Object.freeze({
    current() {
      return active;
    },
    activate(claims: Phase2PublicationProfileClaims) {
      assertPhase2PublicationProfileClaims(claims);
      if (active !== undefined && active !== claims) {
        throw new TypeError('Publication Profile claims are already active for this process');
      }
      active = claims;
    },
  });
  issuedControllers.add(controller);
  return controller;
}

export function assertPhase2PublicationProfileClaimController(
  value: Phase2PublicationProfileClaimController,
): void {
  if (!issuedControllers.has(value)) {
    throw new TypeError('Publication Profile claim controller must be issued by this module');
  }
}

/**
 * Combines source-bound P2-16 evidence with package-issued deployment evidence.
 * The pinned public assertProfileClaims remains the final authority.
 */
export function claimPhase2PublicationProfiles(input: {
  readonly evidence: VerifiedPhase2PublicationEvidence;
  readonly deploymentEvidence: VerifiedDeploymentConformanceEvidence;
}): Phase2PublicationProfileClaims {
  if (!issuedEvidence.has(input.evidence)) {
    throw new TypeError('Phase 2 evidence must be returned by verifyPhase2PublicationEvidence');
  }
  if (input.deploymentEvidence.profiles.join('\0')
      !== PHASE2_DEPLOYMENT_CONFORMANCE_PLAN.profiles.join('\0')
      || input.deploymentEvidence.capabilities.join('\0')
      !== PHASE2_DEPLOYMENT_CONFORMANCE_PLAN.capabilities.join('\0')) {
    throw new TypeError('Phase 2 deployment conformance evidence used the wrong scope');
  }
  const passed = new Set(input.deploymentEvidence.passedProbeIds);
  const missing = PHASE2_DEPLOYMENT_CONFORMANCE_PLAN.probeIds.filter(
    (probe) => !passed.has(probe),
  );
  if (missing.length > 0) {
    throw new TypeError(`Phase 2 deployment conformance evidence is incomplete: ${missing.join(', ')}`);
  }
  const profiles = assertProfileClaims(PHASE2_PROFILE_CLAIMS, {
    registeredEndpoints: new Set<EndpointKey>(REQUIRED_ENDPOINTS),
    availablePorts: new Set<ConformancePort>(REQUIRED_PORTS),
    deploymentEvidence: input.deploymentEvidence,
  });
  if (profiles.length !== 2 || profiles[0] !== 'core' || profiles[1] !== 'publication') {
    throw new TypeError('COLP returned an unexpected Phase 2 Profile claim set');
  }
  const claims = deepFreeze({
    profiles,
    sourceRevision: input.evidence.sourceRevision,
    sourceDigest: input.evidence.sourceDigest,
    evidenceDigest: input.evidence.evidenceDigest,
    generatedAt: input.evidence.evidence.generatedAt,
  });
  issuedClaims.add(claims);
  return claims;
}

/** Rejects copied or manually reconstructed claim objects at the Manifest boundary. */
export function assertPhase2PublicationProfileClaims(
  value: Phase2PublicationProfileClaims,
): asserts value is Phase2PublicationProfileClaims {
  if (!issuedClaims.has(value)) {
    throw new TypeError('Publication Profile claims must be issued by claimPhase2PublicationProfiles');
  }
}

export function inspectPhase2PublicationProfileClaims(
  value: Phase2PublicationProfileClaims,
): Readonly<Phase2SourceIdentity & { readonly evidenceDigest: string }> {
  assertPhase2PublicationProfileClaims(value);
  return Object.freeze({
    sourceRevision: value.sourceRevision,
    sourceDigest: value.sourceDigest,
    evidenceDigest: value.evidenceDigest,
  });
}

function assertAcceptancePayload(artifact: Record<string, unknown>): void {
  const challenge = record(artifact.clientChallenge, 'clientChallenge');
  exactKeys(challenge, ['addedProfile', 'applied'], 'clientChallenge');
  if (challenge.applied !== true || challenge.addedProfile !== 'publication') {
    throw new TypeError('Phase 2 evidence did not exercise the unclaimed Publication challenge');
  }

  const manifest = record(artifact.manifest, 'manifest');
  exactKeys(manifest, [
    'claimedPublication', 'conditional', 'deployedProfiles', 'endpoints',
    'mountId', 'serverUuid',
  ], 'manifest');
  if (manifest.claimedPublication !== false) {
    throw new TypeError('P2-16 evidence must come from an initially unclaimed deployment');
  }
  if (!stringArray(manifest.deployedProfiles).includes('core')
      || stringArray(manifest.deployedProfiles).includes('publication')) {
    throw new TypeError('P2-16 deployed Profile observation is invalid');
  }
  const endpoints = record(manifest.endpoints, 'manifest.endpoints');
  exactKeys(endpoints, REQUIRED_ENDPOINTS, 'manifest.endpoints');
  const endpointOrigins = REQUIRED_ENDPOINTS.map((name) => absoluteUrl(endpoints[name], `manifest.endpoints.${name}`).origin);

  const target = record(artifact.target, 'target');
  exactKeys(target, ['collectionId', 'manifestUrl', 'origin', 'postgres'], 'target');
  const origin = exactOrigin(target.origin, 'target.origin');
  if (absoluteUrl(target.manifestUrl, 'target.manifestUrl').origin !== origin) {
    throw new TypeError('Phase 2 Manifest URL does not match the target origin');
  }
  if (endpointOrigins.some((candidate) => candidate !== origin)) {
    throw new TypeError('Phase 2 endpoint evidence crosses the target origin');
  }
  nonEmpty(target.collectionId, 'target.collectionId');
  const postgres = record(target.postgres, 'target.postgres');
  exactKeys(postgres, ['database', 'engine', 'version'], 'target.postgres');
  if (postgres.engine !== 'postgresql') throw new TypeError('Phase 2 evidence did not use PostgreSQL');
  nonEmpty(postgres.database, 'target.postgres.database');
  nonEmpty(postgres.version, 'target.postgres.version');

  assertConditional(record(manifest.conditional, 'manifest.conditional'), true);
  const traversal = record(artifact.traversal, 'traversal');
  exactKeys(traversal, [
    'directoryCollectionCount', 'directoryContainsTarget', 'metadataCollectionId',
    'snapshotCollectionId', 'snapshotHttpPages', 'snapshotNodeCount',
  ], 'traversal');
  if (traversal.directoryContainsTarget !== true
      || traversal.metadataCollectionId !== target.collectionId
      || traversal.snapshotCollectionId !== target.collectionId
      || positiveInteger(traversal.directoryCollectionCount, 'traversal.directoryCollectionCount') < 1
      || positiveInteger(traversal.snapshotNodeCount, 'traversal.snapshotNodeCount') < 10_000
      || positiveInteger(traversal.snapshotHttpPages, 'traversal.snapshotHttpPages') < 2) {
    throw new TypeError('Phase 2 traversal evidence is incomplete');
  }

  const cache = record(artifact.cache, 'cache');
  exactKeys(cache, [
    'endpointConditionals', 'manifestRevalidated', 'publicResponsesHaveCachePolicy',
  ], 'cache');
  if (cache.manifestRevalidated !== true || cache.publicResponsesHaveCachePolicy !== true) {
    throw new TypeError('Phase 2 cache evidence is incomplete');
  }
  const conditionals = record(cache.endpointConditionals, 'cache.endpointConditionals');
  exactKeys(conditionals, ['directory', 'manifest', 'metadata', 'snapshot'], 'cache.endpointConditionals');
  for (const name of ['directory', 'manifest', 'metadata', 'snapshot']) {
    assertConditional(record(conditionals[name], `cache.endpointConditionals.${name}`), false);
  }

  const probes = record(artifact.probes, 'probes');
  exactKeys(probes, REQUIRED_PROBES, 'probes');
  for (const name of REQUIRED_PROBES) {
    const probe = record(probes[name], `probes.${name}`);
    exactKeys(probe, ['detail', 'durationMs', 'passed'], `probes.${name}`);
    if (probe.passed !== true) throw new TypeError(`Phase 2 ${name} probe did not pass`);
    nonNegativeNumber(probe.durationMs, `probes.${name}.durationMs`);
  }

  assertLatency(record(artifact.latency, 'latency'));
  const requests = array(artifact.requests, 'requests');
  if (requests.length === 0) throw new TypeError('Phase 2 request evidence is empty');
  const phases = new Set<string>();
  for (const [index, entry] of requests.entries()) {
    const request = record(entry, `requests[${index}]`);
    exactKeys(request, [
      'cacheControl', 'durationMs', 'etag', 'link', 'method', 'phase',
      'status', 'url', 'vary',
    ], `requests[${index}]`);
    if (request.phase !== 'raw' && request.phase !== 'colp-client') {
      throw new TypeError(`requests[${index}].phase is invalid`);
    }
    phases.add(request.phase);
    nonEmpty(request.method, `requests[${index}].method`);
    absoluteUrl(request.url, `requests[${index}].url`);
    nonNegativeNumber(request.durationMs, `requests[${index}].durationMs`);
    if (request.status !== 200 && request.status !== 304) {
      throw new TypeError(`requests[${index}].status is not successful`);
    }
  }
  if (!phases.has('raw') || !phases.has('colp-client')) {
    throw new TypeError('Phase 2 evidence must contain raw and COLP client requests');
  }
}

function assertConditional(value: Record<string, unknown>, includeCacheControl: boolean): void {
  exactKeys(value, includeCacheControl
    ? ['cacheControl', 'etag', 'getStatus', 'headStatus', 'notModifiedStatus']
    : ['etag', 'getStatus', 'headStatus', 'notModifiedStatus'], 'conditional');
  if (value.getStatus !== 200 || value.headStatus !== 200 || value.notModifiedStatus !== 304) {
    throw new TypeError('Phase 2 conditional request evidence is incomplete');
  }
  nonEmpty(value.etag, 'conditional.etag');
  if (includeCacheControl) nonEmpty(value.cacheControl, 'conditional.cacheControl');
}

function assertLatency(value: Record<string, unknown>): void {
  exactKeys(value, [
    'requestCount', 'requestMaxMs', 'requestP50Ms', 'requestP95Ms',
    'snapshotTraversalMs', 'thresholds',
  ], 'latency');
  positiveInteger(value.requestCount, 'latency.requestCount');
  const p50 = nonNegativeNumber(value.requestP50Ms, 'latency.requestP50Ms');
  const p95 = nonNegativeNumber(value.requestP95Ms, 'latency.requestP95Ms');
  const max = nonNegativeNumber(value.requestMaxMs, 'latency.requestMaxMs');
  const traversal = nonNegativeNumber(value.snapshotTraversalMs, 'latency.snapshotTraversalMs');
  if (p50 > p95 || p95 > max) throw new TypeError('Phase 2 latency percentiles are inconsistent');
  const thresholds = record(value.thresholds, 'latency.thresholds');
  exactKeys(thresholds, [
    'expectedSnapshotNodes', 'maxRequestP95Ms', 'maxSnapshotTraversalMs',
  ], 'latency.thresholds');
  if (positiveInteger(thresholds.expectedSnapshotNodes, 'latency.thresholds.expectedSnapshotNodes') < 10_000
      || p95 > positiveNumber(thresholds.maxRequestP95Ms, 'latency.thresholds.maxRequestP95Ms')
      || traversal > positiveNumber(thresholds.maxSnapshotTraversalMs, 'latency.thresholds.maxSnapshotTraversalMs')) {
    throw new TypeError('Phase 2 latency or traversal threshold was not satisfied');
  }
}

function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new TypeError('Phase 2 evidence exceeds the JSON depth limit');
    nodes += 1;
    if (nodes > 250_000) throw new TypeError('Phase 2 evidence exceeds the JSON node limit');
    if (candidate === null || ['string', 'boolean'].includes(typeof candidate)) return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('Phase 2 evidence numbers must be finite');
      return;
    }
    if (typeof candidate !== 'object') throw new TypeError('Phase 2 evidence must contain only JSON values');
    if (Object.getOwnPropertySymbols(candidate).length > 0) {
      throw new TypeError('Phase 2 evidence must not contain symbol properties');
    }
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length) {
        throw new TypeError('Phase 2 evidence arrays must be dense and unadorned');
      }
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype
        && Object.getPrototypeOf(candidate) !== null) {
      throw new TypeError('Phase 2 evidence objects must be plain JSON records');
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('Phase 2 evidence must not contain accessors or hidden fields');
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new TypeError('Phase 2 evidence exceeds the byte limit');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) throw new TypeError('Phase 2 evidence contains a non-JSON value');
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.join('\0') !== canonicalExpected.join('\0')) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty`);
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('Expected an array of strings');
  }
  return value as readonly string[];
}

function fullRevision(value: unknown, label: string): string {
  const revision = nonEmpty(value, label);
  if (!/^[0-9a-f]{40,64}$/u.test(revision)) throw new TypeError(`${label} must be a full hexadecimal revision`);
  return revision;
}

function sha256(value: unknown, label: string): string {
  const digest = nonEmpty(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  return digest;
}

function acceptanceDigest(value: unknown, label: string): string {
  const digest = nonEmpty(value, label);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(digest)
      || Buffer.from(digest, 'base64url').toString('base64url') !== digest) {
    throw new TypeError(`${label} must be a canonical SHA-256 base64url digest`);
  }
  return digest;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical UTC instant`);
  }
  return text;
}

function instant(value: Date | number, label: string): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${label} must be a valid instant`);
  return result;
}

function exactOrigin(value: unknown, label: string): string {
  const url = absoluteUrl(value, label);
  if (url.href !== `${url.origin}/` || url.username || url.password) {
    throw new TypeError(`${label} must be an exact origin`);
  }
  return url.origin;
}

function absoluteUrl(value: unknown, label: string): URL {
  try {
    const url = new URL(nonEmpty(value, label));
    if (url.username || url.password || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error();
    return url;
  } catch {
    throw new TypeError(`${label} must be a safe absolute HTTP URL`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (number === 0) throw new TypeError(`${label} must be positive`);
  return number;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
