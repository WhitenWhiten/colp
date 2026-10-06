import { isRfc3339DateTime } from '../shared/date-time.js';
import { principalTypes, samePrincipal, scopeNames } from '../shared/protocol-vocabulary.js';
import type { PrincipalRef, ScopeName } from '../types/index.js';
import {
  assertPlainDataObject,
  nonEmptyString,
  requirePromise,
} from './internal-guards.js';

export type SyncSessionProtocolVersion = '0.1' | '0.2';
export type SyncSessionScope = 'collection' | 'instance';
export type SyncSessionCredentialKind = 'token' | 'key';
export type SyncSessionTerminationReason =
  | 'credential_revoked'
  | 'scope_reduced'
  | 'bootstrap_rejected'
  | 'administrative'
  | 'lease_expired';

export interface SyncSessionCredentialBinding {
  readonly kind: SyncSessionCredentialKind;
  /** Stable, non-secret Token ID or Key ID. Never persist the credential value here. */
  readonly id: string;
}

export interface SyncSessionBinding {
  readonly principal: PrincipalRef;
  readonly credential: SyncSessionCredentialBinding;
  readonly oauthClientId: string | null;
  readonly origin: string | null;
  readonly sessionScope: SyncSessionScope;
  readonly protocolVersion: SyncSessionProtocolVersion;
  readonly collectionId: string | null;
  readonly purpose: 'create_collection' | null;
}

interface SyncSessionRecordBase extends SyncSessionBinding {
  readonly sessionId: string;
  /** Authorization grant captured when the Session was created. */
  readonly authorizationScopes: readonly ScopeName[];
}

export interface ActiveSyncSessionRecord extends SyncSessionRecordBase {
  readonly status: 'active';
  /**
   * Optional lease expiry as an RFC 3339 date-time.
   * When present, `verifySyncSessionContext` durably terminates the Session with
   * `lease_expired` once server time (`terminatedAt` on the verify input) is at or
   * after this instant. Omitted for backward-compatible non-leased Sessions.
   */
  readonly expiresAt?: string;
}

export interface TerminatedSyncSessionRecord extends SyncSessionRecordBase {
  readonly status: 'terminated';
  readonly terminationReason: SyncSessionTerminationReason;
  readonly terminatedAt: string;
  /** Preserved lease expiry from the active Session, when one was set. */
  readonly expiresAt?: string;
}

export type SyncSessionRecord = ActiveSyncSessionRecord | TerminatedSyncSessionRecord;

export interface CreateSyncSessionInput extends SyncSessionBinding {
  readonly sessionId: string;
  readonly authorizationScopes: readonly ScopeName[];
  /** Optional RFC 3339 lease expiry; see {@link ActiveSyncSessionRecord.expiresAt}. */
  readonly expiresAt?: string;
}

export type SyncSessionStoreCreateResult =
  | { readonly state: 'created'; readonly session: SyncSessionRecord }
  | { readonly state: 'conflict'; readonly session: SyncSessionRecord };

export interface SyncSessionTermination {
  readonly sessionId: string;
  readonly reason: SyncSessionTerminationReason;
  readonly terminatedAt: string;
}

/**
 * Durable Sync Session storage port.
 *
 * A server adapter must enforce globally unique sessionId values, make committed
 * writes visible across server processes, and make terminate atomic and
 * irreversible. Repeated terminate calls must preserve the first termination
 * reason and timestamp. This package intentionally provides no in-memory
 * implementation because an in-process map cannot provide those guarantees.
 */
export interface SyncSessionStore {
  create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult>;
  load(sessionId: string): Promise<SyncSessionRecord | undefined>;
  terminate(termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined>;
}

export interface SyncSessionAuthorizationContext {
  readonly credentialActive: boolean;
  readonly authorizationScopes: readonly ScopeName[];
}

export interface VerifySyncSessionContextInput {
  readonly sessionId: string;
  readonly binding: SyncSessionBinding;
  readonly authorization: SyncSessionAuthorizationContext;
  /**
   * Current canonical server time (RFC 3339). It is the "now" a lease is
   * compared against, and it becomes the stored termination time if this
   * verification terminates the Session — hence the name.
   */
  readonly terminatedAt: string;
}

export type SyncSessionVerificationResult =
  | { readonly state: 'active'; readonly session: ActiveSyncSessionRecord }
  | { readonly state: 'not_found' }
  | { readonly state: 'context_mismatch' }
  | { readonly state: 'terminated'; readonly session: TerminatedSyncSessionRecord };

const bindingKeys = new Set([
  'principal',
  'credential',
  'oauthClientId',
  'origin',
  'sessionScope',
  'protocolVersion',
  'collectionId',
  'purpose',
]);

function assertObject(value: unknown, label: string): asserts value is object {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${label} must be an object.`);
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function immutablePrincipal(value: unknown): PrincipalRef {
  assertObject(value, 'Sync Session principal');
  assertPlainDataObject(value, new Set(['type', 'id']), 'Sync Session principal');
  if (!principalTypes.has((value as PrincipalRef).type)) {
    throw new TypeError('Sync Session principal has an invalid type.');
  }
  return Object.freeze({
    type: (value as PrincipalRef).type,
    id: nonEmptyString((value as PrincipalRef).id, 'Sync Session principal id'),
  });
}

function immutableCredential(value: unknown): SyncSessionCredentialBinding {
  assertObject(value, 'Sync Session credential binding');
  assertPlainDataObject(value, new Set(['kind', 'id']), 'Sync Session credential binding');
  const kind = (value as SyncSessionCredentialBinding).kind;
  if (kind !== 'token' && kind !== 'key') {
    throw new TypeError('Sync Session credential kind must be token or key.');
  }
  return Object.freeze({
    kind,
    id: nonEmptyString((value as SyncSessionCredentialBinding).id, 'Sync Session credential id'),
  });
}

function immutableScopes(value: unknown, label: string): readonly ScopeName[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const unique = new Set<ScopeName>();
  for (const scope of value as unknown[]) {
    if (typeof scope !== 'string' || !scopeNames.has(scope as ScopeName)) {
      throw new TypeError(`${label} contains an invalid Scope.`);
    }
    if (unique.has(scope as ScopeName)) throw new TypeError(`${label} contains a duplicate Scope.`);
    unique.add(scope as ScopeName);
  }
  return Object.freeze([...unique].sort()) as readonly ScopeName[];
}

function immutableBinding(value: unknown): SyncSessionBinding {
  assertObject(value, 'Sync Session binding');
  assertPlainDataObject(value, bindingKeys, 'Sync Session binding');
  const candidate = value as SyncSessionBinding;
  if (candidate.protocolVersion !== '0.1' && candidate.protocolVersion !== '0.2') {
    throw new TypeError('Sync Session protocolVersion must be 0.1 or 0.2.');
  }
  if (candidate.sessionScope !== 'collection' && candidate.sessionScope !== 'instance') {
    throw new TypeError('Sync Session scope must be collection or instance.');
  }
  const collectionId = nullableString(candidate.collectionId, 'Sync Session collectionId');
  if (candidate.sessionScope === 'collection') {
    if (collectionId === null || candidate.purpose !== null) {
      throw new TypeError('A collection-scoped Sync Session must bind one Collection and have no purpose.');
    }
  } else if (collectionId !== null || candidate.purpose !== 'create_collection') {
    throw new TypeError(
      'An unbound instance-scoped Sync Session is allowed only for create_collection bootstrap.',
    );
  }
  return Object.freeze({
    principal: immutablePrincipal(candidate.principal),
    credential: immutableCredential(candidate.credential),
    oauthClientId: nullableString(candidate.oauthClientId, 'Sync Session OAuth Client id'),
    origin: nullableString(candidate.origin, 'Sync Session Origin'),
    sessionScope: candidate.sessionScope,
    protocolVersion: candidate.protocolVersion,
    collectionId,
    purpose: candidate.purpose,
  });
}

function bindingData(candidate: SyncSessionBinding): SyncSessionBinding {
  return {
    principal: candidate.principal,
    credential: candidate.credential,
    oauthClientId: candidate.oauthClientId,
    origin: candidate.origin,
    sessionScope: candidate.sessionScope,
    protocolVersion: candidate.protocolVersion,
    collectionId: candidate.collectionId,
    purpose: candidate.purpose,
  };
}

const terminationReasons: ReadonlySet<unknown> = new Set<SyncSessionTerminationReason>([
  'credential_revoked', 'scope_reduced', 'bootstrap_rejected', 'administrative', 'lease_expired',
]);

/** RFC 3339 date-time with a mandatory offset — the contract `expiresAt` already uses. */
function rfc3339Timestamp(value: unknown, label: string): string {
  const timestamp = nonEmptyString(value, label);
  if (!isRfc3339DateTime(timestamp)) {
    throw new TypeError(`${label} must be an RFC 3339 date-time.`);
  }
  return timestamp;
}

function optionalExpiresAt(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : rfc3339Timestamp(value, label);
}

function immutableActiveShape(candidate: CreateSyncSessionInput): ActiveSyncSessionRecord {
  const binding = immutableBinding(bindingData(candidate));
  const authorizationScopes = immutableScopes(
    candidate.authorizationScopes,
    'Sync Session authorizationScopes',
  );
  if (binding.sessionScope === 'instance') {
    const scopes = new Set(authorizationScopes);
    if (
      !scopes.has('sync:bootstrap')
      || !scopes.has('sync:push')
      || !scopes.has('collections:create')
    ) {
      throw new TypeError(
        'An instance-scoped Sync Session requires sync:bootstrap, sync:push, and collections:create.',
      );
    }
  }
  const expiresAt = optionalExpiresAt(
    (candidate as { readonly expiresAt?: unknown }).expiresAt,
    'Sync Session expiresAt',
  );
  return Object.freeze({
    sessionId: nonEmptyString(candidate.sessionId, 'Sync Session id'),
    ...binding,
    authorizationScopes,
    status: 'active' as const,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

function immutableActiveInput(value: unknown): ActiveSyncSessionRecord {
  assertObject(value, 'Sync Session create input');
  assertPlainDataObject(
    value,
    new Set([...bindingKeys, 'sessionId', 'authorizationScopes', 'expiresAt']),
    'Sync Session create input',
  );
  return immutableActiveShape(value as CreateSyncSessionInput);
}

function immutableRecord(value: unknown): SyncSessionRecord {
  assertObject(value, 'Stored Sync Session');
  const candidate = value as SyncSessionRecord;
  if (candidate.status === 'active') {
    assertPlainDataObject(
      value,
      new Set([...bindingKeys, 'sessionId', 'authorizationScopes', 'status', 'expiresAt']),
      'Stored Sync Session',
    );
    return immutableActiveShape(candidate);
  }
  if (candidate.status !== 'terminated') {
    throw new TypeError('Stored Sync Session has an invalid status.');
  }
  assertPlainDataObject(
    value,
    new Set([
      ...bindingKeys,
      'sessionId',
      'authorizationScopes',
      'status',
      'terminationReason',
      'terminatedAt',
      'expiresAt',
    ]),
    'Stored Sync Session',
  );
  const reason = candidate.terminationReason;
  if (!terminationReasons.has(reason)) {
    throw new TypeError('Stored Sync Session has an invalid termination reason.');
  }
  const activeShape = immutableActiveShape(candidate);
  return Object.freeze({
    ...activeShape,
    status: 'terminated' as const,
    terminationReason: reason,
    // Malformed historical values fail closed on read: the Session stays
    // unusable, and the store must be repaired rather than trusted.
    terminatedAt: rfc3339Timestamp(candidate.terminatedAt, 'Stored Sync Session terminatedAt'),
  });
}

function sameBinding(left: SyncSessionBinding, right: SyncSessionBinding): boolean {
  return samePrincipal(left.principal, right.principal)
    && left.credential.kind === right.credential.kind
    && left.credential.id === right.credential.id
    && left.oauthClientId === right.oauthClientId
    && left.origin === right.origin
    && left.sessionScope === right.sessionScope
    && left.protocolVersion === right.protocolVersion
    && left.collectionId === right.collectionId
    && left.purpose === right.purpose;
}

function sameScopes(left: readonly ScopeName[], right: readonly ScopeName[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function sameRecordBinding(left: SyncSessionRecord, right: SyncSessionRecord): boolean {
  return left.sessionId === right.sessionId
    && sameBinding(left, right)
    && sameScopes(left.authorizationScopes, right.authorizationScopes)
    && left.expiresAt === right.expiresAt;
}

function immutableCreateResult(value: unknown): SyncSessionStoreCreateResult {
  assertObject(value, 'Sync Session store create result');
  assertPlainDataObject(value, new Set(['state', 'session']), 'Sync Session store create result');
  const candidate = value as SyncSessionStoreCreateResult;
  if (candidate.state !== 'created' && candidate.state !== 'conflict') {
    throw new TypeError('Sync Session store returned an invalid create state.');
  }
  return Object.freeze({ state: candidate.state, session: immutableRecord(candidate.session) });
}

function immutableTermination(value: unknown): SyncSessionTermination {
  assertObject(value, 'Sync Session termination');
  assertPlainDataObject(
    value,
    new Set(['sessionId', 'reason', 'terminatedAt']),
    'Sync Session termination',
  );
  const candidate = value as SyncSessionTermination;
  if (!terminationReasons.has(candidate.reason)) {
    throw new TypeError('Sync Session termination has an invalid reason.');
  }
  return Object.freeze({
    sessionId: nonEmptyString(candidate.sessionId, 'Sync Session id'),
    reason: candidate.reason,
    terminatedAt: rfc3339Timestamp(candidate.terminatedAt, 'Sync Session terminatedAt'),
  });
}

export class SyncSessionAlreadyExistsError extends Error {
  public constructor(sessionId: string) {
    super(`Sync Session ${sessionId} already exists.`);
    this.name = 'SyncSessionAlreadyExistsError';
  }
}

/** Creates and reads back a durable immutable Session binding. */
export async function createSyncSession(
  store: SyncSessionStore,
  candidate: CreateSyncSessionInput,
): Promise<SyncSessionRecord> {
  const session = immutableActiveInput(candidate);
  const result = immutableCreateResult(await requirePromise(
    store.create(structuredClone(session) as ActiveSyncSessionRecord),
    'Sync Session store create',
  ));
  if (result.state === 'conflict') {
    if (result.session.sessionId !== session.sessionId) {
      throw new TypeError('Sync Session store returned a conflict for a different Session id.');
    }
    throw new SyncSessionAlreadyExistsError(session.sessionId);
  }
  if (!sameRecordBinding(result.session, session)) {
    throw new TypeError('Sync Session store returned a different binding from the create request.');
  }

  const reloadedRaw = await requirePromise(store.load(session.sessionId), 'Sync Session store read-back');
  if (reloadedRaw === undefined) {
    throw new TypeError('Created Sync Session could not be reloaded from durable storage.');
  }
  const reloaded = immutableRecord(reloadedRaw);
  if (!sameRecordBinding(reloaded, session)) {
    throw new TypeError('Created Sync Session failed durable read-back verification.');
  }
  return reloaded;
}

/**
 * Irreversibly terminates a Session and verifies the persisted result. The
 * adapter must preserve an earlier termination if another process won a race.
 */
export async function terminateSyncSession(
  store: SyncSessionStore,
  candidate: SyncSessionTermination,
): Promise<SyncSessionRecord | undefined> {
  const termination = immutableTermination(candidate);
  const storedRaw = await requirePromise(
    store.terminate(structuredClone(termination) as SyncSessionTermination),
    'Sync Session store terminate',
  );
  if (storedRaw === undefined) return undefined;
  const stored = immutableRecord(storedRaw);
  if (stored.sessionId !== termination.sessionId || stored.status !== 'terminated') {
    throw new TypeError('Sync Session store did not return the terminated Session.');
  }

  const reloadedRaw = await requirePromise(store.load(termination.sessionId), 'Sync Session termination read-back');
  if (reloadedRaw === undefined) {
    throw new TypeError('Terminated Sync Session could not be reloaded from durable storage.');
  }
  const reloaded = immutableRecord(reloadedRaw);
  if (
    reloaded.status !== 'terminated'
    || !sameRecordBinding(reloaded, stored)
    || reloaded.terminationReason !== stored.terminationReason
    || reloaded.terminatedAt !== stored.terminatedAt
  ) {
    throw new TypeError('Sync Session termination failed durable read-back verification.');
  }
  return reloaded;
}

function immutableVerificationInput(value: unknown): VerifySyncSessionContextInput {
  assertObject(value, 'Sync Session verification input');
  assertPlainDataObject(
    value,
    new Set(['sessionId', 'binding', 'authorization', 'terminatedAt']),
    'Sync Session verification input',
  );
  const candidate = value as VerifySyncSessionContextInput;
  assertObject(candidate.authorization, 'Sync Session authorization context');
  assertPlainDataObject(
    candidate.authorization,
    new Set(['credentialActive', 'authorizationScopes']),
    'Sync Session authorization context',
  );
  if (typeof candidate.authorization.credentialActive !== 'boolean') {
    throw new TypeError('Sync Session credentialActive must be a boolean.');
  }
  return Object.freeze({
    sessionId: nonEmptyString(candidate.sessionId, 'Sync Session id'),
    binding: immutableBinding(candidate.binding),
    authorization: Object.freeze({
      credentialActive: candidate.authorization.credentialActive,
      authorizationScopes: immutableScopes(
        candidate.authorization.authorizationScopes,
        'Current Sync Session authorizationScopes',
      ),
    }),
    // Validated before any store access: it may become a durable termination time.
    terminatedAt: rfc3339Timestamp(candidate.terminatedAt, 'Sync Session terminatedAt'),
  });
}

/**
 * Verifies every bound context dimension before Session use. Credential
 * revocation and loss of any initially granted Scope terminate durably before
 * this function returns. Call this gate for every subsequent Session request.
 *
 * This gate is intentionally not embedded in Push/Pull/Sequence coordinators
 * Hosts should call it first, or use the session-bound helpers in
 * `composition.ts`.
 */
export async function verifySyncSessionContext(
  store: SyncSessionStore,
  candidate: VerifySyncSessionContextInput,
): Promise<SyncSessionVerificationResult> {
  const input = immutableVerificationInput(candidate);
  const raw = await requirePromise(store.load(input.sessionId), 'Sync Session store load');
  if (raw === undefined) return Object.freeze({ state: 'not_found' as const });
  const session = immutableRecord(raw);
  if (!sameBinding(session, input.binding)) {
    return Object.freeze({ state: 'context_mismatch' as const });
  }
  if (session.status === 'terminated') {
    return Object.freeze({ state: 'terminated' as const, session });
  }

  const currentScopes = new Set(input.authorization.authorizationScopes);
  let reason: SyncSessionTerminationReason | undefined = !input.authorization.credentialActive
    ? 'credential_revoked'
    : session.authorizationScopes.some((scope) => !currentScopes.has(scope))
      ? 'scope_reduced'
      : undefined;
  if (reason === undefined && session.expiresAt !== undefined) {
    const expiresMs = Date.parse(session.expiresAt);
    const nowMs = Date.parse(input.terminatedAt);
    if (!Number.isFinite(expiresMs)) {
      throw new TypeError('Stored Sync Session expiresAt is not a representable instant.');
    }
    if (!Number.isFinite(nowMs)) {
      throw new TypeError('Sync Session terminatedAt must be a representable instant for lease checks.');
    }
    if (nowMs >= expiresMs) {
      reason = 'lease_expired';
    }
  }
  if (reason !== undefined) {
    const terminated = await terminateSyncSession(store, {
      sessionId: session.sessionId,
      reason,
      terminatedAt: input.terminatedAt,
    });
    if (terminated === undefined || terminated.status !== 'terminated') {
      throw new TypeError(
        reason === 'lease_expired'
          ? 'Session lease expiry did not durably terminate the Sync Session.'
          : 'Authorization loss did not durably terminate the Sync Session.',
      );
    }
    if (!sameRecordBinding(terminated, session)) {
      throw new TypeError('Sync Session store changed the binding while terminating the Session.');
    }
    return Object.freeze({ state: 'terminated' as const, session: terminated });
  }
  // Keep provenance on the exact result object.  The result is the output of
  // the durable verification gate, so an assertion may only mint the stronger
  // runtime Session brand from this identity.  A structurally compatible object
  // supplied by a host or an untrusted adapter must fail closed.
  const verified = Object.freeze({ state: 'active' as const, session });
  verifiedVerificationResults.add(verified);
  return verified;
}

/**
 * Compile-time brand for package-minted verified Sessions.
 *
 * Runtime membership is a process-local WeakSet of minted object identities.
 * An enumerable unique-symbol own property would be copied by `{ ...verified }`,
 * so it is intentionally not stored on the object.
 */
declare const verifiedSyncSessionBrand: unique symbol;

/**
 * Identities minted by {@link mintVerifiedSyncSession}. Spread copies, plain
 * active records, and `status === 'active'` lookalikes are not members.
 */
const verifiedSessions = new WeakSet<object>();
/** Results emitted by verifySyncSessionContext (the only minting provenance). */
const verifiedVerificationResults = new WeakSet<object>();

/**
 * Branded active Session produced only from a successful
 * `verifySyncSessionContext` result (or {@link assertVerifiedSyncSession}).
 *
 * Do not cast plain session records to this type: that bypasses the durable
 * credential/scope termination gate. Runtime checks use {@link isVerifiedSyncSession}.
 */
export type VerifiedSyncSession = ActiveSyncSessionRecord & {
  readonly [verifiedSyncSessionBrand]: true;
};

function mintVerifiedSyncSession(session: ActiveSyncSessionRecord): VerifiedSyncSession {
  const frozen = Object.freeze({ ...session }) as VerifiedSyncSession;
  verifiedSessions.add(frozen);
  return frozen;
}

/**
 * True only for package-minted {@link VerifiedSyncSession} values (runtime brand).
 *
 * Membership is object identity in {@link verifiedSessions}, not a copyable
 * own property. `{ ...verified }` therefore fails closed.
 */
export function isVerifiedSyncSession(value: unknown): value is VerifiedSyncSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly status?: unknown };
  return verifiedSessions.has(candidate) && candidate.status === 'active';
}

export type SyncSessionGateDenialState = Exclude<
  SyncSessionVerificationResult['state'],
  'active'
>;

export type SyncSessionGateDenial =
  | { readonly state: 'not_found' }
  | { readonly state: 'context_mismatch' }
  | {
      readonly state: 'terminated';
      readonly session: TerminatedSyncSessionRecord;
    }
  | { readonly state: 'scope_missing'; readonly requiredScope: 'sync:push' | 'sync:pull' | 'sync:bootstrap' }
  | { readonly state: 'request_binding_mismatch'; readonly detail: string };

/**
 * Fail-closed denial when Session verification or request binding fails before a
 * bare coordinator runs.
 */
export class SyncSessionGateDeniedError extends Error {
  public readonly denial: SyncSessionGateDenial;

  public constructor(denial: SyncSessionGateDenial) {
    super(`Sync Session gate denied: ${denial.state}`);
    this.name = 'SyncSessionGateDeniedError';
    this.denial = Object.freeze({ ...denial }) as SyncSessionGateDenial;
  }
}

/**
 * Brands a successful verification result. Throws {@link SyncSessionGateDeniedError}
 * for every non-active outcome.
 */
export function assertVerifiedSyncSession(
  result: SyncSessionVerificationResult,
): VerifiedSyncSession {
  if (result.state !== 'active') {
    if (result.state === 'terminated') {
      throw new SyncSessionGateDeniedError({ state: 'terminated', session: result.session });
    }
    throw new SyncSessionGateDeniedError({ state: result.state });
  }
  if (typeof result !== 'object' || result === null || !verifiedVerificationResults.has(result)) {
    throw new SyncSessionGateDeniedError({ state: 'context_mismatch' });
  }
  return mintVerifiedSyncSession(result.session);
}

/**
 * Convenience: run `verifySyncSessionContext` and brand the active Session, or
 * throw {@link SyncSessionGateDeniedError}.
 */
export async function requireVerifiedSyncSession(
  store: SyncSessionStore,
  input: VerifySyncSessionContextInput,
): Promise<VerifiedSyncSession> {
  return assertVerifiedSyncSession(await verifySyncSessionContext(store, input));
}
