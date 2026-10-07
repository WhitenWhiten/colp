import { createHash } from 'node:crypto';
import { getPublicReportIssue, type ReportUnitOfWork } from '../reports/index.js';
import type { McpApplicationContext } from './application-context.js';

export interface ReportIssueContentPage {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
  readonly revision: string;
}
export type ReportIssueContentReader = (input: {
  readonly collectionId: string;
  readonly publicOnly: boolean;
  readonly subjectId?: string;
  readonly cursor?: string;
}) => Promise<ReportIssueContentPage>;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const notFound = (): never => { throw new Error('not_found'); };

// A report membership is not a grant to read its private source collection.
// Check both authorities, and repeat authorization after loading content.
export async function readReportIssueContent(
  unit: ReportUnitOfWork,
  reader: ReportIssueContentReader,
  context: McpApplicationContext,
  selector: { readonly slug?: string; readonly reportId?: string },
  args: Readonly<Record<string, unknown>>,
  publicEnabled: boolean,
): Promise<Readonly<Record<string, unknown>>> {
  const issueId = args.issueId;
  if (typeof issueId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/u.test(issueId)) throw new Error('invalid_request');
  const subjectId = context.authorization.accountSubjectId;
  const publicOnly = selector.slug !== undefined;
  if (publicOnly && !publicEnabled) return notFound();
  if (!publicOnly && (context.principal.kind === 'anonymous' || typeof subjectId !== 'string' || !subjectId)) return notFound();
  const resolve = async () => {
    if (selector.slug !== undefined) {
      const visible = await getPublicReportIssue(unit, selector.slug, issueId);
      if (!visible || visible.issue.state === 'hidden') return notFound();
      const edition = await unit.execute(ports => ports.editions.lockById(issueId));
      if (!edition || edition.seriesId !== visible.series.id || edition.state !== 'published') return notFound();
      return { collectionId: edition.sourceCollectionId, issue: visible.issue, fence: digest([visible, edition.resourceRevision, edition.sourceCollectionId]) };
    }
    return unit.execute(async ports => {
      const series = await ports.series.lockById(selector.reportId!);
      if (!series || series.state === 'archived') return notFound();
      if (series.ownerSubjectId !== subjectId) {
        const member = await ports.members.get(series.id, String(subjectId));
        if (!member || member.revokedAt) return notFound();
      }
      const edition = await ports.editions.lockById(issueId);
      if (!edition || edition.seriesId !== series.id || edition.state === 'detached') return notFound();
      const source = await ports.source.getForActor?.(edition.sourceCollectionId, { subjectId: String(subjectId) });
      if (!source || !['public', 'authorized'].includes(source.verdict) || !source.facts || source.facts.collectionId !== edition.sourceCollectionId) return notFound();
      return {
        collectionId: edition.sourceCollectionId,
        issue: { id: edition.id, seriesId: series.id, title: edition.titleSnapshot, state: edition.state },
        fence: digest([series.resourceRevision, series.contentRevision, series.policyRevision, edition.resourceRevision,
          edition.sourceCollectionId, source.facts.contentRevision, source.facts.policyRevision]),
      };
    });
  };
  const current = await resolve();
  const selectorKey = JSON.stringify(selector);
  let sourceCursor: string | undefined;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length > 8192 || !args.cursor.startsWith('issue1.')) throw new Error('invalid_cursor');
    let value: Record<string, unknown>;
    try { value = JSON.parse(Buffer.from(args.cursor.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>; }
    catch { throw new Error('invalid_cursor'); }
    if (!value || value.selector !== selectorKey || value.issueId !== issueId || value.fence !== current.fence
      || typeof value.cursor !== 'string' || !value.cursor) throw new Error('invalid_cursor');
    sourceCursor = value.cursor;
  }
  const page = await reader({ collectionId: current.collectionId, publicOnly,
    ...(!publicOnly ? { subjectId: String(subjectId) } : {}), ...(sourceCursor ? { cursor: sourceCursor } : {}) });
  const refreshed = await resolve();
  if (refreshed.fence !== current.fence) throw new Error('invalid_cursor');
  const nextCursor = page.nextCursor === null ? null : `issue1.${Buffer.from(JSON.stringify({
    selector: selectorKey, issueId, fence: current.fence, cursor: page.nextCursor,
  })).toString('base64url')}`;
  return { issue: current.issue, items: page.items, nextCursor, revision: digest([current.fence, page.revision]), contentType: 'collection-nodes' };
}
