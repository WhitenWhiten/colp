import { createHash } from 'node:crypto';
import type { ReportSeriesWritePort } from './contracts.js';
import { createReportsCursorSigner, type UnsignedReportsCursorPayload } from './reports-cursor.js';

/** A bounded SQL page with query-bound cursors; visibility is rechecked on every page. */
export async function readPublicDirectoryPage(
  read: NonNullable<ReportSeriesWritePort['listPublicDirectory']>,
  config: Parameters<typeof createReportsCursorSigner>[0],
  input: { limit: number; requestedLimit?: number; cursor?: string; language?: string | null },
) {
  const fence = createHash('sha256').update(JSON.stringify({ directory: 2, language: input.language ?? null })).digest('hex');
  const signer = createReportsCursorSigner(config);
  try {
    let limit = input.limit;
    let after: { id: string; updatedAt: string } | undefined;
    if (input.cursor) {
      const payload = signer.verify(input.cursor, new Date());
      if (payload.principalId !== 'public' || payload.policyRevision !== fence
        || (input.requestedLimit !== undefined && payload.limit !== limit)) throw new Error('invalid_cursor');
      limit = payload.limit;
      after = payload.after;
    }
    const candidates = await read(limit + 1, after, input.language);
    const rows = candidates.slice(0, limit);
    const last = rows.at(-1);
    let nextCursor: string | null = null;
    if (candidates.length > limit && last) {
      if (last.updatedAt === undefined) throw new Error('report_directory_timestamp_missing');
      nextCursor = signer.sign(directoryCursorPayload('public', fence, limit, { id: last.id, updatedAt: last.updatedAt }));
    }
    return { rows, nextCursor };
  } finally { signer.destroy(); }
}

export function directoryCursorPayload(
  principalId: string,
  policyRevision: string,
  limit: number,
  after: { readonly id: string; readonly updatedAt: string },
): UnsignedReportsCursorPayload {
  const issuedAt = new Date().toISOString();
  return {
    v: 1,
    purpose: 'reports-list-v1',
    principalId,
    policyRevision,
    limit,
    sort: 'updated_at:desc,id:asc',
    comparatorVersion: 'updated-desc-id-v1',
    after,
    issuedAt,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}
