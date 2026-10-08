import { createHash } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandResult,
} from '../../../commands/index.js';
import { AccountCredentialCommandError } from './errors.js';
import { credentialEtag, replayIssuedDto, toCredentialDto, toIssuedDto, effectiveCredentialState } from './dto.js';
import { provisionIndependentAccount } from './provision.js';
import { issueAccountCredentialSecret } from './secret.js';
import {
  ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION,
  ACCOUNT_CREDENTIAL_MAX_EXPIRY_MS,
  type AccountCredentialCommandPorts,
  type AccountCredentialDto,
  type AccountCredentialIssuedDto,
  type AccountCredentialRecord,
  type CreateChildInput,
  type RevokeCredentialInput,
  type RotateCredentialInput,
} from './types.js';

export type AccountCredentialCommandOutcome<T> =
  | { readonly kind: 'succeeded'; readonly body: T; readonly etag: string }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export interface IssuanceLimiterPort {
  consume(parentKey: string): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }>;
}

const CREATE_CHILD_SCOPE = 'auth:account-credential-child:create:v1';
const ROTATE_SCOPE = 'auth:account-credential-rotate:v1';
const REVOKE_SCOPE = 'auth:account-credential-revoke:v1';
const JSON_TYPE = 'application/json; charset=utf-8';

export async function createChildCredential(
  ports: AccountCredentialCommandPorts & { readonly issuance?: IssuanceLimiterPort },
  input: {
    readonly managerAccountId: string;
    readonly parentId: string;
    readonly commandId: string;
    readonly body: CreateChildInput;
    readonly actor: 'manager' | 'parent-key';
  },
): Promise<AccountCredentialCommandOutcome<AccountCredentialIssuedDto>> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = fingerprintOf({
    operation: input.actor === 'parent-key' ? 'issueChildWithParentKey' : 'createCredentialChild',
    managerAccountId: input.managerAccountId,
    parentId: input.parentId,
    body: input.body,
  });
  return executeIssuance(ports, {
    principalId: input.actor === 'parent-key' ? input.parentId : input.managerAccountId,
    commandScope: CREATE_CHILD_SCOPE,
    commandId,
    fingerprint,
    issuanceKey: `parent:${input.parentId}`,
    status: 201,
    write: async (now) => {
      const parent = await ports.credentials.lockById(input.parentId);
      if (!parent || parent.kind !== 'parent' || parent.managerAccountId !== input.managerAccountId) {
        throw new AccountCredentialCommandError('resource_not_found', 'The parent credential was not found.');
      }
      if (effectiveCredentialState(parent, now) !== 'active') {
        throw new AccountCredentialCommandError('resource_not_found', 'The parent credential was not found.');
      }
      assertChildExpiry(input.body.expiresAt, now, parent.expiresAt);
      const bound = await bindChildAccount(ports, input.managerAccountId, input.body, now);
      const issued = issueAccountCredentialSecret('child', ports.secretHmacKey);
      const record = newRecord({
        id: ports.ids.nextCredentialId(),
        kind: 'child',
        parentId: parent.id,
        accountId: bound.accountId,
        subjectId: bound.subjectId,
        managerAccountId: parent.managerAccountId,
        label: input.body.label,
        prefix: issued.prefix,
        secretHash: issued.secretHash,
        expiresAt: new Date(input.body.expiresAt),
        createdAt: now,
        mcpClientId: issued.mcpClientId,
      });
      await ports.credentials.insert(record);
      return { record, secret: issued.secret, parent };
    },
  });
}

export async function rotateCredential(
  ports: AccountCredentialCommandPorts & { readonly issuance?: IssuanceLimiterPort },
  input: {
    readonly managerAccountId: string;
    readonly credentialId: string;
    readonly commandId: string;
    readonly ifMatch: string | undefined;
    readonly body: RotateCredentialInput;
    readonly parentId?: string;
  },
): Promise<AccountCredentialCommandOutcome<AccountCredentialIssuedDto>> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = fingerprintOf({
    operation: 'rotateCredential',
    managerAccountId: input.managerAccountId,
    credentialId: input.credentialId,
    ifMatch: input.ifMatch ?? null,
    body: input.body,
  });
  const visible = await loadManaged(ports, input);
  const now = await ports.clock.now();
  if (effectiveCredentialState(visible.record, now, visible.parent) !== 'active') {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential was not found.');
  }
  return executeIssuance(ports, {
    principalId: input.parentId ?? input.managerAccountId,
    commandScope: ROTATE_SCOPE,
    commandId,
    fingerprint,
    issuanceKey: `parent:${visible.record.parentId ?? visible.record.id}`,
    status: 200,
    ifMatch: input.ifMatch,
    current: visible.record,
    write: async (clockNow) => {
      const parent = visible.parent;
      if (visible.record.kind === 'child') {
        if (!parent || effectiveCredentialState(parent, clockNow) !== 'active') {
          throw new AccountCredentialCommandError('resource_not_found', 'The credential was not found.');
        }
        assertChildExpiry(input.body.expiresAt, clockNow, parent.expiresAt);
      } else {
        assertParentExpiry(input.body.expiresAt, clockNow);
      }
      const issued = issueAccountCredentialSecret(visible.record.kind, ports.secretHmacKey);
      const updated = await ports.credentials.replaceSecret({
        id: visible.record.id,
        expectedRevision: visible.record.revision,
        secretHash: issued.secretHash,
        prefix: issued.prefix,
        expiresAt: new Date(input.body.expiresAt),
        revision: visible.record.revision + 1n,
        epoch: visible.record.epoch + 1n,
      });
      if (!updated) {
        throw new AccountCredentialCommandError(
          'precondition_failed',
          'The resource ETag does not match the current representation.',
          credentialEtag(visible.record),
        );
      }
      return { record: updated, secret: issued.secret, ...(parent ? { parent } : {}) };
    },
  });
}

export async function revokeCredential(
  ports: AccountCredentialCommandPorts,
  input: {
    readonly managerAccountId: string;
    readonly credentialId: string;
    readonly commandId: string;
    readonly ifMatch: string | undefined;
    readonly body: RevokeCredentialInput;
    readonly parentId?: string;
  },
): Promise<AccountCredentialCommandOutcome<AccountCredentialDto>> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = fingerprintOf({
    operation: 'revokeCredential',
    managerAccountId: input.managerAccountId,
    credentialId: input.credentialId,
    ifMatch: input.ifMatch ?? null,
    body: input.body,
  });
  const visible = await loadManaged(ports, input);
  const now = await ports.clock.now();
  const binding = {
    principalId: input.parentId ?? input.managerAccountId,
    commandScope: REVOKE_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind !== 'claimed') return mapClaim(claim);
  if (input.ifMatch === undefined) {
    throw new AccountCredentialCommandError('precondition_required', 'If-Match is required for this operation.');
  }
  if (input.ifMatch !== credentialEtag(visible.record)) {
    throw new AccountCredentialCommandError(
      'precondition_failed',
      'The resource ETag does not match the current representation.',
      credentialEtag(visible.record),
    );
  }
  if (visible.record.state === 'revoked') {
    const body = toCredentialDto(visible.record, now, visible.parent);
    await complete(ports, binding, fingerprint, 200, body, credentialEtag(visible.record));
    return { kind: 'succeeded', body, etag: credentialEtag(visible.record) };
  }
  const updated = await ports.credentials.revoke({
    id: visible.record.id,
    expectedRevision: visible.record.revision,
    reason: input.body.reason,
    revokedAt: now,
    revision: visible.record.revision + 1n,
  });
  if (!updated) {
    throw new AccountCredentialCommandError(
      'precondition_failed',
      'The resource ETag does not match the current representation.',
      credentialEtag(visible.record),
    );
  }
  const body = toCredentialDto(updated, now, visible.parent);
  const etag = credentialEtag(updated);
  await complete(ports, binding, fingerprint, 200, body, etag);
  return { kind: 'succeeded', body, etag };
}

async function executeIssuance(
  ports: AccountCredentialCommandPorts & { readonly issuance?: IssuanceLimiterPort },
  input: {
    readonly principalId: string;
    readonly commandScope: string;
    readonly commandId: string;
    readonly fingerprint: string;
    readonly issuanceKey: string;
    readonly status: number;
    readonly ifMatch?: string;
    readonly current?: AccountCredentialRecord;
    readonly write: (now: Date) => Promise<{
      readonly record: AccountCredentialRecord;
      readonly secret: string;
      readonly parent?: AccountCredentialRecord;
    }>;
  },
): Promise<AccountCredentialCommandOutcome<AccountCredentialIssuedDto>> {
  const binding = {
    principalId: input.principalId,
    commandScope: input.commandScope,
    commandId: input.commandId,
  };
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') {
    return mapReplayWithoutSecret(claim);
  }
  if (claim.kind !== 'claimed') return mapClaim(claim);
  if (input.current) {
    if (input.ifMatch === undefined) {
      throw new AccountCredentialCommandError('precondition_required', 'If-Match is required for this operation.');
    }
    if (input.ifMatch !== credentialEtag(input.current)) {
      throw new AccountCredentialCommandError(
        'precondition_failed',
        'The resource ETag does not match the current representation.',
        credentialEtag(input.current),
      );
    }
  }
  if (ports.issuance) {
    const decision = await ports.issuance.consume(input.issuanceKey);
    if (!decision.allowed) {
      throw new AccountCredentialCommandError(
        'rate_limited',
        'Too many credential issuance requests.',
        null,
        decision.retryAfterSeconds,
      );
    }
  }
  const now = await ports.clock.now();
  const written = await input.write(now);
  const publicBody = toIssuedDto(written.record, now, null, written.parent);
  const etag = credentialEtag(written.record);
  await complete(ports, binding, input.fingerprint, input.status, publicBody, etag);
  return { kind: 'succeeded', body: toIssuedDto(written.record, now, written.secret, written.parent), etag };
}

async function bindChildAccount(
  ports: AccountCredentialCommandPorts,
  managerAccountId: string,
  body: CreateChildInput,
  now: Date,
): Promise<{ readonly accountId: string; readonly subjectId: string }> {
  if (body.account.mode === 'existing') {
    if (body.account.accountId !== managerAccountId) {
      throw new AccountCredentialCommandError(
        'insufficient_permission',
        'Existing account binding is limited to the current manager account.',
      );
    }
    const account = await requireActiveAccount(ports, managerAccountId);
    return { accountId: account.id, subjectId: account.subjectId };
  }
  const provisioned = await provisionIndependentAccount(ports.accounts, now, body.account.displayName);
  return { accountId: provisioned.account.id, subjectId: provisioned.account.subjectId };
}

async function loadManaged(
  ports: AccountCredentialCommandPorts,
  input: { readonly managerAccountId: string; readonly credentialId: string; readonly parentId?: string },
): Promise<{ readonly record: AccountCredentialRecord; readonly parent: AccountCredentialRecord | null }> {
  const record = await ports.credentials.lockById(input.credentialId);
  if (!record || record.managerAccountId !== input.managerAccountId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential was not found.');
  }
  if (input.parentId !== undefined) {
    if (record.kind !== 'child' || record.parentId !== input.parentId) {
      throw new AccountCredentialCommandError('resource_not_found', 'The credential was not found.');
    }
  }
  const parent = record.parentId ? await ports.credentials.findById(record.parentId) : null;
  return { record, parent };
}

async function requireActiveAccount(ports: AccountCredentialCommandPorts, accountId: string) {
  const account = await ports.accounts.findAccountById(accountId);
  if (!account || account.status !== 'active' || account.deletedAt !== null) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential was not found.');
  }
  return account;
}

function assertParentExpiry(expiresAt: string, now: Date): void {
  const at = Date.parse(expiresAt);
  const delta = at - now.getTime();
  if (!Number.isFinite(at) || delta <= 0 || delta > ACCOUNT_CREDENTIAL_MAX_EXPIRY_MS) {
    throw new AccountCredentialCommandError('invalid_request', 'Credential expiry is outside the allowed window.');
  }
}

function assertChildExpiry(expiresAt: string, now: Date, parentExpiresAt: Date): void {
  assertParentExpiry(expiresAt, now);
  if (Date.parse(expiresAt) > parentExpiresAt.getTime()) {
    throw new AccountCredentialCommandError('invalid_request', 'Child expiry cannot exceed the parent credential.');
  }
}

function newRecord(input: Omit<AccountCredentialRecord, 'state' | 'revision' | 'epoch' | 'lastUsedAt' | 'revokedAt' | 'revokeReason'>): AccountCredentialRecord {
  return {
    ...input,
    state: 'active',
    revision: 1n,
    epoch: 1n,
    lastUsedAt: null,
    revokedAt: null,
    revokeReason: null,
  };
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson({
    contractVersion: ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION,
    value,
  }), 'utf8').digest('hex');
}

async function complete(
  ports: AccountCredentialCommandPorts,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  status: number,
  body: unknown,
  etag: string,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const result: ProductCommandResult = {
    status,
    body: bytes,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': JSON_TYPE,
      etag,
    },
    mediaType: JSON_TYPE,
    contractVersion: ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION,
  };
  await ports.receipts.complete(binding, fingerprint, result);
}

function mapReplayWithoutSecret(claim: Extract<ProductCommandClaim, { kind: 'replay' }>): AccountCredentialCommandOutcome<AccountCredentialIssuedDto> {
  const parsed = JSON.parse(Buffer.from(claim.result.body).toString('utf8')) as unknown;
  if (parsed && typeof parsed === 'object' && 'credential' in parsed) {
    const body = replayIssuedDto((parsed as { credential: AccountCredentialDto }).credential);
    return {
      kind: 'replay',
      status: claim.result.status,
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  return {
    kind: 'replay',
    status: claim.result.status,
    body: claim.result.body,
    stableHeaders: claim.result.stableHeaders,
    mediaType: claim.result.mediaType,
  };
}

function mapClaim(claim: ProductCommandClaim): AccountCredentialCommandOutcome<never> {
  if (claim.kind === 'in_progress') return { kind: 'in_progress', retryAfterSeconds: claim.retryAfterSeconds };
  if (claim.kind === 'reused') return { kind: 'reused' };
  if (claim.kind === 'expired') return { kind: 'expired' };
  throw new Error('unexpected credential command claim');
}
