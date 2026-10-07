import { readReportIssueContent, type ReportIssueContentReader } from './report-issue-content.js';
import { createHash } from 'node:crypto';
import type { McpApplicationReadPort } from './application-ports.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolResult } from './application-results.js';
import { assertCanonicalReportSlug, getPublicReportSeries, listOwnedReports, listPublicReportDirectory,
 listPublicReportIssues, visibleReportIssues, createReportsIssueCursorPayload, createReportsIssueCursorSigner,
 type ReportUnitOfWork } from '../reports/index.js';
export function createReportMcpReadToolPort(
  unitOfWork: ReportUnitOfWork,
  cursor: { readonly active: { readonly id: string; readonly secret: string }; readonly retained: readonly { readonly id: string; readonly secret: string; readonly lastIssuedAt: string; readonly retainUntil: string }[] },
  options: { readonly publicEnabled?: boolean; readonly contentReader?: ReportIssueContentReader } = {},
): McpApplicationReadPort {
  const publicEnabled = options.publicEnabled ?? true;
  const scopes = Object.freeze(['reports:read'] as const);
  const selectorSchema = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ slug: Object.freeze({ type: 'string', minLength: 1, maxLength: 63 }), reportId: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }) }), anyOf: Object.freeze([{ required: Object.freeze(['slug']) }, { required: Object.freeze(['reportId']) }]) });
  const issuesSchema = Object.freeze({ ...selectorSchema, properties: Object.freeze({ ...selectorSchema.properties, limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100 }), cursor: Object.freeze({ type: 'string', minLength: 1, maxLength: 2048 }) }) });
  const listSchema = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({ limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100 }), cursor: Object.freeze({ type: 'string', minLength: 1, maxLength: 2048 }) }) });
  const contentSchema = { ...selectorSchema, required: ['issueId'], properties: { ...selectorSchema.properties,
    issueId: { type: 'string', minLength: 1, maxLength: 128 }, cursor: { type: 'string', minLength: 1, maxLength: 8192 } } };
  const tools = Object.freeze([
    ...(options.contentReader ? [{ name: 'reports.issues.content', description: 'Read authorized issue source content in bounded, revision-fenced pages.', inputSchema: contentSchema, requiredScopes: scopes }] : []),
    Object.freeze({ name: 'reports.get', description: 'Read a public report by slug or authorized private report by id.', inputSchema: selectorSchema, requiredScopes: scopes }),
    Object.freeze({ name: 'reports.issues.list', description: 'List report issues by public slug or authorized private report id.', inputSchema: issuesSchema, requiredScopes: scopes }),
    Object.freeze({ name: 'reports.list', description: 'List public reports or reports owned by the authenticated caller.', inputSchema: listSchema, requiredScopes: scopes }),
  ]);
  return Object.freeze({
    listTools: async (context: McpApplicationContext) => context.principal.kind === 'anonymous' && !publicEnabled
      ? [] : context.principal.kind === 'anonymous' || context.scopes.includes('reports:read') ? tools : [],
    callTool: async (context: McpApplicationContext, name: string, args: Readonly<Record<string, unknown>>): Promise<McpApplicationToolResult> => {
      if (!REPORT_TOOL_NAMES.has(name) && !(name === 'reports.issues.content' && options.contentReader)) return rejected('unknown_tool', 'Unknown tool.');
      if (context.principal.kind !== 'anonymous' && !context.scopes.includes('reports:read')) return rejected('insufficient_scope', 'Insufficient scope.');
      try {
        if (name === 'reports.issues.content' && options.contentReader) {
          assertClosedArgs(args, ['reportId', 'slug', 'issueId', 'cursor']);
          return complete(await readReportIssueContent(unitOfWork, options.contentReader, context, readSelector(args), args, publicEnabled));
        }
        assertClosedArgs(args, name === 'reports.list' ? ['limit', 'cursor'] : name === 'reports.get' ? ['slug', 'reportId'] : ['slug', 'reportId', 'limit', 'cursor']);
        if (name === 'reports.list') return await readReportList(unitOfWork, cursor, context, args, publicEnabled);
        const selector = readSelector(args);
        if (selector.slug !== undefined) {
          if (!publicEnabled) return rejected('not_found', 'Report was not found.');
          if (name === 'reports.get') {
            const value = await getPublicReportSeries(unitOfWork, selector.slug);
            return value ? complete({ ...value, issues: visibleReportIssues(value.issues) }) : rejected('not_found', 'Report was not found.');
          }
          const page = await listPublicReportIssues(unitOfWork, selector.slug, cursor, readLimit(args), readCursor(args));
          return page ? complete({ ...page, items: visibleReportIssues(page.items) }) : rejected('not_found', 'Report was not found.');
        }
        if (context.principal.kind === 'anonymous') return rejected('not_found', 'Report was not found.');
        const subject = accountSubject(context);
        const value = await unitOfWork.execute(async (ports) => {
          const series = await ports.series.lockById(selector.reportId!);
          if (!series || series.state === 'archived') return null;
          if (series.ownerSubjectId === subject) return { series, canEdit: true };
          const member = await ports.members.get(series.id, subject);
          return member && !member.revokedAt ? { series, canEdit: member.role === 'editor' } : null;
        });
        if (!value) return rejected('not_found', 'Report was not found.');
        if (name === 'reports.get') return complete(safePrivateSeries(value.series, value.canEdit));
        const page = await listAuthorizedReportIssues(unitOfWork, value.series, subject, cursor, readLimit(args), readCursor(args));
        return complete(page);
      } catch (error) {
        if (isMcpReportNotFound(error)) return rejected('not_found', 'Report was not found.');
        if (isMcpInvalidCursor(error)) return rejected('invalid_cursor', 'The report cursor is invalid.');
        return rejected('invalid_request', 'The report request is invalid.');
      }
    },
  });
}

const REPORT_TOOL_NAMES = new Set(['reports.get', 'reports.issues.list', 'reports.list']);
const REPORT_OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const REPORT_LIMIT = 100;
const REPORT_ISSUES_MAX = 2_000;

function rejected(stableCode: 'unknown_tool' | 'insufficient_scope' | 'not_found' | 'invalid_request' | 'invalid_cursor', safeMessage: string): McpApplicationToolResult {
  return { kind: 'rejected', stableCode, safeMessage, retryable: false };
}

function assertClosedArgs(args: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('invalid_request');
}

function readSelector(args: Readonly<Record<string, unknown>>): { readonly slug?: string; readonly reportId?: string } {
  const rawSlug = args.slug;
  const rawReportId = args.reportId;
  let slug: string | null | undefined;
  if (rawSlug === undefined) slug = undefined;
  else if (typeof rawSlug === 'string' && rawSlug.length <= 63) {
    try { slug = assertCanonicalReportSlug(rawSlug); } catch { slug = null; }
  } else slug = null;
  const reportId = rawReportId === undefined ? undefined : typeof rawReportId === 'string' && REPORT_OPAQUE_ID.test(rawReportId) ? rawReportId : null;
  if (slug === null || reportId === null) throw new Error('invalid_request');
  if ((slug === undefined) === (reportId === undefined)) throw new Error('not_found');
  return slug === undefined ? { reportId } : { slug };
}

function readLimit(args: Readonly<Record<string, unknown>>): number | undefined {
  if (args.limit === undefined) return undefined;
  if (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > REPORT_LIMIT) throw new Error('invalid_request');
  return args.limit;
}

function readCursor(args: Readonly<Record<string, unknown>>): string | undefined {
  if (args.cursor === undefined) return undefined;
  if (typeof args.cursor !== 'string' || args.cursor.length < 1 || args.cursor.length > 2048) throw new Error('invalid_request');
  if (args.limit !== undefined) throw new Error('invalid_request');
  return args.cursor;
}

function accountSubject(context: McpApplicationContext): string {
  const subject = context.authorization.accountSubjectId;
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > 256
    || /[\u0000-\u001f\u007f]/u.test(subject)) throw new Error('not_found');
  return subject;
}

function safePrivateSeries(
  series: import('../reports/index.js').DigestSeries,
  canEdit = false,
): Record<string, unknown> {
  return { ...editableReportRevisions(series, canEdit), id: series.id, title: series.title, summary: series.summary, slug: series.slug, visibility: series.visibility, state: series.state };
}

async function readReportList(unit: ReportUnitOfWork, cursorConfig: Parameters<typeof listPublicReportDirectory>[1], context: McpApplicationContext, args: Readonly<Record<string, unknown>>, publicEnabled: boolean): Promise<McpApplicationToolResult> {
  const cursor = readCursor(args);
  const limit = readLimit(args);
  if (context.principal.kind === 'anonymous') {
    if (!publicEnabled) return rejected('not_found', 'Report was not found.');
    return complete(await listPublicReportDirectory(unit, cursorConfig, limit, cursor));
  }
  const subject = accountSubject(context);
  const page = await listOwnedReports(unit, subject, cursorConfig, limit, cursor);
  return complete({ items: page.items.map(series => safePrivateSeries(series, true)), nextCursor: page.nextCursor });
}

function isMcpReportNotFound(error: unknown): boolean { return error instanceof Error && error.message === 'not_found'; }
function isMcpInvalidCursor(error: unknown): boolean {
  return error instanceof Error && (error.message === 'invalid_cursor' || error.message === 'invalid cursor' || (error as { code?: unknown }).code === 'invalid_cursor');
}

async function listAuthorizedReportIssues(
  unit: ReportUnitOfWork,
  series: import('../reports/index.js').DigestSeries,
  subject: string,
  cursorConfig: Parameters<typeof listPublicReportDirectory>[1],
  requestedLimit: number | undefined,
  cursor: string | undefined,
): Promise<{ readonly items: readonly unknown[]; readonly nextCursor: string | null }> {
  const requested = requestedLimit ?? 50;
  // Always read the same bounded snapshot for every page. If the first page
  // hashes only `requested + 1` rows while continuation hashes the full set,
  // an otherwise unchanged cursor would fail its fence on page two.
  const fetchLimit = REPORT_ISSUES_MAX;
  return unit.execute(async (ports) => {
    // Re-authorize in the same transaction that reads the issue rows.  The
    // caller's preceding series lookup is only a selector; a membership
    // revoke between the two calls must not leave a private timeline open.
    const currentSeries = await ports.series.lockById(series.id);
    if (!currentSeries || currentSeries.state === 'archived') throw new Error('not_found');
    let canEdit = currentSeries.ownerSubjectId === subject;
    if (!canEdit) {
      const member = await ports.members.get(currentSeries.id, subject);
      if (!member || member.revokedAt) throw new Error('not_found');
      canEdit = member.role === 'editor';
    }
    const rows = ports.editions.listBySeries ? await ports.editions.listBySeries(currentSeries.id, fetchLimit + 1) : [];
    if (rows.length > REPORT_ISSUES_MAX) throw new Error('report_projection_limit_exceeded');
    const visibleRows = rows.filter((edition) => edition.state !== 'detached').sort(comparePrivateIssues);
    const policyFence = reportIssueCursorFence(currentSeries, visibleRows);
    const signer = createReportsIssueCursorSigner(cursorConfig);
    try {
      let pageRows = visibleRows;
      let limit = requested;
      const principalId = `mcp:${subject}:${series.id}`;
      if (cursor) {
        const payload = signer.verify(cursor, new Date());
        if (payload.principalId !== principalId || payload.policyRevision !== policyFence) throw new Error('invalid_cursor');
        limit = payload.limit;
        const index = pageRows.findIndex((edition) => edition.id === payload.after.id);
        pageRows = index < 0 ? [] : pageRows.slice(index + 1);
      }
      const page = pageRows.slice(0, limit).map((edition) => safePrivateIssue(edition, currentSeries, canEdit));
      const lastEdition = pageRows.length > limit ? pageRows[limit - 1] : undefined;
      const nextCursor = lastEdition
          ? signer.sign(createReportsIssueCursorPayload({
            principalId,
            policyRevision: policyFence,
            limit,
            after: {
              id: lastEdition.id,
              publishedAt: lastEdition.publishedAt ?? new Date(0).toISOString(),
              editionOrdinal: lastEdition.editionOrdinal,
            },
          }))
        : null;
      return { items: page, nextCursor };
    } finally { signer.destroy(); }
  });
}

function comparePrivateIssues(
  left: import('../reports/index.js').DigestEdition,
  right: import('../reports/index.js').DigestEdition,
): number {
  const leftTime = left.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.publishedAt);
  const rightTime = right.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.publishedAt);
  return rightTime - leftTime
    || right.editionOrdinal - left.editionOrdinal
    || left.id.localeCompare(right.id);
}

function reportIssueCursorFence(
  series: import('../reports/index.js').DigestSeries,
  editions: readonly import('../reports/index.js').DigestEdition[],
): string {
  return createHash('sha256').update(JSON.stringify({
    series: { id: series.id, policyRevision: series.policyRevision, contentRevision: series.contentRevision },
    editions: editions.map((edition) => ({ id: edition.id, state: edition.state, publishedAt: edition.publishedAt, resourceRevision: edition.resourceRevision })),
  }), 'utf8').digest('hex');
}

function safePrivateIssue(
  edition: import('../reports/index.js').DigestEdition,
  series: import('../reports/index.js').DigestSeries,
  canEdit = false,
): Record<string, unknown> {
  return {
    ...(canEdit ? { reportRevision: series.resourceRevision, expectedRevision: edition.resourceRevision } : {}),
    id: edition.id,
    seriesId: edition.seriesId,
    issueKey: edition.issueKey,
    editionOrdinal: edition.editionOrdinal,
    titleSnapshot: edition.titleSnapshot,
    summarySnapshot: edition.summarySnapshot,
    periodStart: edition.periodStart,
    periodEnd: edition.periodEnd,
    state: edition.state,
    publishedAt: edition.publishedAt,
    series: { id: series.id, title: series.title, summary: series.summary, slug: series.slug, visibility: series.visibility, updatedAt: series.updatedAt ?? new Date(0).toISOString() },
  };
}

function complete(value: unknown): McpApplicationToolResult { return { kind: 'complete', content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }

function editableReportRevisions(series: import('../reports/index.js').DigestSeries, canEdit: boolean): Record<string, unknown> {
 return canEdit ? { reportRevision: series.resourceRevision, expectedRevision: series.resourceRevision,
  contentRevision: series.contentRevision, policyRevision: series.policyRevision } : {};
}
