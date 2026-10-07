import { AccountCredentialCommandError } from './errors.js';
import { AccountCredentialCursorError, type AccountCredentialCursorCodec } from './cursor.js';
import { credentialEtag, effectiveCredentialState, toCredentialDto } from './dto.js';
import {
  ACCOUNT_CREDENTIAL_PAGE_BYTE_BUDGET,
  type AccountCredentialClock,
  type AccountCredentialDto,
  type AccountCredentialListFilters,
  type AccountCredentialPageDto,
  type AccountCredentialRecord,
  type AccountCredentialState,
  type AccountCredentialStore,
} from './types.js';

export async function getDirectChildCredential(
  ports: { readonly credentials: AccountCredentialStore; readonly clock: AccountCredentialClock },
  input: { readonly parentId: string; readonly credentialId: string },
): Promise<{ readonly credential: AccountCredentialDto; readonly etag: string }> {
  const record = await ports.credentials.findById(input.credentialId);
  if (!record || record.kind !== 'child' || record.parentId !== input.parentId) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential was not found.');
  }
  const now = await ports.clock.now();
  const parent = await ports.credentials.findById(input.parentId);
  return { credential: toCredentialDto(record, now, parent), etag: credentialEtag(record) };
}

export async function listDirectChildren(
  ports: {
    readonly credentials: AccountCredentialStore;
    readonly clock: AccountCredentialClock;
    readonly cursors: AccountCredentialCursorCodec;
  },
  input: { readonly parent: AccountCredentialRecord; readonly filters: AccountCredentialListFilters },
): Promise<AccountCredentialPageDto> {
  const now = await ports.clock.now();
  const after = input.filters.cursor
    ? decodeCursor(ports.cursors, input.filters.cursor, now, {
      endpoint: 'listChildrenWithParentKey',
      viewer: input.parent.id,
      state: input.filters.state,
    })
    : undefined;
  const eligible = await collectEligible(after, input.filters.limit, (cursor, batch) =>
    ports.credentials.listChildren({
      parentId: input.parent.id,
      after: cursor,
      limit: batch,
    }), (row) => matchesState(row, now, input.parent, input.filters.state));
  return paginate(eligible, input.filters.limit, now, new Map([[input.parent.id, input.parent]]), ports.cursors, {
    endpoint: 'listChildrenWithParentKey',
    viewer: input.parent.id,
    kind: null,
    state: input.filters.state ?? null,
  });
}

function decodeCursor(
  codec: AccountCredentialCursorCodec,
  token: string,
  now: Date,
  binding: Parameters<AccountCredentialCursorCodec['verify']>[2],
): { readonly createdAt: Date; readonly id: string } {
  try {
    const payload = codec.verify(token, now, binding);
    return { createdAt: new Date(payload.afterCreatedAt), id: payload.afterId };
  } catch (error) {
    if (error instanceof AccountCredentialCursorError) throw error;
    throw new AccountCredentialCursorError('invalid_cursor');
  }
}

async function collectEligible(
  after: { readonly createdAt: Date; readonly id: string } | undefined,
  limit: number,
  fetchBatch: (
    cursor: { readonly createdAt: Date; readonly id: string } | undefined,
    batch: number,
  ) => Promise<readonly AccountCredentialRecord[]>,
  matches: (row: AccountCredentialRecord) => boolean,
): Promise<AccountCredentialRecord[]> {
  const matched: AccountCredentialRecord[] = [];
  let cursor = after;
  const batch = Math.max(limit + 1, 32);
  while (matched.length <= limit) {
    const rows = await fetchBatch(cursor, batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!matches(row)) continue;
      matched.push(row);
      if (matched.length > limit) return matched;
    }
    if (rows.length < batch) break;
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return matched;
}

function matchesState(
  row: AccountCredentialRecord,
  now: Date,
  parent: AccountCredentialRecord | undefined,
  state: AccountCredentialListFilters['state'],
): boolean {
  if (state === undefined) return true;
  return effectiveCredentialState(row, now, parent ?? null) === state;
}

function paginate(
  rows: readonly AccountCredentialRecord[],
  limit: number,
  now: Date,
  parents: Map<string, AccountCredentialRecord>,
  codec: AccountCredentialCursorCodec,
  binding: {
    readonly endpoint: 'listMyCredentials' | 'listChildrenWithParentKey';
    readonly viewer: string;
    readonly kind: 'parent' | 'child' | null;
    readonly state: AccountCredentialState | null;
  },
): AccountCredentialPageDto {
  const items: AccountCredentialDto[] = [];
  const included: AccountCredentialRecord[] = [];
  for (const row of rows) {
    if (included.length >= limit) break;
    const dto = toCredentialDto(row, now, row.parentId ? parents.get(row.parentId) ?? null : null);
    const candidateCursor = codec.sign({
      endpoint: binding.endpoint,
      viewer: binding.viewer,
      kind: binding.kind,
      state: binding.state,
      afterCreatedAt: row.createdAt.toISOString(),
      afterId: row.id,
      issuedAt: now.toISOString(),
    }, now);
    const serialized = Buffer.byteLength(JSON.stringify({
      items: [...items, dto],
      nextCursor: candidateCursor,
    }), 'utf8');
    if (serialized > ACCOUNT_CREDENTIAL_PAGE_BYTE_BUDGET) break;
    items.push(dto);
    included.push(row);
  }
  const last = included[included.length - 1];
  const nextCursor = last && included.length < rows.length
    ? codec.sign({
      endpoint: binding.endpoint,
      viewer: binding.viewer,
      kind: binding.kind,
      state: binding.state,
      afterCreatedAt: last.createdAt.toISOString(),
      afterId: last.id,
      issuedAt: now.toISOString(),
    }, now)
    : null;
  return { items, nextCursor };
}
