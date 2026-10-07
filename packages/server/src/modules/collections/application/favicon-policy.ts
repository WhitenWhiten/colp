import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { CollectionPreconditionError } from '../domain/index.js';
import {
  insertPolicyBatchJob,
  type FaviconPolicyBatchJobCommandPorts,
} from './favicon-batch-job.js';
import { faviconPolicyBatchTrigger } from './favicon-batch-policy.js';

export const FAVICON_POLICY_COMMAND_CONTRACT_VERSION = '1.0.0';
export const FAVICON_POLICY_COMMAND_SCOPE = 'collections:favicon-policy:v1';
export const FAVICON_POLICY_ROUTE = '/api/v1/me/favicon-policy';
export const DEFAULT_FAVICON_PROVIDER_TEMPLATE = 'https://favicone.com/{hostname}';
/** Virtual default revision before the first CAS write (wire `singletonInitialization`). */
export const INITIAL_FAVICON_POLICY_REVISION = 1n;
/** Entity-tag scope prefix shared by the GET and PATCH operations. */
export const FAVICON_POLICY_ETAG_SCOPE = 'favicon-policy';
/** Contract Revision pattern: 1..19 decimal digits, no leading zero. */
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;

export type FaviconPolicyMode = 'capture' | 'online' | 'none';

/** The account-scoped policy authority value (stored row or virtual default). */
export interface FaviconPolicyRow {
  readonly accountId: string;
  readonly newDefault: FaviconPolicyMode;
  readonly providerTemplate: string;
  readonly fillMissing: boolean;
  readonly forceAllOnline: boolean;
  readonly revision: bigint;
  readonly updatedAt: Date;
}

export interface FaviconPolicyReadPort {
  findByAccountId(accountId: string): Promise<FaviconPolicyRow | null>;
}

export interface FaviconPolicyWritePort extends FaviconPolicyReadPort {
  /**
   * CAS write. `expectedRevision` fences the stored revision; a concurrent
   * write returns `stale` with the current revision. Insert form is used by
   * the first write (virtual revision 1 -> 2).
   */
  update(input: {
    readonly accountId: string;
    readonly newDefault: FaviconPolicyMode;
    readonly providerTemplate: string;
    readonly fillMissing: boolean;
    readonly forceAllOnline: boolean;
    readonly expectedRevision: bigint;
    readonly updatedAt: Date;
  }): Promise<{ readonly kind: 'updated'; readonly row: FaviconPolicyRow }
    | { readonly kind: 'stale'; readonly currentRevision: bigint }>;
}

export interface FaviconPolicyQueryPorts {
  readonly policies: FaviconPolicyReadPort;
}

export interface FaviconPolicyCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: { now(): Promise<Date> };
  readonly policies: FaviconPolicyWritePort;
  /** FO-03 batch job + item persistence (policy change → durable reconcile job). */
  readonly batchJobs: FaviconPolicyBatchJobCommandPorts;
}

export class FaviconPolicyCommandError extends Error {
  constructor(readonly code: 'invalid_request', message: string) {
    super(message);
    this.name = 'FaviconPolicyCommandError';
  }
}

/**
 * FO-03 writable patch: any non-empty subset of the icon policy fields.
 * FO-01 allowed only newDefault capture/none; online / providerTemplate /
 * fillMissing / forceAllOnline become writable in FO-03.
 */
export interface FaviconPolicyPatch {
  readonly newDefault?: FaviconPolicyMode;
  readonly providerTemplate?: string;
  readonly fillMissing?: boolean;
  readonly forceAllOnline?: boolean;
}

export interface GetMyFaviconPolicyInput {
  readonly principalId: string;
  /** Stable source of the virtual `updatedAt` before the first write. */
  readonly virtualUpdatedAt: Date;
}

export interface UpdateMyFaviconPolicyInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly expectedEtag: string;
  readonly patch: FaviconPolicyPatch;
  /**
   * Stable source of the virtual `updatedAt` before the first write
   * (contract `singletonInitialization`): the account creation time, never
   * request time. Route layers that load the account must pass
   * `account.createdAt`; absent (legacy/double callers) falls back to the
   * clock, preserving the pre-fix behavior.
   */
  readonly virtualUpdatedAt?: Date;
}

export interface FaviconPolicyDto {
  readonly revision: string;
  readonly newDefault: FaviconPolicyMode;
  readonly providerTemplate: string;
  readonly fillMissing: boolean;
  readonly forceAllOnline: boolean;
  readonly updatedAt: string;
}

export interface PolicyResultDto {
  readonly policy: FaviconPolicyDto;
  readonly jobId: string | null;
}

export type UpdateFaviconPolicyReceiptOutcome =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export type UpdateFaviconPolicyResult =
  | { readonly kind: 'succeeded'; readonly policy: FaviconPolicyRow; readonly changed: boolean; readonly jobId: string | null }
  | UpdateFaviconPolicyReceiptOutcome;

export function faviconPolicyEtag(revision: bigint): string {
  return `"${FAVICON_POLICY_ETAG_SCOPE}:${revision.toString()}"`;
}

/** Parse a policy ETag of the exact form `"favicon-policy:<decimal>"`. */
export function parseFaviconPolicyEtag(etag: string): bigint | null {
  const prefix = `"${FAVICON_POLICY_ETAG_SCOPE}:`;
  if (!etag.startsWith(prefix) || !etag.endsWith('"')) return null;
  const revision = etag.slice(prefix.length, -1);
  if (!REVISION_PATTERN.test(revision)) return null;
  const value = BigInt(revision);
  return value >= 1n ? value : null;
}

const PROVIDER_TEMPLATE_PATTERN =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::443)?\/[^?#\s{}]*\{hostname\}[^?#\s{}]*(?:\?[^#\s{}]*)?$/u;

/**
 * FO-03 strict request parsing: a non-empty subset of
 * {newDefault, providerTemplate, fillMissing, forceAllOnline}; no null, no
 * unknown keys, `additionalProperties: false`. The providerTemplate must
 * match the frozen contract pattern (exactly one `{hostname}` in the path,
 * HTTPS DNS host, port omitted or 443, no userinfo/fragment); the pattern is
 * a syntax gate — hardened egress revalidates at fetch time.
 */
export function parseFaviconPolicyPatch(value: unknown): FaviconPolicyPatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FaviconPolicyCommandError('invalid_request', 'The favicon policy patch must be a JSON object.');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  const allowed = new Set(['newDefault', 'providerTemplate', 'fillMissing', 'forceAllOnline']);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new FaviconPolicyCommandError('invalid_request', `The favicon policy patch does not accept "${key}".`);
    }
  }
  if (keys.length === 0) {
    throw new FaviconPolicyCommandError('invalid_request', 'The favicon policy patch must contain at least one field.');
  }
  const patch: Record<string, unknown> = {};
  if (body.newDefault !== undefined) {
    if (body.newDefault !== 'capture' && body.newDefault !== 'online' && body.newDefault !== 'none') {
      throw new FaviconPolicyCommandError(
        'invalid_request',
        'newDefault must be exactly "capture", "online" or "none".',
      );
    }
    patch.newDefault = body.newDefault;
  }
  if (body.providerTemplate !== undefined) {
    if (typeof body.providerTemplate !== 'string' || body.providerTemplate.length < 1
        || body.providerTemplate.length > 2048
        || !PROVIDER_TEMPLATE_PATTERN.test(body.providerTemplate)) {
      throw new FaviconPolicyCommandError(
        'invalid_request',
        'providerTemplate must be an HTTPS provider URL with exactly one {hostname} in the path.',
      );
    }
    patch.providerTemplate = body.providerTemplate;
  }
  if (body.fillMissing !== undefined) {
    if (typeof body.fillMissing !== 'boolean') {
      throw new FaviconPolicyCommandError('invalid_request', 'fillMissing must be a boolean.');
    }
    patch.fillMissing = body.fillMissing;
  }
  if (body.forceAllOnline !== undefined) {
    if (typeof body.forceAllOnline !== 'boolean') {
      throw new FaviconPolicyCommandError('invalid_request', 'forceAllOnline must be a boolean.');
    }
    patch.forceAllOnline = body.forceAllOnline;
  }
  return patch as FaviconPolicyPatch;
}

export function faviconPolicyFingerprint(patch: FaviconPolicyPatch): string {
  return canonicalCommandFingerprint({
    method: 'PATCH',
    route: FAVICON_POLICY_ROUTE,
    mediaType: 'application/json',
    body: canonicalJson(patch),
  });
}

/** Virtual defaults before any stored row (wire `singletonInitialization`). */
export function virtualFaviconPolicy(accountId: string, updatedAt: Date): FaviconPolicyRow {
  return {
    accountId,
    newDefault: 'capture',
    providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
    fillMissing: false,
    forceAllOnline: false,
    revision: INITIAL_FAVICON_POLICY_REVISION,
    updatedAt,
  };
}

export function toFaviconPolicyDto(row: FaviconPolicyRow): FaviconPolicyDto {
  return {
    revision: row.revision.toString(),
    newDefault: row.newDefault,
    providerTemplate: row.providerTemplate,
    fillMissing: row.fillMissing,
    forceAllOnline: row.forceAllOnline,
    updatedAt: formatPolicyTimestamp(row.updatedAt),
  };
}

export function toPolicyResultDto(policy: FaviconPolicyDto, jobId: string | null = null): PolicyResultDto {
  return { policy, jobId };
}

export function formatPolicyTimestamp(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new FaviconPolicyCommandError('invalid_request', 'The policy timestamp is invalid.');
  }
  return date.toISOString();
}

export async function getMyFaviconPolicy(
  ports: FaviconPolicyQueryPorts,
  input: GetMyFaviconPolicyInput,
): Promise<FaviconPolicyRow> {
  const stored = await ports.policies.findByAccountId(input.principalId);
  if (stored !== null) return stored;
  return virtualFaviconPolicy(input.principalId, input.virtualUpdatedAt);
}

export async function updateMyFaviconPolicy(
  ports: FaviconPolicyCommandPorts,
  input: UpdateMyFaviconPolicyInput,
): Promise<UpdateFaviconPolicyResult> {
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(input.commandId);
  } catch {
    throw new FaviconPolicyCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  const expectedRevision = parseFaviconPolicyEtag(input.expectedEtag);
  if (expectedRevision === null) {
    throw new FaviconPolicyCommandError(
      'invalid_request',
      'If-Match must be a strong favicon-policy entity-tag.',
    );
  }
  const fingerprint = faviconPolicyFingerprint(input.patch);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: FAVICON_POLICY_COMMAND_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapPolicyClaim(claim);

  const stored = await ports.policies.findByAccountId(input.actor.principalId);
  // Contract singletonInitialization: the virtual policy updatedAt is the
  // stable account creation time (threaded by the route), never request time.
  const current = stored ?? virtualFaviconPolicy(
    input.actor.principalId,
    input.virtualUpdatedAt ?? await ports.clock.now(),
  );
  if (current.revision !== expectedRevision) {
    throw new CollectionPreconditionError({
      currentEtag: faviconPolicyEtag(current.revision),
      precondition: 'resource',
      message: 'The favicon policy ETag does not match the current representation.',
    });
  }

  const merged = mergeFaviconPolicyPatch(current, input.patch);
  if (policyPatchIsNoop(current, merged)) {
    await ports.receipts.complete(binding, fingerprint, policyProductResult(current, null));
    return { kind: 'succeeded', policy: current, changed: false, jobId: null };
  }

  const now = await ports.clock.now();
  const written = await ports.policies.update({
    accountId: input.actor.principalId,
    newDefault: merged.newDefault,
    providerTemplate: merged.providerTemplate,
    fillMissing: merged.fillMissing,
    forceAllOnline: merged.forceAllOnline,
    expectedRevision,
    updatedAt: now,
  });
  if (written.kind === 'stale') {
    throw new CollectionPreconditionError({
      currentEtag: faviconPolicyEtag(written.currentRevision),
      precondition: 'resource',
      message: 'The favicon policy ETag does not match the current representation.',
    });
  }

  // FO-03: a policy change that activates a batch behavior creates the durable
  // reconcile job in the SAME transaction as the policy write and the receipt.
  const trigger = faviconPolicyBatchTrigger(current, input.patch);
  let jobId: string | null = null;
  if (trigger !== null) {
    jobId = await insertPolicyBatchJob(ports.batchJobs, {
      accountId: input.actor.principalId,
      subjectId: input.actor.subjectId,
      policy: written.row,
      operation: trigger,
      now,
    });
  }
  await ports.receipts.complete(binding, fingerprint, policyProductResult(written.row, jobId));
  return { kind: 'succeeded', policy: written.row, changed: true, jobId };
}

/** Apply a patch onto the current row (absent fields keep the current value). */
export function mergeFaviconPolicyPatch(
  current: FaviconPolicyRow,
  patch: FaviconPolicyPatch,
): {
  readonly newDefault: FaviconPolicyMode;
  readonly providerTemplate: string;
  readonly fillMissing: boolean;
  readonly forceAllOnline: boolean;
} {
  return {
    newDefault: patch.newDefault ?? current.newDefault,
    providerTemplate: patch.providerTemplate ?? current.providerTemplate,
    fillMissing: patch.fillMissing ?? current.fillMissing,
    forceAllOnline: patch.forceAllOnline ?? current.forceAllOnline,
  };
}

export function policyPatchIsNoop(
  current: FaviconPolicyRow,
  merged: {
    readonly newDefault: FaviconPolicyMode;
    readonly providerTemplate: string;
    readonly fillMissing: boolean;
    readonly forceAllOnline: boolean;
  },
): boolean {
  return merged.newDefault === current.newDefault
    && merged.providerTemplate === current.providerTemplate
    && merged.fillMissing === current.fillMissing
    && merged.forceAllOnline === current.forceAllOnline;
}

function policyProductResult(row: FaviconPolicyRow, jobId: string | null): ProductCommandResult {
  const body = JSON.stringify(toPolicyResultDto(toFaviconPolicyDto(row), jobId));
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      'etag': faviconPolicyEtag(row.revision),
    },
    mediaType: 'application/json',
    contractVersion: FAVICON_POLICY_COMMAND_CONTRACT_VERSION,
    targetIdentity: row.accountId,
  };
}

function mapPolicyClaim(
  claim: Exclude<ProductCommandClaim, { kind: 'claimed' }>,
): UpdateFaviconPolicyResult {
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

export function mapFaviconPolicyCommandError(
  error: unknown,
): FaviconPolicyCommandError | CollectionPreconditionError | null {
  if (error instanceof FaviconPolicyCommandError) return error;
  if (error instanceof CollectionPreconditionError) return error;
  return null;
}