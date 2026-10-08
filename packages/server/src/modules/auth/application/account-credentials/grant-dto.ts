import type {
  CredentialGrantDto,
  CredentialGrantRecord,
  CredentialGrantState,
} from './grant-types.js';

export function grantEtag(record: Pick<CredentialGrantRecord, 'id' | 'revision'>): string {
  return `"${record.id}:${record.revision.toString(10)}"`;
}

export function effectiveGrantState(record: CredentialGrantRecord, now: Date): CredentialGrantState {
  if (record.state === 'revoked') return 'revoked';
  if (record.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function toGrantDto(record: CredentialGrantRecord, now: Date): CredentialGrantDto {
  return {
    id: record.id,
    credentialId: record.credentialId,
    resource: { kind: record.resource.kind, id: record.resource.id },
    actions: Object.freeze([...record.actions]),
    state: effectiveGrantState(record, now),
    revision: record.revision.toString(10),
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}
