import { AccountCredentialInputError } from './errors.js';
import type {
  AccountCredentialListFilters,
  CreateChildAccountInput,
  CreateChildInput,
  RevokeCredentialInput,
  RotateCredentialInput,
} from './types.js';
import type { AccountCredentialKind } from './secret.js';
import type { AccountCredentialState } from './types.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const LIMIT = /^[1-9][0-9]*$/;

export function parseCreateChildBody(body: unknown): CreateChildInput {
  const record = closedObject(body, ['label', 'expiresAt', 'account']);
  return {
    label: parseLabel(record.label),
    expiresAt: parseTimestamp(record.expiresAt),
    account: parseAccountBinding(record.account),
  };
}

export function parseRotateBody(body: unknown): RotateCredentialInput {
  const record = closedObject(body, ['expiresAt']);
  return { expiresAt: parseTimestamp(record.expiresAt) };
}

export function parseRevokeBody(body: unknown): RevokeCredentialInput {
  const record = closedObject(body, ['reason']);
  return { reason: parseReason(record.reason) };
}

export function parseCredentialListQuery(
  query: Record<string, string>,
  options: { readonly allowKind?: boolean } = { allowKind: true },
): AccountCredentialListFilters {
  const allowed = new Set(['limit', 'cursor', 'state', ...(options.allowKind === false ? [] : ['kind'])]);
  for (const name of Object.keys(query)) {
    if (!allowed.has(name)) throw queryError();
  }
  const filters: {
    kind?: AccountCredentialKind;
    state?: AccountCredentialState;
    limit: number;
    cursor?: string;
  } = { limit: 20 };
  if (query.kind !== undefined) {
    if (query.kind !== 'parent' && query.kind !== 'child') throw queryError();
    filters.kind = query.kind;
  }
  if (query.state !== undefined) {
    if (query.state !== 'active' && query.state !== 'revoked' && query.state !== 'expired') throw queryError();
    filters.state = query.state;
  }
  if (query.limit !== undefined) {
    if (!LIMIT.test(query.limit)) throw queryError();
    const limit = Number(query.limit);
    if (limit < 1 || limit > 100) throw queryError();
    filters.limit = limit;
  }
  if (query.cursor !== undefined) {
    if (query.cursor.length < 1 || query.cursor.length > 2048 || !CURSOR.test(query.cursor)) throw queryError();
    filters.cursor = query.cursor;
  }
  return filters;
}

export function parseOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new AccountCredentialInputError('invalid_request', `${label} is invalid.`);
  }
  return value;
}

function parseAccountBinding(value: unknown): CreateChildAccountInput {
  if (!isRecord(value) || typeof value.mode !== 'string') throw requestError();
  if (value.mode === 'new') {
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'mode' && keys.join(',') !== 'displayName,mode') throw requestError();
    if (value.displayName === undefined) return { mode: 'new' };
    return { mode: 'new', displayName: parseLabel(value.displayName) };
  }
  if (value.mode === 'existing') {
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'accountId,mode') throw requestError();
    return { mode: 'existing', accountId: parseOpaqueId(value.accountId, 'accountId') };
  }
  throw requestError();
}

function parseLabel(value: unknown): string {
  if (typeof value !== 'string') throw requestError();
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 1 || normalized.length > 80) throw requestError();
  return normalized;
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string') throw requestError();
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 1 || normalized.length > 500) throw requestError();
  return normalized;
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
    throw requestError();
  }
  return value;
}

function closedObject(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw requestError();
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) throw requestError();
  for (const key of required) {
    if (value[key] === null) throw requestError();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestError(): AccountCredentialInputError {
  return new AccountCredentialInputError('invalid_request', 'The credential request is invalid.');
}

function queryError(): AccountCredentialInputError {
  return new AccountCredentialInputError('invalid_query', 'The credential query is invalid.');
}
