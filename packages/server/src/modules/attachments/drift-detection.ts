/**
 * P4A-I15 production control-plane drift detector (injected fetch).
 *
 * Queries the Cloudflare R2 control API (bucket, managed domains, custom
 * domains, lifecycle) with a dedicated control token and compares the live
 * facts against the expected private-bucket controls. Returns a structured
 * drift report; it NEVER writes, deletes, or mutates anything.
 *
 * Classification (plan §6 I15 anti-false-negative):
 *  - real policy drift (public access, enabled custom/managed domains,
 *    lifecycle deletion of quarantine/live prefixes, probe retention drift)
 *    -> `drift`;
 *  - provider 429 / 5xx / timeout / transport failure -> `environment`
 *    (never policy drift);
 *  - new/unknown provider fields -> `contract_drift` (fail closed, never
 *    silently ignored);
 *  - control-plane attestation (`plane: 'control'`) and data-plane health
 *    (`plane: 'data'`) are classified separately.
 *
 * The report contains only fixed check names, statuses, and detail codes —
 * never the token, raw provider text, bucket, prefixes, or URLs. Real-API
 * evidence is pending; contract tests use injected fetch.
 */
const CONTROL_API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;

export type AttachmentDriftCheckName =
  | 'bucket_public_access'
  | 'custom_domains'
  | 'managed_domains'
  | 'lifecycle_rules'
  | 'prefix_drift';

export type AttachmentDriftCheckStatus = 'ok' | 'drift' | 'environment' | 'contract_drift';

export interface AttachmentDriftFinding {
  readonly check: AttachmentDriftCheckName;
  readonly status: AttachmentDriftCheckStatus;
  /** Fixed code only; never free-form provider text or secrets. */
  readonly detail: string;
}

export type AttachmentControlDriftOverall = 'ok' | 'drift' | 'environment' | 'contract_drift';

export interface AttachmentControlDriftReport {
  readonly plane: 'control';
  readonly generatedAtIso: string;
  readonly overall: AttachmentControlDriftOverall;
  readonly findings: ReadonlyArray<AttachmentDriftFinding>;
  readonly driftCount: number;
  readonly environmentCount: number;
  readonly contractDriftCount: number;
  readonly method: 'cloudflare-control-api-live-query';
}

export interface AttachmentControlDriftExpected {
  readonly accountId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  readonly quarantinePrefix: string;
  readonly probeObjectsMaximumAgeSeconds: number;
}

export interface AttachmentControlDriftInput {
  readonly expected: AttachmentControlDriftExpected;
  /** Dedicated control-plane token; never an R2 data-plane credential. */
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowIso?: string;
}

export type AttachmentDataPlaneHealthClass = 'ok' | 'not_found' | 'denied' | 'retryable' | 'unknown';
export type AttachmentDataPlaneHealthStatus = 'ok' | 'degraded' | 'unavailable';

type EndpointName = 'bucket' | 'managed' | 'custom' | 'lifecycle';

interface EndpointOk {
  readonly kind: 'ok';
  readonly payload: unknown;
}
interface EndpointProblem {
  readonly kind: 'problem';
  readonly status: 'environment' | 'contract_drift';
  readonly detail: string;
}
type EndpointResult = EndpointOk | EndpointProblem;

function prefixesOverlap(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

function assertKnownKeys(value: unknown, allowed: readonly string[], required: readonly string[]): void | { readonly detail: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { detail: 'control_api_malformed_response' };
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) return { detail: 'control_contract_drift' };
  if (required.some((key) => !keys.includes(key))) return { detail: 'control_api_malformed_response' };
  return undefined;
}

async function fetchEndpoint(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
): Promise<EndpointResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${CONTROL_API_ORIGIN}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return { kind: 'problem', status: 'environment', detail: 'control_api_timeout' };
    }
    return { kind: 'problem', status: 'environment', detail: 'control_attestation_failed' };
  }
  if (!response.ok) {
    // 429/5xx and any other transport HTTP error are environment, never drift.
    return { kind: 'problem', status: 'environment', detail: 'provider_http_error' };
  }
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    return { kind: 'problem', status: 'environment', detail: 'control_api_malformed_response' };
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return { kind: 'problem', status: 'environment', detail: 'control_api_malformed_response' };
  }
  const envelopeProblem = assertKnownKeys(envelope, ['success', 'errors', 'messages', 'result'], ['success', 'errors', 'messages', 'result']);
  if (envelopeProblem) {
    return {
      kind: 'problem',
      status: envelopeProblem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
      detail: envelopeProblem.detail,
    };
  }
  const envelopeObject = envelope as Record<string, unknown>;
  if (typeof envelopeObject.success !== 'boolean' || !Array.isArray(envelopeObject.errors)
    || !Array.isArray(envelopeObject.messages) || envelopeObject.result === undefined) {
    return { kind: 'problem', status: 'environment', detail: 'control_api_malformed_response' };
  }
  if (!envelopeObject.success) {
    // Provider-reported failure with no usable result: environment.
    return { kind: 'problem', status: 'environment', detail: 'control_api_unsuccessful' };
  }
  return { kind: 'ok', payload: envelopeObject.result };
}

function evaluateBucket(result: unknown, expected: AttachmentControlDriftExpected): AttachmentDriftFinding[] {
  const problem = assertKnownKeys(result, ['name', 'creation_date', 'location', 'storage_class', 'jurisdiction', 'public_access'], ['name']);
  if (problem) {
    return [{
      check: 'bucket_public_access',
      status: problem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
      detail: problem.detail,
    }];
  }
  const bucket = result as Record<string, unknown>;
  if (bucket.public_access === true) {
    return [{ check: 'bucket_public_access', status: 'drift', detail: 'bucket_public_access_enabled' }];
  }
  if (bucket.name !== expected.bucket) {
    return [{ check: 'bucket_public_access', status: 'drift', detail: 'bucket_binding_mismatch' }];
  }
  return [];
}

function evaluateManagedDomain(result: unknown): AttachmentDriftFinding[] {
  const problem = assertKnownKeys(result, ['domain', 'enabled', 'bucketId'], ['enabled']);
  if (problem) {
    return [{
      check: 'managed_domains',
      status: problem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
      detail: problem.detail,
    }];
  }
  if ((result as Record<string, unknown>).enabled === true) {
    return [{ check: 'managed_domains', status: 'drift', detail: 'managed_domain_enabled' }];
  }
  return [];
}

function evaluateCustomDomains(result: unknown): AttachmentDriftFinding[] {
  const problem = assertKnownKeys(result, ['domains'], ['domains']);
  if (problem) {
    return [{
      check: 'custom_domains',
      status: problem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
      detail: problem.detail,
    }];
  }
  const domains = (result as { domains: unknown }).domains;
  if (!Array.isArray(domains)) return [{ check: 'custom_domains', status: 'environment', detail: 'control_api_malformed_response' }];
  for (const domain of domains) {
    const domainProblem = assertKnownKeys(domain, ['domain', 'enabled'], ['domain', 'enabled']);
    if (domainProblem) {
      return [{
        check: 'custom_domains',
        status: domainProblem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
        detail: domainProblem.detail,
      }];
    }
    if ((domain as Record<string, unknown>).enabled === true) {
      return [{ check: 'custom_domains', status: 'drift', detail: 'custom_domain_enabled' }];
    }
  }
  return [];
}

interface LifecycleRuleFacts {
  readonly id: string;
  readonly enabled: boolean;
  readonly prefix: string;
  readonly maxAge: number | null;
}

function parseLifecycleRule(rule: unknown): LifecycleRuleFacts | { readonly detail: string } {
  const problem = assertKnownKeys(rule,
    ['id', 'enabled', 'conditions', 'deleteObjectsTransition', 'abortMultipartUploadsTransition', 'storageClassTransitions'],
    ['id', 'enabled']);
  if (problem) return problem;
  const record = rule as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.enabled !== 'boolean') return { detail: 'control_api_malformed_response' };
  let prefix = '';
  if (record.conditions !== undefined) {
    const conditionsProblem = assertKnownKeys(record.conditions, ['prefix'], []);
    if (conditionsProblem) return conditionsProblem;
    const conditions = record.conditions as Record<string, unknown>;
    if (conditions.prefix !== undefined && typeof conditions.prefix !== 'string') return { detail: 'control_api_malformed_response' };
    prefix = typeof conditions.prefix === 'string' ? conditions.prefix : '';
  }
  let maxAge: number | null = null;
  if (record.deleteObjectsTransition !== undefined) {
    const transitionProblem = assertKnownKeys(record.deleteObjectsTransition, ['condition'], ['condition']);
    if (transitionProblem) return transitionProblem;
    const conditionProblem = assertKnownKeys(
      (record.deleteObjectsTransition as Record<string, unknown>).condition, ['type', 'maxAge'], ['type', 'maxAge']);
    if (conditionProblem) return conditionProblem;
    const condition = (record.deleteObjectsTransition as { condition: Record<string, unknown> }).condition;
    if (condition.type !== 'Age' || !Number.isSafeInteger(condition.maxAge) || Number(condition.maxAge) <= 0) {
      return { detail: 'control_api_malformed_response' };
    }
    maxAge = Number(condition.maxAge);
  }
  return { id: record.id, enabled: record.enabled, prefix, maxAge };
}

function evaluateLifecycle(result: unknown, expected: AttachmentControlDriftExpected): AttachmentDriftFinding[] {
  const problem = assertKnownKeys(result, ['rules'], ['rules']);
  if (problem) {
    return [
      {
        check: 'lifecycle_rules',
        status: problem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
        detail: problem.detail,
      },
      {
        check: 'prefix_drift',
        status: problem.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
        detail: problem.detail,
      },
    ];
  }
  const rules = (result as { rules: unknown }).rules;
  if (!Array.isArray(rules)) {
    return [
      { check: 'lifecycle_rules', status: 'environment', detail: 'control_api_malformed_response' },
      { check: 'prefix_drift', status: 'environment', detail: 'control_api_malformed_response' },
    ];
  }
  const findings: AttachmentDriftFinding[] = [];
  for (const rule of rules) {
    const parsed = parseLifecycleRule(rule);
    if ('detail' in parsed) {
      findings.push({
        check: 'lifecycle_rules',
        status: parsed.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
        detail: parsed.detail,
      });
      findings.push({
        check: 'prefix_drift',
        status: parsed.detail === 'control_contract_drift' ? 'contract_drift' : 'environment',
        detail: parsed.detail,
      });
      continue;
    }
    if (!parsed.enabled || parsed.maxAge === null) continue;
    if (prefixesOverlap(parsed.prefix, expected.quarantinePrefix)) {
      findings.push({ check: 'lifecycle_rules', status: 'drift', detail: 'quarantine_prefix_deletion' });
    }
    if (prefixesOverlap(parsed.prefix, expected.livePrefix)) {
      findings.push({ check: 'prefix_drift', status: 'drift', detail: 'live_prefix_deletion' });
    }
    if (expected.probePrefix.startsWith(parsed.prefix) && parsed.maxAge > expected.probeObjectsMaximumAgeSeconds) {
      findings.push({ check: 'lifecycle_rules', status: 'drift', detail: 'probe_retention_exceeds_max' });
    }
  }
  return findings;
}

export async function detectAttachmentControlDrift(
  input: AttachmentControlDriftInput,
): Promise<AttachmentControlDriftReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = input.token.trim();
  if (token.length === 0) throw new Error('attachment_control_token_missing');
  const base = `/accounts/${encodeURIComponent(input.expected.accountId)}/r2/buckets/${encodeURIComponent(input.expected.bucket)}`;

  const [bucket, managed, custom, lifecycle] = await Promise.all([
    fetchEndpoint(fetchImpl, token, base),
    fetchEndpoint(fetchImpl, token, `${base}/domains/managed`),
    fetchEndpoint(fetchImpl, token, `${base}/domains/custom`),
    fetchEndpoint(fetchImpl, token, `${base}/lifecycle`),
  ]);

  const findings: AttachmentDriftFinding[] = [];
  if (bucket.kind === 'ok') findings.push(...evaluateBucket(bucket.payload, input.expected));
  else findings.push({ check: 'bucket_public_access', status: bucket.status, detail: bucket.detail });
  if (managed.kind === 'ok') findings.push(...evaluateManagedDomain(managed.payload));
  else findings.push({ check: 'managed_domains', status: managed.status, detail: managed.detail });
  if (custom.kind === 'ok') findings.push(...evaluateCustomDomains(custom.payload));
  else findings.push({ check: 'custom_domains', status: custom.status, detail: custom.detail });
  if (lifecycle.kind === 'ok') findings.push(...evaluateLifecycle(lifecycle.payload, input.expected));
  else {
    findings.push({ check: 'lifecycle_rules', status: lifecycle.status, detail: lifecycle.detail });
    findings.push({ check: 'prefix_drift', status: lifecycle.status, detail: lifecycle.detail });
  }

  const driftCount = findings.filter((finding) => finding.status === 'drift').length;
  const environmentCount = findings.filter((finding) => finding.status === 'environment').length;
  const contractDriftCount = findings.filter((finding) => finding.status === 'contract_drift').length;

  let overall: AttachmentControlDriftOverall = 'ok';
  if (contractDriftCount > 0) overall = 'contract_drift';
  else if (driftCount > 0) overall = 'drift';
  else if (environmentCount > 0) overall = 'environment';

  return Object.freeze({
    plane: 'control',
    generatedAtIso: input.nowIso ?? new Date().toISOString(),
    overall,
    findings: Object.freeze(findings),
    driftCount,
    environmentCount,
    contractDriftCount,
    method: 'cloudflare-control-api-live-query',
  });
}

export function classifyAttachmentDataPlaneHealth(input: {
  readonly headClass: AttachmentDataPlaneHealthClass;
  readonly nowIso?: string;
}): {
  readonly plane: 'data';
  readonly status: AttachmentDataPlaneHealthStatus;
  readonly class: AttachmentDataPlaneHealthClass;
  readonly generatedAtIso: string;
} {
  let status: AttachmentDataPlaneHealthStatus;
  switch (input.headClass) {
    case 'ok': status = 'ok'; break;
    case 'denied': status = 'unavailable'; break;
    default: status = 'degraded'; break;
  }
  return Object.freeze({
    plane: 'data',
    status,
    class: input.headClass,
    generatedAtIso: input.nowIso ?? new Date().toISOString(),
  });
}