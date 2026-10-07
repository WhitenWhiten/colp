import type {
  AccountCredentialDto,
  AccountCredentialIssuedDto,
  AccountCredentialRecord,
  AccountCredentialState,
} from './types.js';

export function credentialEtag(record: Pick<AccountCredentialRecord, 'id' | 'revision'>): string {
  return `"${record.id}:${record.revision.toString(10)}"`;
}

export function effectiveCredentialState(record: AccountCredentialRecord, now: Date, parent?: AccountCredentialRecord | null): AccountCredentialState {
  if (record.state === 'revoked' || parent?.state === 'revoked') return 'revoked';
  if (record.expiresAt.getTime() <= now.getTime() || (parent !== undefined && parent !== null && parent.expiresAt.getTime() <= now.getTime())) {
    return 'expired';
  }
  return 'active';
}

export function toCredentialDto(
  record: AccountCredentialRecord,
  now: Date,
  parent?: AccountCredentialRecord | null,
): AccountCredentialDto {
  return {
    id: record.id,
    kind: record.kind,
    parentId: record.parentId,
    accountId: record.accountId,
    subjectId: record.subjectId,
    label: record.label,
    prefix: record.prefix,
    state: effectiveCredentialState(record, now, parent),
    revision: record.revision.toString(10),
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
  };
}

export function toIssuedDto(
  record: AccountCredentialRecord,
  now: Date,
  secret: string | null,
  parent?: AccountCredentialRecord | null,
): AccountCredentialIssuedDto {
  return {
    credential: toCredentialDto(record, now, parent),
    secret,
    secretAvailable: secret !== null,
  };
}

export function replayIssuedDto(credential: AccountCredentialDto): AccountCredentialIssuedDto {
  return { credential, secret: null, secretAvailable: false };
}
