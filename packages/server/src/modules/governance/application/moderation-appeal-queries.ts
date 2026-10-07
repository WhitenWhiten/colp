import { strongEntityTag } from '../../collections/index.js';
import {
  fillGovernancePage,
  GOVERNANCE_CURSOR_TTL_MS,
  GovernanceModerationError,
  hasOfficialRead,
  parseGovernanceCursor,
  parseModerationLimit,
  parseOpaqueId,
} from '../domain/moderation.js';
import {
  parseAppealStatus,
  toAppeal,
  type Appeal,
  type ModerationAppealStatus,
} from '../domain/moderation-appeals.js';
import {
  bindModerationCursor,
  createModerationCursorSigner,
  MY_APPEALS_CURSOR_PURPOSE,
  OFFICIAL_APPEALS_CURSOR_PURPOSE,
} from './moderation-cursor.js';
import type {
  ModerationAppealRecord,
  ModerationQueryPorts,
} from './moderation-ports.js';
import type { ModerationListQuery, ModerationPage } from './moderation-queries.js';

export async function listMyModerationAppeals(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly accountId: string;
    readonly query: ModerationListQuery;
  },
): Promise<ModerationPage<Appeal>> {
  if (input.query.status !== undefined || input.query.assignee !== undefined) {
    throw new GovernanceModerationError('invalid_query', 'status is not allowed');
  }
  return listAppeals(ports, hmacKey, {
    purpose: MY_APPEALS_CURSOR_PURPOSE,
    viewer: input.accountId,
    query: input.query,
    load: (read) => ports.store.listAppellantAppeals(input.accountId, {
      limit: read.limit,
      ...(read.after ? { after: read.after } : {}),
    }),
  });
}

export async function listModerationAppeals(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly accountId: string;
    readonly query: ModerationListQuery;
  },
): Promise<ModerationPage<Appeal>> {
  await requireOfficialRead(ports, input.accountId);
  if (input.query.assignee !== undefined) {
    throw new GovernanceModerationError('invalid_query', 'assignee is not allowed');
  }
  return listAppeals(ports, hmacKey, {
    purpose: OFFICIAL_APPEALS_CURSOR_PURPOSE,
    viewer: input.accountId,
    query: input.query,
    load: (read) => ports.store.listOfficialAppeals({
      limit: read.limit,
      ...(read.after ? { after: read.after } : {}),
      ...(read.status ? { status: read.status } : {}),
    }),
  });
}

export async function getModerationAppeal(
  ports: ModerationQueryPorts,
  input: { readonly accountId: string; readonly appealId: string },
): Promise<{ readonly view: Appeal; readonly etag: string }> {
  const appealId = parseOpaqueId(input.appealId, 'appealId');
  // CG-F004: an appeal is readable by its appellant or by an official
  // reviewer; anyone else gets the SAME 404 conceal as a missing row.
  // Distinguishing "not found" (404) from "found but not yours" (403)
  // would turn the endpoint into an existence oracle.
  const roles = await ports.roles.getRoles(input.accountId);
  const official = hasOfficialRead(roles);
  const record = await ports.store.getAppeal(appealId);
  if (!record || (record.appellantAccountId !== input.accountId && !official)) {
    throw new GovernanceModerationError('resource_not_found', 'appeal was not found', 'conceal');
  }
  const view = toAppeal(record);
  return { view, etag: strongEntityTag(view.revision) };
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

async function listAppeals(
  ports: ModerationQueryPorts,
  hmacKey: string,
  input: {
    readonly purpose: typeof MY_APPEALS_CURSOR_PURPOSE | typeof OFFICIAL_APPEALS_CURSOR_PURPOSE;
    readonly viewer: string;
    readonly query: ModerationListQuery;
    readonly load: (read: {
      readonly after?: { readonly createdAt: string; readonly id: string };
      readonly status?: ModerationAppealStatus;
      readonly limit: number;
    }) => Promise<readonly ModerationAppealRecord[]>;
  },
): Promise<ModerationPage<Appeal>> {
  const status = input.query.status === undefined
    ? null
    : parseAppealStatus(input.query.status);
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
        purpose: input.purpose,
        viewer: input.viewer,
        status,
        assignee: null,
      }, hmacKey, token);
      after = bound.after;
      issuedAt = bound.issuedAt;
      expiresAt = bound.expiresAt;
    }
    const rows = await input.load({
      limit: limit + 8,
      ...(status ? { status } : {}),
      ...(after ? { after } : {}),
    });
    const mapped = rows.map(toAppeal);
    const page = fillGovernancePage(mapped, limit, () => 'A'.repeat(64));
    const lastRecord = page.items.length > 0 ? rows[page.items.length - 1] : undefined;
    const hasMore = rows.length > page.items.length;
    const nextCursor = hasMore && lastRecord
      ? signer.sign({
        v: 1,
        purpose: input.purpose,
        viewer: input.viewer,
        status,
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
