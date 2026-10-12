import { createKeyedCursorCodec, recordWithExactKeys } from '../../modules/commands/index.js';
import { ProductHttpError } from '../product-error.js';
import type { PageAfter } from '../../modules/automation/index.js';
interface Cursor { ownerId: string; scope: string; limit: number; after: PageAfter; issuedAt: string; expiresAt: string }
const invalid = () => new ProductHttpError({ statusCode: 400, code: 'invalid_cursor', message: 'Invalid or expired Automation cursor.' });
export function createAutomationPagination(key: string) {
  const codec = createKeyedCursorCodec<Cursor>({ mode: 'hmac-sha256', hmac: { variant: 'derived', purpose: 'automation-configuration-page/v1' },
    ttlMs: 15 * 60_000, keys: { current: { id: 'automation-v1', key } }, invalid,
    messages: { invalidCurrent: 'Automation cursor key is invalid.', uniqueIds: 'Duplicate cursor key.', invalidRetainUntil: 'Invalid cursor retention.' },
    validate(value) {
      if (!recordWithExactKeys(value, ['ownerId','scope','limit','after','issuedAt','expiresAt']) || typeof value.ownerId !== 'string' || typeof value.scope !== 'string'
        || !Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100
        || !recordWithExactKeys(value.after, ['createdAt','id']) || typeof value.after.id !== 'string' || typeof value.after.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.after.createdAt)) || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string'
        || !Number.isFinite(Date.parse(value.issuedAt)) || !Number.isFinite(Date.parse(value.expiresAt))) throw invalid();
      return value as unknown as Cursor;
    },
  });
  return {
    read(query: Record<string, string>, ownerId: string, scope: string, now: Date) {
      if (query.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/u.test(query.limit)) throw new ProductHttpError({ statusCode: 400, code: 'invalid_query', message: 'Limit must be 1–100.' });
      const limit = Number(query.limit ?? 50);
      const decoded = query.cursor ? codec.verify(query.cursor, now) : null;
      if (decoded && (decoded.ownerId !== ownerId || decoded.scope !== scope || decoded.limit !== limit)) throw invalid();
      return { limit, after: decoded?.after ?? null };
    },
    next(ownerId: string, scope: string, limit: number, after: PageAfter, now: Date) {
      return codec.sign({ ownerId, scope, limit, after, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString() });
    },
  };
}
