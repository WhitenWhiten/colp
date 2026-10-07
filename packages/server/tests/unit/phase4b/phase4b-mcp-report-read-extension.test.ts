import { describe, expect, test } from 'vitest';
import { createReportMcpReadToolPort } from '../../../src/bootstrap/api-mcp-surface-composition.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { ReportTransactionPorts } from '../../../src/modules/reports/index.js';

const cursor = { active: { id: 'k', secret: Buffer.alloc(32, 1).toString('base64') }, retained: [] };
const uow = { execute: async () => ({}) } as never;
const context = (scopes: readonly string[], kind: 'anonymous' | 'authenticated' = 'authenticated') => createMcpApplicationContext({
  principal: kind === 'anonymous' ? { kind: 'anonymous', principalId: 'public', resourceAudience: 'a', securityEpoch: 'e' } : { kind: 'authenticated', principalId: 'p', clientId: 'c', credentialBindingId: 'b', resourceAudience: 'a', securityEpoch: 'e' },
  scopes, abortSignal: new AbortController().signal, budgets: { maxDepth: 16, maxNodes: 10, maxBytes: 1000, maxOperations: 10 }, correlationId: 't',
});

describe('report MCP read extension', () => {
  test('flag-on catalog is deterministic and scope-gated', async () => {
    const port = createReportMcpReadToolPort(uow, cursor);
    expect((await port.listTools(context(['reports:read']))).map((x) => x.name)).toEqual(['reports.get', 'reports.issues.list', 'reports.list']);
    expect(await port.listTools(context([]))).toEqual([]);
    expect((await port.listTools(context([], 'anonymous'))).length).toBe(3);
  });
  test('unknown tool and foreign/private id concealment are stable', async () => {
    const port = createReportMcpReadToolPort(uow, cursor);
    await expect(port.callTool(context(['reports:read']), 'reports.nope', {})).resolves.toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
    await expect(port.callTool(context([], 'anonymous'), 'reports.get', { reportId: 'foreign' })).resolves.toMatchObject({ kind: 'rejected', stableCode: 'not_found' });
  });

  test('private issue reads use a closed safe DTO and bounded cursor pagination', async () => {
    const series = { id: 'series-1', ownerSubjectId: 'subject-1', title: 'Private digest', summary: null, slug: null, visibility: 'private' as const, allowSearchIndexing: false, state: 'active' as const, resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1', updatedAt: '2026-01-01T00:00:00.000Z' };
    let editions = [
      { id: 'edition-2', seriesId: series.id, sourceCollectionId: 'private-source', issueKey: 'two', editionOrdinal: 2, titleSnapshot: 'Two', summarySnapshot: null, sourceContentRevision: 'secret-c', sourcePolicyRevision: 'secret-p', resourceRevision: 'secret-r2', periodStart: null, periodEnd: null, state: 'published' as const, publishedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'edition-1', seriesId: series.id, sourceCollectionId: 'private-source', issueKey: 'one', editionOrdinal: 1, titleSnapshot: 'One', summarySnapshot: null, sourceContentRevision: 'secret-c', sourcePolicyRevision: 'secret-p', resourceRevision: 'secret-r1', periodStart: null, periodEnd: null, state: 'published' as const, publishedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const ports = {
      series: { lockById: async () => series },
      members: { get: async () => null },
      editions: { listBySeries: async (_seriesId: string, limit?: number) => {
        expect(limit).toBe(2_001);
        return editions;
      } },
    } as unknown as ReportTransactionPorts;
    const privateUow = { execute: async <T>(work: (value: ReportTransactionPorts) => Promise<T>) => work(ports) };
    const port = createReportMcpReadToolPort(privateUow, cursor);
    const first = await port.callTool(
      createMcpApplicationContext({ ...context(['reports:read']), authorization: { accountSubjectId: 'subject-1' } }),
      'reports.issues.list', { reportId: series.id, limit: 1 },
    );
    expect(first.kind).toBe('complete');
    if (first.kind !== 'complete') return;
    const firstPayload = first.structuredContent as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(firstPayload.items).toHaveLength(1);
    expect(firstPayload.nextCursor).toEqual(expect.any(String));
    expect(firstPayload.items[0]).not.toHaveProperty('sourceCollectionId');
    expect(firstPayload.items[0]).not.toHaveProperty('resourceRevision');
    expect(firstPayload.items[0]).not.toHaveProperty('sourceContentRevision');
    const second = await port.callTool(
      createMcpApplicationContext({ ...context(['reports:read']), authorization: { accountSubjectId: 'subject-1' } }),
      'reports.issues.list', { reportId: series.id, cursor: firstPayload.nextCursor },
    );
    expect(second.kind).toBe('complete');
    if (second.kind === 'complete') expect((second.structuredContent as { items: Record<string, unknown>[] }).items[0]?.id).toBe('edition-1');
    editions = editions.map((edition) => edition.id === 'edition-2' ? { ...edition, resourceRevision: 'new-revision' } : edition);
    await expect(port.callTool(
      createMcpApplicationContext({ ...context(['reports:read']), authorization: { accountSubjectId: 'subject-1' } }),
      'reports.issues.list', { reportId: series.id, cursor: firstPayload.nextCursor },
    )).resolves.toMatchObject({ kind: 'rejected', stableCode: 'invalid_cursor' });
  });

  test('report selectors reject unknown keys, malformed opaque ids, and cursor plus limit', async () => {
    const port = createReportMcpReadToolPort(uow, cursor);
    await expect(port.callTool(context(['reports:read']), 'reports.get', { reportId: 'bad/id' })).resolves.toMatchObject({ kind: 'rejected', stableCode: 'invalid_request' });
    await expect(port.callTool(context(['reports:read']), 'reports.get', { slug: 'report-one', extra: true })).resolves.toMatchObject({ kind: 'rejected', stableCode: 'invalid_request' });
    await expect(port.callTool(context(['reports:read']), 'reports.list', { limit: 1, cursor: 'x' })).resolves.toMatchObject({ kind: 'rejected', stableCode: 'invalid_request' });
  });
});
