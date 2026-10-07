import { AccountCredentialInputError } from './errors.js';
import {
  COLLECTION_GRANT_ACTIONS,
  REPORT_GRANT_ACTIONS,
  isCollectionGrantAction,
  isReportGrantAction,
  type CredentialGrantAction,
} from './grant-actions.js';
import type {
  CredentialGrantInput,
  CredentialGrantListFilters,
} from './grant-types.js';
import { ACCOUNT_CREDENTIAL_PLAN_DIGEST_PATTERN } from './grant-types.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const LIMIT = /^[1-9][0-9]*$/;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ETAG = /^"[^"\r\n]+"$/;

export function parseGrantInput(body: unknown): CredentialGrantInput {
  const record = closedObject(body, ['credentialId', 'resource', 'actions', 'expiresAt']);
  const resource = parseResource(record.resource);
  return {
    credentialId: parseOpaque(record.credentialId, 'credentialId'),
    resource,
    actions: parseActions(record.actions, resource.kind),
    expiresAt: parseTimestamp(record.expiresAt),
  };
}

export function parseGrantListQuery(query: Record<string, string>): CredentialGrantListFilters {
  for (const name of Object.keys(query)) {
    if (name !== 'credentialId' && name !== 'limit' && name !== 'cursor') throw queryError();
  }
  const filters: {
    credentialId?: string;
    limit: number;
    cursor?: string;
  } = { limit: 20 };
  if (query.credentialId !== undefined) filters.credentialId = parseOpaque(query.credentialId, 'credentialId');
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

export function parseAuthorizePlanBody(body: unknown): {
  readonly planKind: 'collection' | 'report';
  readonly planId: string;
  readonly planDigest: string;
} {
  const record = closedObject(body, ['planKind', 'planId', 'planDigest']);
  return {
    planKind: parsePlanKind(record.planKind),
    planId: parseOpaque(record.planId, 'planId'),
    planDigest: parsePlanDigest(record.planDigest),
  };
}

export function parseGrantRevokeBody(body: unknown): { readonly reason: string } {
  const record = closedObject(body, ['reason']);
  if (typeof record.reason !== 'string') throw requestError();
  const reason = record.reason.trim().normalize('NFC');
  if (reason.length < 1 || reason.length > 500) throw requestError();
  return { reason };
}

export function parsePlanKind(value: unknown): 'collection' | 'report' {
  if (value !== 'collection' && value !== 'report') throw requestError();
  return value;
}

export function parsePlanDigest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 51 || !ACCOUNT_CREDENTIAL_PLAN_DIGEST_PATTERN.test(value)) {
    throw requestError();
  }
  return value;
}

export function parseGrantOpaqueId(value: unknown, label: string): string {
  return parseOpaque(value, label);
}

export function parseMcpCommandId(value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_ID.test(value)) throw requestError();
  return value;
}

export function parseMcpIfMatch(value: unknown): string {
  if (typeof value !== 'string' || !STRONG_ETAG.test(value)) throw requestError();
  return value;
}

function parseResource(value: unknown): CredentialGrantInput['resource'] {
  if (!isRecord(value) || typeof value.kind !== 'string' || !Object.hasOwn(value, 'id')) throw requestError();
  const keys = Object.keys(value);
  if (keys.length !== 2) throw requestError();
  if (value.kind !== 'collection' && value.kind !== 'report') throw requestError();
  return { kind: value.kind, id: parseOpaque(value.id, 'resource.id') };
}

function parseActions(value: unknown, kind: 'collection' | 'report'): readonly CredentialGrantAction[] {
  if (!Array.isArray(value)) throw requestError();
  const max = kind === 'collection' ? 2 : 4;
  if (value.length < 1 || value.length > max) throw requestError();
  const seen = new Set<string>();
  const actions: CredentialGrantAction[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || seen.has(item)) throw requestError();
    seen.add(item);
    if (kind === 'collection') {
      if (!isCollectionGrantAction(item)) throw requestError();
    } else if (!isReportGrantAction(item)) throw requestError();
    actions.push(item);
  }
  const allowed = kind === 'collection' ? COLLECTION_GRANT_ACTIONS : REPORT_GRANT_ACTIONS;
  if (actions.some((action) => !(allowed as readonly string[]).includes(action))) throw requestError();
  return Object.freeze(actions);
}

function parseOpaque(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new AccountCredentialInputError('invalid_request', `${label} is invalid.`);
  }
  return value;
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
  return new AccountCredentialInputError('invalid_request', 'The credential grant request is invalid.');
}

function queryError(): AccountCredentialInputError {
  return new AccountCredentialInputError('invalid_query', 'The credential grant query is invalid.');
}
