import { importJWK, jwtVerify, decodeProtectedHeader, type JWK, type JWTPayload } from 'jose';
import { AccountCredentialCommandError } from './errors.js';
import { hashAccountCredentialSecret, parseAccountCredentialSecret } from './secret.js';
import { effectiveCredentialState } from './dto.js';
import {
  ACCOUNT_KEY_CLOCK_SKEW_SECONDS,
  ancestorEpochDigest,
  machineCredentialBindingId,
  type AccountCredentialsEs256PublicJwk,
} from './token.js';
import type {
  AccountCredentialAccountPorts,
  AccountCredentialClock,
  AccountCredentialRecord,
  AccountCredentialStore,
} from './types.js';

export interface CredentialAuthoritySnapshot {
  readonly credential: AccountCredentialRecord;
  readonly account: {
    readonly id: string;
    readonly subjectId: string;
    readonly status: string;
    readonly securityEpoch: bigint;
  };
  readonly ancestorsRootFirst: readonly AccountCredentialRecord[];
  readonly ancestorEpoch: string;
}

export interface AccountKeyJwtClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
  readonly scope: string;
  readonly scopes: readonly string[];
  readonly known_credential_id: string;
  readonly known_account_epoch: string;
  readonly known_credential_epoch: string;
  readonly known_ancestor_epoch: string;
  readonly client_id: string;
  readonly kid: string;
}

export async function authenticateChildKey(
  ports: { readonly credentials: AccountCredentialStore; readonly clock: AccountCredentialClock; readonly accounts: AccountCredentialAccountPorts; readonly secretHmacKey?: string },
  rawSecret: string,
): Promise<CredentialAuthoritySnapshot> {
  let parsed: ReturnType<typeof parseAccountCredentialSecret>;
  try {
    parsed = parseAccountCredentialSecret(rawSecret);
  } catch {
    throw new AccountCredentialCommandError('invalid_request', 'The child credential is invalid.');
  }
  if (parsed.kind !== 'child') {
    throw new AccountCredentialCommandError('invalid_request', 'The child credential is invalid.');
  }
  const record = await ports.credentials.findBySecretHash(hashAccountCredentialSecret(rawSecret, ports.secretHmacKey));
  if (!record || record.kind !== 'child') {
    throw new AccountCredentialCommandError('invalid_request', 'The child credential is invalid.');
  }
  const snapshot = await loadCredentialAuthority(ports, record.id);
  if (!snapshot) {
    throw new AccountCredentialCommandError('invalid_request', 'The child credential is invalid.');
  }
  await ports.credentials.touchLastUsed(record.id, await ports.clock.now());
  return snapshot;
}

export async function loadCredentialAuthority(
  ports: { readonly credentials: AccountCredentialStore; readonly clock: AccountCredentialClock; readonly accounts: AccountCredentialAccountPorts; readonly secretHmacKey?: string },
  credentialId: string,
): Promise<CredentialAuthoritySnapshot | null> {
  const credential = await ports.credentials.findById(credentialId);
  const now = await ports.clock.now();
  if (!credential || credential.kind !== 'child' || effectiveCredentialState(credential, now) !== 'active') {
    return null;
  }
  const ancestors: AccountCredentialRecord[] = [];
  let parentId = credential.parentId;
  while (parentId) {
    const ancestor = await ports.credentials.findById(parentId);
    if (!ancestor || effectiveCredentialState(ancestor, now) !== 'active') return null;
    ancestors.push(ancestor);
    parentId = ancestor.parentId;
  }
  if (ancestors.length === 0) return null;
  const ancestorsRootFirst = Object.freeze([...ancestors].reverse());
  const account = await ports.accounts.findAccountById(credential.accountId);
  if (!account || account.status !== 'active' || account.deletedAt !== null) return null;
  if (account.subjectId !== credential.subjectId) return null;
  return {
    credential,
    account: {
      id: account.id,
      subjectId: account.subjectId,
      status: account.status,
      securityEpoch: account.securityEpoch,
    },
    ancestorsRootFirst,
    ancestorEpoch: ancestorEpochDigest(
      ancestorsRootFirst.map((entry) => ({ id: entry.id, epoch: entry.epoch })),
    ),
  };
}

export function authorityMatchesClaims(
  snapshot: CredentialAuthoritySnapshot,
  claims: AccountKeyJwtClaims,
): boolean {
  return snapshot.credential.id === claims.known_credential_id
    && snapshot.credential.mcpClientId === claims.client_id
    && snapshot.account.subjectId === claims.sub
    && snapshot.account.id === snapshot.credential.accountId
    && snapshot.account.securityEpoch.toString(10) === claims.known_account_epoch
    && snapshot.credential.epoch.toString(10) === claims.known_credential_epoch
    && snapshot.ancestorEpoch === claims.known_ancestor_epoch;
}

export async function resolveMachineMcpBinding(input: {
  readonly payload: JWTPayload;
  readonly kid: string;
  readonly issuer: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
  readonly load: (credentialId: string) => Promise<CredentialAuthoritySnapshot | null>;
}): Promise<string | null> {
  const credentialId = input.payload.known_credential_id;
  const clientId = input.payload.client_id;
  const accountEpoch = input.payload.known_account_epoch;
  const credentialEpoch = input.payload.known_credential_epoch;
  const ancestorEpoch = input.payload.known_ancestor_epoch;
  const sub = input.payload.sub;
  if (
    typeof credentialId !== 'string' || typeof clientId !== 'string'
    || typeof accountEpoch !== 'string' || typeof credentialEpoch !== 'string'
    || typeof ancestorEpoch !== 'string' || typeof sub !== 'string'
  ) {
    return null;
  }
  const snapshot = await input.load(credentialId);
  if (!snapshot) return null;
  const claims: AccountKeyJwtClaims = {
    iss: input.issuer,
    aud: input.resourceAudience,
    sub,
    iat: typeof input.payload.iat === 'number' ? input.payload.iat : 0,
    nbf: typeof input.payload.nbf === 'number' ? input.payload.nbf : 0,
    exp: typeof input.payload.exp === 'number' ? input.payload.exp : 0,
    jti: typeof input.payload.jti === 'string' ? input.payload.jti : '',
    scope: typeof input.payload.scope === 'string' ? input.payload.scope : '',
    scopes: typeof input.payload.scope === 'string' ? input.payload.scope.split(' ').filter(Boolean) : [],
    known_credential_id: credentialId,
    known_account_epoch: accountEpoch,
    known_credential_epoch: credentialEpoch,
    known_ancestor_epoch: ancestorEpoch,
    client_id: clientId,
    kid: input.kid,
  };
  if (!authorityMatchesClaims(snapshot, claims)) return null;
  return machineCredentialBindingId({
    iss: input.issuer,
    clientId,
    credentialId,
    resourceAudience: input.resourceAudience,
    accountEpoch,
    credentialEpoch,
    ancestorEpochDigest: ancestorEpoch,
    serverSecurityEpoch: input.securityEpoch,
  });
}

export async function verifyAccountKeyJwt(input: {
  readonly token: string;
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: readonly AccountCredentialsEs256PublicJwk[];
  readonly now: Date;
  readonly clockSkewSeconds?: number;
}): Promise<AccountKeyJwtClaims> {
  let header: { readonly alg?: string; readonly kid?: string };
  try {
    header = decodeProtectedHeader(input.token);
  } catch {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string' || header.kid.length < 1) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  const matching = input.publicKeys.filter((key) => key.kid === header.kid);
  if (matching.length === 0) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  const key = await importJWK(matching[0] as JWK, 'ES256');
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(input.token, key, {
      issuer: input.issuer,
      audience: input.audience,
      algorithms: ['ES256'],
      clockTolerance: input.clockSkewSeconds ?? ACCOUNT_KEY_CLOCK_SKEW_SECONDS,
      currentDate: input.now,
      requiredClaims: [
        'iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'scope',
        'known_credential_id', 'known_account_epoch', 'known_credential_epoch',
        'known_ancestor_epoch', 'client_id',
      ],
    });
    payload = result.payload;
  } catch {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  if (payload.isBot !== undefined || payload.email_verified !== undefined || payload.secret !== undefined || payload.d !== undefined) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  const scope = requireString(payload.scope);
  const scopes = scope.split(' ').filter(Boolean);
  return {
    iss: requireString(payload.iss),
    aud: requireAudience(payload.aud, input.audience),
    sub: requireString(payload.sub),
    iat: requireUnix(payload.iat),
    nbf: requireUnix(payload.nbf),
    exp: requireUnix(payload.exp),
    jti: requireString(payload.jti),
    scope,
    scopes: Object.freeze(scopes),
    known_credential_id: requireString(payload.known_credential_id),
    known_account_epoch: requireDecimal(payload.known_account_epoch),
    known_credential_epoch: requireDecimal(payload.known_credential_epoch),
    known_ancestor_epoch: requireHex(payload.known_ancestor_epoch),
    client_id: requireUuid(payload.client_id),
    kid: header.kid,
  };
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  return value;
}

function requireAudience(aud: JWTPayload['aud'], expected: string): string {
  const values = Array.isArray(aud) ? aud : [aud];
  if (values.length !== 1 || values[0] !== expected) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  return expected;
}

function requireUnix(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  return value;
}

function requireDecimal(value: unknown): string {
  const text = requireString(value);
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(text)) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  return text;
}

function requireHex(value: unknown): string {
  const text = requireString(value);
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  return text;
}

function requireUuid(value: unknown): string {
  const text = requireString(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(text)) {
    throw new AccountCredentialCommandError('invalid_request', 'The access token is invalid.');
  }
  return text;
}
