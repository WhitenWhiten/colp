import { expect, test } from 'vitest';
import { createReportMcpReadToolPort } from '../../../src/modules/mcp/report-read-tools.js';
import { createReportMcpWriteToolPort } from '../../../src/modules/mcp/report-write-tools.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { McpReportPlan } from '../../../src/modules/mcp/report-plan.js';
import type { ReportTransactionPorts } from '../../../src/modules/reports/index.js';

const cursor = { active: { id: 'k', secret: Buffer.alloc(32, 1).toString('base64') }, retained: [] };
function fixture() {
  const series = { id: 'report', ownerSubjectId: 'owner', title: 'Before', summary: null, slug: null, visibility: 'private', state: 'active', resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1' };
  let member: { role: string; revokedAt: string | null } | null = { role: 'viewer', revokedAt: null };
  let canReadSource = true;
  const edition = { id: 'issue', seriesId: 'report', state: 'published', sourceCollectionId: 'private-source', resourceRevision: 'e1', publishedAt: '2026-09-20T00:00:00Z', titleSnapshot: 'Issue', editionOrdinal: 1 };
  const ports = {
    series: { lockById: async () => series }, members: { get: async () => member },
    editions: { lockById: async () => edition, listBySeries: async () => [edition] },
    source: { getForActor: async () => canReadSource ? { verdict: 'authorized', facts: { collectionId: 'private-source', contentRevision: 'source-c1', policyRevision: 'source-p1' } } : { verdict: 'not_found' } },
  } as unknown as ReportTransactionPorts;
  const unit = { execute: async <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(ports) };
  const context = (subject = 'owner') => createMcpApplicationContext({
    principal: { kind: 'authenticated', principalId: 'account', clientId: 'client', credentialBindingId: 'binding', resourceAudience: 'resource', securityEpoch: 'epoch' },
    scopes: ['reports:read', 'reports:write'], authorization: { accountSubjectId: subject }, abortSignal: new AbortController().signal,
    budgets: { maxDepth: 32, maxNodes: 1000, maxBytes: 65536, maxOperations: 100 }, correlationId: 'test',
  });
  return { series, edition, ports, unit, context, setMember: (v: typeof member) => { member = v; }, denySource: () => { canReadSource = false; } };
}

test('editors receive exact write revisions while viewers and revoked members do not', async () => {
  const f = fixture(), read = createReportMcpReadToolPort(f.unit, cursor);
  const get = (subject: string) => read.callTool(f.context(subject), 'reports.get', { reportId: 'report' });
  expect(await get('owner')).toMatchObject({ kind: 'complete', structuredContent: { reportRevision: 'r1', expectedRevision: 'r1' } });
  const viewer = await get('viewer');
  expect(viewer.kind).toBe('complete');
  if (viewer.kind === 'complete') expect(viewer.structuredContent).not.toHaveProperty('reportRevision');
  f.setMember({ role: 'editor', revokedAt: null });
  expect(await get('editor')).toMatchObject({ structuredContent: { reportRevision: 'r1' } });
  expect(await read.callTool(f.context('editor'), 'reports.issues.list', { reportId: 'report' }))
    .toMatchObject({ structuredContent: { items: [{ reportRevision: 'r1', expectedRevision: 'e1' }] } });
  f.setMember({ role: 'editor', revokedAt: '2026-09-20T00:00:00Z' });
  expect(await get('editor')).toMatchObject({ kind: 'rejected', stableCode: 'not_found' });
});

test('issue content checks source ACL and binds continuation to the report revision', async () => {
  const f = fixture(); let reads = 0;
  const read = createReportMcpReadToolPort(f.unit, cursor, { contentReader: async input => {
    reads++; expect(input.collectionId).toBe('private-source'); expect(input.subjectId).toBe('owner');
    return { items: [{ id: 'n', title: 'Body' }], revision: 'source-c1', nextCursor: input.cursor ? null : 'next' };
  } });
  const first = await read.callTool(f.context(), 'reports.issues.content', { reportId: 'report', issueId: 'issue' });
  expect(first.kind).toBe('complete'); if (first.kind !== 'complete') return;
  const page = first.structuredContent as { nextCursor: string };
  f.series.contentRevision = 'c2';
  expect(await read.callTool(f.context(), 'reports.issues.content', { reportId: 'report', issueId: 'issue', cursor: page.nextCursor }))
    .toMatchObject({ kind: 'rejected', stableCode: 'invalid_cursor' });
  expect(reads).toBe(1);
  f.denySource();
  expect(await read.callTool(f.context(), 'reports.issues.content', { reportId: 'report', issueId: 'issue' }))
    .toMatchObject({ kind: 'rejected', stableCode: 'not_found' });
  expect(reads).toBe(1);
});

test('report revisions support read, real plan/commit, replay and readback', async () => {
  const f = fixture(), read = createReportMcpReadToolPort(f.unit, cursor);
  const plans = new Map<string, McpReportPlan>();
  const write = createReportMcpWriteToolPort({ store: { save: p => { plans.set(p.planId, p); }, get: id => plans.get(id), update: p => { plans.set(p.planId, p); } },
    revisions: { currentReportRevision: () => f.series.resourceRevision, currentSourceRevisions: () => ({}) },
    executePlan: plan => { f.series.title = String(plan.operations[0]!.patch.title); f.series.resourceRevision = 'r2'; return { title: f.series.title }; },
  });
  const before = await read.callTool(f.context(), 'reports.get', { reportId: 'report' });
  expect(before.kind).toBe('complete'); if (before.kind !== 'complete') return;
  const revisions = before.structuredContent as { reportRevision: string; expectedRevision: string };
  const planned = await write.callTool(f.context(), 'reports.plan', { reportRevision: revisions.reportRevision,
    operations: [{ type: 'report', action: 'series.update', targetId: 'report', expectedRevision: revisions.expectedRevision, patch: { title: 'After' } }] });
  expect(planned.kind).toBe('complete'); if (planned.kind !== 'complete') return;
  const plan = planned.structuredContent as McpReportPlan;
  const commit = { planId: plan.planId, idempotencyKey: 'stable-test-key' };
  expect(await write.callTool(f.context(), 'reports.commit', commit)).toMatchObject({ kind: 'complete', structuredContent: { kind: 'committed' } });
  expect(await write.callTool(f.context(), 'reports.commit', commit)).toMatchObject({ kind: 'complete', structuredContent: { kind: 'replay' } });
  expect(await read.callTool(f.context(), 'reports.get', { reportId: 'report' })).toMatchObject({ structuredContent: { title: 'After', reportRevision: 'r2' } });
});


test('public issue content keeps the public projection boundary and refuses a withdrawn source', async () => {
  const f = fixture();
  const series = { ...f.series, slug: 'public-report', visibility: 'public', allowSearchIndexing: true };
  const edition = { ...f.edition, sourceContentRevision: 'sc1', sourcePolicyRevision: 'sp1', issueKey: 'one', periodStart: null, periodEnd: null, summarySnapshot: null };
  const source = { collectionId: 'private-source', visibility: 'public', publishedAt: edition.publishedAt, publicationSlug: 'public-source',
    hasRoot: true, allowSearchIndexing: true, ownerAccountActive: true, deleted: false, seedExcluded: false, contentRevision: 'sc1', policyRevision: 'sp1' };
  const ports = { ...f.ports, series: { ...f.ports.series, list: async () => [series] },
    editions: { ...f.ports.editions, lockById: async () => edition, findById: async () => edition, listBySeries: async () => [edition] },
    source: { get: async () => source, getMany: async () => [source] } } as unknown as ReportTransactionPorts;
  const unit = { execute: async <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(ports) };
  let reads = 0;
  const read = createReportMcpReadToolPort(unit, cursor, { contentReader: async input => {
    reads++; expect(input.publicOnly).toBe(true); expect(input.subjectId).toBeUndefined();
    return { items: [{ title: 'Public body' }], revision: 'sc1', nextCursor: null };
  } });
  const anon = createMcpApplicationContext({ ...f.context(), principal: { kind: 'anonymous', principalId: 'public', resourceAudience: 'resource', securityEpoch: 'epoch' }, authorization: {}, scopes: [] });
  const result = await read.callTool(anon, 'reports.issues.content', { slug: 'public-report', issueId: 'issue' });
  expect(result.kind).toBe('complete');
  expect(JSON.stringify(result)).not.toContain('private-source');
  source.visibility = 'private';
  expect(await read.callTool(anon, 'reports.issues.content', { slug: 'public-report', issueId: 'issue' })).toMatchObject({ kind: 'rejected', stableCode: 'not_found' });
  expect(reads).toBe(1);
});

test('source access revoked during content reading conceals the loaded body', async () => {
  const f = fixture();
  const read = createReportMcpReadToolPort(f.unit, cursor, { contentReader: async () => {
    f.denySource(); return { items: [{ title: 'must not escape' }], revision: 'sc1', nextCursor: null };
  } });
  const result = await read.callTool(f.context(), 'reports.issues.content', { reportId: 'report', issueId: 'issue' });
  expect(result).toMatchObject({ kind: 'rejected', stableCode: 'not_found' });
  expect(JSON.stringify(result)).not.toContain('must not escape');
});
