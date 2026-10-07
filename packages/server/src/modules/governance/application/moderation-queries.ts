import { strongEntityTag } from '../../collections/index.js';
import {
  fillGovernancePage,
  GOVERNANCE_CURSOR_TTL_MS,
  GovernanceModerationError,
  hasOfficialRead,
  parseGovernanceCursor,
  parseModerationCaseStatus,
  parseModerationLimit,
  parseOpaqueId,
  parseQueryOpaqueId,
  type ModerationCaseStatus,
  type Evidence,
  type MyCase,
  type OfficialCase,
} from '../domain/moderation.js';
import {
  toAction,
  toMyAction,
  type Action,
  type MyAction,
} from '../domain/moderation-actions.js';
import {
  bindModerationCursor,
  createModerationCursorSigner,
  MY_ACTIONS_CURSOR_PURPOSE,
  MY_REPORTS_CURSOR_PURPOSE,
  OFFICIAL_CASES_CURSOR_PURPOSE,
} from './moderation-cursor.js';
import {
  toMyCase,
  toOfficialCase,
  type ModerationCaseRecord,
  type ModerationQueryPorts,
} from './moderation-ports.js';

export interface ModerationListQuery {
  readonly status?: string;
  readonly assignee?: string;
  readonly limit?: string;
  readonly cursor?: string;
}

export interface ModerationPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export async function listMyModerationReports(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly accountId: string;
    readonly query: ModerationListQuery;
  },
): Promise<ModerationPage<MyCase>> {
  if (input.query.assignee !== undefined) {
    throw new GovernanceModerationError('invalid_query', 'assignee is not allowed');
  }
  return listCases(ports, hmacKey, {
    purpose: MY_REPORTS_CURSOR_PURPOSE,
    viewer: input.accountId,
    query: input.query,
    load: (read) => ports.store.listReporterCases(input.accountId, read),
    map: toMyCase,
  });
}

export async function getMyModerationReport(
  ports: ModerationQueryPorts,
  input: { readonly accountId: string; readonly caseId: string },
): Promise<{ readonly view: MyCase; readonly etag: string }> {
  const caseId = parseOpaqueId(input.caseId, 'caseId');
  const record = await ports.store.getCase(caseId);
  if (!record || record.reporterAccountId !== input.accountId) {
    throw new GovernanceModerationError('resource_not_found', 'case was not found', 'conceal');
  }
  const view = toMyCase(record);
  return { view, etag: strongEntityTag(view.revision) };
}

export async function listModerationCases(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly accountId: string;
    readonly query: ModerationListQuery;
  },
): Promise<ModerationPage<OfficialCase>> {
  await requireOfficialRead(ports, input.accountId);
  return listCases(ports, hmacKey, {
    purpose: OFFICIAL_CASES_CURSOR_PURPOSE,
    viewer: input.accountId,
    query: input.query,
    load: (read) => ports.store.listOfficialCases(read),
    map: toOfficialCase,
  });
}

export async function getModerationCase(
  ports: ModerationQueryPorts,
  input: { readonly accountId: string; readonly caseId: string },
): Promise<{ readonly view: OfficialCase; readonly etag: string }> {
  await requireOfficialRead(ports, input.accountId);
  const caseId = parseOpaqueId(input.caseId, 'caseId');
  const record = await ports.store.getCase(caseId);
  if (!record) {
    throw new GovernanceModerationError('resource_not_found', 'case was not found', 'conceal');
  }
  const view = toOfficialCase(record);
  return { view, etag: strongEntityTag(view.case.revision) };
}

export async function getModerationAction(
  ports: ModerationQueryPorts,
  input: { readonly accountId: string; readonly actionId: string },
): Promise<{ readonly view: Action; readonly etag: string }> {
  await requireOfficialRead(ports, input.accountId);
  const actionId = parseOpaqueId(input.actionId, 'actionId');
  const record = await ports.store.getAction(actionId);
  if (!record) {
    throw new GovernanceModerationError('resource_not_found', 'action was not found', 'conceal');
  }
  const view = toAction(record);
  return { view, etag: strongEntityTag(view.revision) };
}

export async function listActionsAffectingMe(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly accountId: string;
    readonly query: ModerationListQuery;
  },
): Promise<ModerationPage<MyAction>> {
  if (input.query.status !== undefined || input.query.assignee !== undefined) {
    throw new GovernanceModerationError('invalid_query', 'status is not allowed');
  }
  const limit = parseModerationLimit(input.query.limit);
  let after: { readonly createdAt: string; readonly id: string } | undefined;
  const now = await ports.clock.now();
  let issuedAt = now.toISOString();
  let expiresAt = new Date(now.getTime() + GOVERNANCE_CURSOR_TTL_MS).toISOString();
  const signer = createModerationCursorSigner(hmacKey);
  try {
    if (input.query.cursor !== undefined) {
      const token = parseGovernanceCursor(input.query.cursor);
      const verified = signer.verify(token, now);
      const bound = bindModerationCursor(verified, {
        purpose: MY_ACTIONS_CURSOR_PURPOSE,
        viewer: input.accountId,
        status: null,
        assignee: null,
      }, hmacKey, token);
      after = bound.after;
      issuedAt = bound.issuedAt;
      expiresAt = bound.expiresAt;
    }
    const rows = await ports.store.listActionsAffectingOwner(input.accountId, {
      limit: limit + 8,
      ...(after ? { after } : {}),
    });
    const mapped = rows.map(toMyAction);
    const page = fillGovernancePage(mapped, limit, () => 'A'.repeat(64));
    const lastRecord = page.items.length > 0 ? rows[page.items.length - 1] : undefined;
    const hasMore = rows.length > page.items.length;
    const nextCursor = hasMore && lastRecord
      ? signer.sign({
        v: 1,
        purpose: MY_ACTIONS_CURSOR_PURPOSE,
        viewer: input.accountId,
        status: null,
        assignee: null,
        after: { createdAt: lastRecord.createdAt, id: lastRecord.id },
        issuedAt,
        expiresAt,
      })
      : null;
    return Object.freeze({ items: page.items, nextCursor });
  } finally {
    signer.destroy();
  }
}

export async function getModerationEvidence(
  ports: ModerationQueryPorts,
  input: { readonly accountId: string; readonly caseId: string; readonly evidenceId: string },
): Promise<Evidence> {
  await requireOfficialRead(ports, input.accountId);
  const caseId = parseOpaqueId(input.caseId, 'caseId');
  const evidenceId = parseOpaqueId(input.evidenceId, 'evidenceId');
  const evidence = await ports.store.getEvidence(caseId, evidenceId);
  if (!evidence) {
    throw new GovernanceModerationError('resource_not_found', 'evidence was not found', 'conceal');
  }
  return evidence;
}

async function requireOfficialRead(ports: ModerationQueryPorts, accountId: string): Promise<void> {
  const roles = await ports.roles.getRoles(accountId);
  if (!hasOfficialRead(roles)) {
    throw new GovernanceModerationError(
      'insufficient_permission',
      'official reviewer role is required',
      'deny',
    );
  }
}

async function listCases<T>(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly purpose: typeof MY_REPORTS_CURSOR_PURPOSE | typeof OFFICIAL_CASES_CURSOR_PURPOSE;
    readonly viewer: string;
    readonly query: ModerationListQuery;
    readonly load: (read: {
      readonly after?: { readonly createdAt: string; readonly id: string };
      readonly status?: ModerationCaseStatus;
      readonly assignee?: string;
      readonly limit: number;
    }) => Promise<readonly ModerationCaseRecord[]>;
    readonly map: (record: ModerationCaseRecord) => T;
  },
): Promise<ModerationPage<T>> {
  const status = input.query.status === undefined
    ? null
    : parseModerationCaseStatus(input.query.status);
  const assignee = input.query.assignee === undefined
    ? null
    : parseQueryOpaqueId(input.query.assignee, 'assignee');
  let limit = parseModerationLimit(input.query.limit);
  let after: { readonly createdAt: string; readonly id: string } | undefined;
  const now = await ports.clock.now();
  let issuedAt = now.toISOString();
  let expiresAt = new Date(now.getTime() + GOVERNANCE_CURSOR_TTL_MS).toISOString();
  const signer = createModerationCursorSigner(hmacKey);
  try {
    if (input.query.cursor !== undefined) {
      const token = parseGovernanceCursor(input.query.cursor);
      const verified = signer.verify(token, now);
      const bound = bindModerationCursor(verified, {
        purpose: input.purpose,
        viewer: input.viewer,
        status,
        assignee,
      }, hmacKey, token);
      after = bound.after;
      issuedAt = bound.issuedAt;
      expiresAt = bound.expiresAt;
    }
    const rows = await input.load({
      limit: limit + 8,
      ...(status ? { status } : {}),
      ...(assignee ? { assignee } : {}),
      ...(after ? { after } : {}),
    });
    const mapped = rows.map(input.map);
    const page = fillGovernancePage(mapped, limit, () => 'A'.repeat(64));
    const lastRecord = page.items.length > 0 ? rows[page.items.length - 1] : undefined;
    const hasMore = rows.length > page.items.length;
    const nextCursor = hasMore && lastRecord
      ? signer.sign({
        v: 1,
        purpose: input.purpose,
        viewer: input.viewer,
        status,
        assignee,
        after: { createdAt: lastRecord.createdAt, id: lastRecord.id },
        issuedAt,
        expiresAt,
      })
      : null;
    return Object.freeze({ items: page.items, nextCursor });
  } finally {
    signer.destroy();
  }
}
