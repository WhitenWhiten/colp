import { describe, expect, it, vi } from 'vitest';
import { assembleSnapshotPages } from '@know-n/colp/semantic';
import type { Snapshot, SnapshotNode } from '@know-n/colp/types';
import {
  SyncBootstrapSnapshotError,
  createSyncBootstrapSnapshotService,
  type AttachmentExposurePolicyPort,
  type SyncBootstrapAuthority,
} from '../../../src/modules/sync/index.js';

const extension = { 'https://dev.example/extensions/nested': { bytes: ['a', { unknown: true }] } } as const;

/**
 * FIX-L-033 (SYNC-R17): the unit fixture denies every attachment projection —
 * the composed exposure-eligibility gate's deny-by-default verdict. Sync only
 * understands allow/deny through the policy port.
 */
const DENY_ATTACHMENTS: AttachmentExposurePolicyPort = Object.freeze({
  async assertAttachmentsDenied() { return undefined; },
});

function authority(nodes: readonly SnapshotNode[], overrides: Partial<Awaited<ReturnType<SyncBootstrapAuthority['load']>>> = {}): SyncBootstrapAuthority {
  return {
    async load() {
      return {
        sessionId: 'ses_1', collectionId: 'col_1', replicaId: 'rep_1', leaseGeneration: 3,
        sessionExpiresAt: '2099-07-25T10:15:00.000Z', replicaState: 'active',
        bindingMode: 'whole-profile', bindingRootNodeId: 'root_1',
        contentRevision: 'rev_7', policyRevision: 'policy_4', bootstrapCursor: 'ack_7',
        generatedAt: '2026-07-25T10:00:00.000Z',
        collection: {
          schemaVersion: '0.1', id: 'col_1', kind: 'bookmarks', title: 'Canonical',
          rootNodeId: 'root_1', visibility: 'private', createdAt: '2026-07-25T09:00:00.000Z',
          updatedAt: '2026-07-25T10:00:00.000Z', revision: 'rev_7', extensions: extension,
        },
        nodes,
        ...overrides,
      };
    },
  };
}

const root: SnapshotNode = {
  id: 'root_1', collectionId: 'col_1', kind: 'root', parentId: null, position: null,
  folderRole: 'root', title: 'Canonical', createdAt: '2026-07-25T09:00:00.000Z',
  updatedAt: '2026-07-25T10:00:00.000Z', revision: 'rev_7', extensions: extension,
};
const children: SnapshotNode[] = [
  { id: 'folder_1', collectionId: 'col_1', kind: 'folder', parentId: 'root_1', position: 'A', title: 'Private folder', createdAt: root.createdAt, updatedAt: root.updatedAt, revision: 'rev_7', extensions: extension },
  { id: 'bookmark_1', collectionId: 'col_1', kind: 'bookmark', parentId: 'folder_1', position: 'A', title: 'Secret title', url: 'https://private.example/path', createdAt: root.createdAt, updatedAt: root.updatedAt, revision: 'rev_7', extensions: extension },
  { id: 'separator_1', collectionId: 'col_1', kind: 'separator', parentId: 'folder_1', position: 'B', createdAt: root.createdAt, updatedAt: root.updatedAt, revision: 'rev_7', extensions: extension },
];

describe('P3-09 authoritative Sync bootstrap Snapshot', () => {
  it('publishes independent parent revisions in COLP 0.2 across Snapshot pages', async () => {
    const service = createSyncBootstrapSnapshotService({ authority: authority([root, ...children], {
      protocolVersion: '0.2', parentRevisions: [
        { parentId: 'root_1', childrenRevision: 'root-children-r2' },
        { parentId: 'folder_1', childrenRevision: 'folder-children-r4' },
      ],
    }), cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    const first = await service.query({ sessionId: 'ses_1', limit: 1 });
    expect(first).toMatchObject({ protocolVersion: '0.2',
      parentRevisions: [{ parentId: 'root_1', childrenRevision: 'root-children-r2' }] });
    const second = await service.query({ sessionId: 'ses_1', limit: 1,
      pageCursor: first.page.nextCursor! });
    expect(second).toMatchObject({ protocolVersion: '0.2',
      parentRevisions: [{ parentId: 'folder_1', childrenRevision: 'folder-children-r4' }] });
  });

  it('serves empty and deep Folder/Bookmark/Separator trees without publication redaction', async () => {
    const service = createSyncBootstrapSnapshotService({ authority: authority([root, ...children]), cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'), attachmentExposure: DENY_ATTACHMENTS });
    const page = await service.query({ sessionId: 'ses_1', limit: 100 });
    expect(page.mode).toBe('sync');
    expect(page.nodes.map((node) => node.kind)).toEqual(['root', 'folder', 'bookmark', 'separator']);
    expect(page.nodes[2]).toMatchObject({ title: 'Secret title', url: 'https://private.example/path', extensions: extension });
    expect(JSON.stringify(page)).not.toMatch(/nativeId|principal|sqlOrdinal|batchBindingSecret/i);
    expect(page.syncCursor).toBe('ack_7');
    expect(page.recoveryCapability).toBeUndefined();

    const empty = await createSyncBootstrapSnapshotService({ authority: authority([root]), cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS }).query({ sessionId: 'ses_1' });
    expect(empty.nodes).toEqual([root]);
  });

  it('assembles a stable 10k-node sequence and validates the complete graph', async () => {
    const wide = Array.from({ length: 10_000 }, (_, index): SnapshotNode => ({
      id: `bookmark_${index}`, collectionId: 'col_1', kind: 'bookmark', parentId: 'root_1',
      position: `P${index.toString().padStart(5, '0')}`, title: `${index}`, url: `https://example.test/${index}`,
      createdAt: root.createdAt, updatedAt: root.updatedAt, revision: 'rev_7', extensions: extension,
    }));
    const service = createSyncBootstrapSnapshotService({ authority: authority([root, ...wide]), cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    const pages: Snapshot[] = [];
    let pageCursor: string | undefined;
    do {
      const page = await service.query({ sessionId: 'ses_1', limit: 137, ...(pageCursor ? { pageCursor } : {}) });
      pages.push(page); pageCursor = page.page.nextCursor ?? undefined;
    } while (pageCursor);
    expect(pages.map((page) => page.page.sequence)).toEqual(Array.from({ length: pages.length }, (_, i) => i + 1));
    expect(pages.every((page) => page.syncCursor === 'ack_7')).toBe(true);
    expect(pages.at(-1)?.syncCursor).toBe('ack_7');
    expect(assembleSnapshotPages(pages).valid).toBe(true);
    expect(new Set(pages.flatMap((page) => page.nodes.map((node) => node.id))).size).toBe(10_001);
  });

  it('reads only the requested page from a stored paged authority and resumes across a restart', async () => {
    const nodes = [root, ...children];
    const loads: Array<{ snapshotId?: string; offset?: number; limit: number }> = [];
    const paged: SyncBootstrapAuthority = {
      async load(input) {
        loads.push({ snapshotId: input.snapshotId, offset: input.offset, limit: input.limit });
        const base = await authority(nodes).load(input);
        if (!input.snapshotId) return base;
        const offset = input.offset ?? 0;
        return { ...base, nodes: [], nodeCount: nodes.length,
          pageNodes: nodes.slice(offset, offset + input.limit) };
      },
    };
    const service = createSyncBootstrapSnapshotService({ authority: paged,
      cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    const first = await service.query({ sessionId: 'ses_1', limit: 2 });
    expect(first.nodes.map((node) => node.id)).toEqual(['root_1', 'folder_1']);
    expect(first.page.hasMore).toBe(true);
    expect(loads.at(-1)).toMatchObject({ snapshotId: undefined, offset: undefined });
    const second = await service.query({ sessionId: 'ses_1', limit: 2,
      pageCursor: first.page.nextCursor! });
    expect(second.nodes.map((node) => node.id)).toEqual(['bookmark_1', 'separator_1']);
    expect(second.page).toMatchObject({ sequence: 2, hasMore: false, nextCursor: null });
    expect(loads.at(-1)).toMatchObject({ snapshotId: first.snapshotId, offset: 2, limit: 2 });
    const restarted = createSyncBootstrapSnapshotService({ authority: paged,
      cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    const resumed = await restarted.query({ sessionId: 'ses_1', limit: 2,
      pageCursor: first.page.nextCursor! });
    expect(resumed.nodes.map((node) => node.id)).toEqual(['bookmark_1', 'separator_1']);
  });

  it('uses the persisted nodeCount to bound hasMore when a stored page is short', async () => {
    const nodes = [root, ...children];
    const paged: SyncBootstrapAuthority = {
      async load(input) {
        const base = await authority(nodes).load(input);
        if (!input.snapshotId) return base;
        const offset = input.offset ?? 0;
        return { ...base, nodes: [], nodeCount: nodes.length,
          pageNodes: nodes.slice(offset, offset + input.limit) };
      },
    };
    const service = createSyncBootstrapSnapshotService({ authority: paged,
      cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    const single = await service.query({ sessionId: 'ses_1', limit: 5 });
    expect(single.nodes.map((node) => node.id)).toEqual(['root_1', 'folder_1', 'bookmark_1', 'separator_1']);
    expect(single.page).toMatchObject({ sequence: 1, hasMore: false, nextCursor: null });
    const split = await service.query({ sessionId: 'ses_1', limit: 3 });
    expect(split.page.hasMore).toBe(true);
    const tail = await service.query({ sessionId: 'ses_1', limit: 3,
      pageCursor: split.page.nextCursor! });
    expect(tail.page).toMatchObject({ sequence: 2, hasMore: false, nextCursor: null });
  });

  it('binds mounted-folder roots, Session generation, page size and restart-safe cursors', async () => {
    const mountedRoot: SnapshotNode = { ...root, id: 'folder_1', title: 'Private folder' };
    const mounted = authority([mountedRoot, { ...children[1]!, parentId: 'folder_1' }, { ...children[2]!, parentId: 'folder_1' }], {
      bindingMode: 'mounted-folder', bindingRootNodeId: 'folder_1',
      collection: { schemaVersion: '0.1', id: 'col_1', kind: 'bookmarks', title: 'Canonical', rootNodeId: 'folder_1', visibility: 'private', createdAt: root.createdAt, updatedAt: root.updatedAt, revision: 'rev_7', extensions: extension },
    });
    const first = createSyncBootstrapSnapshotService({ authority: mounted, cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    const page = await first.query({ sessionId: 'ses_1', limit: 2 });
    expect(page.page.nextCursor!.length).toBeLessThanOrEqual(128);
    const restarted = createSyncBootstrapSnapshotService({ authority: mounted, cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    await expect(restarted.query({ sessionId: 'ses_1', limit: 2, pageCursor: page.page.nextCursor! })).resolves.toMatchObject({ page: { sequence: 2 } });
    await expect(restarted.query({ sessionId: 'ses_1', limit: 3, pageCursor: page.page.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor_scope' });
    await expect(restarted.query({ sessionId: 'ses_other', limit: 2, pageCursor: page.page.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor_scope' });
    const last = page.page.nextCursor!.at(-1);
    const tampered = `${page.page.nextCursor!.slice(0, -1)}${last === 'x' ? 'y' : 'x'}`;
    await expect(restarted.query({ sessionId: 'ses_1', limit: 2, pageCursor: tampered })).rejects.toBeInstanceOf(SyncBootstrapSnapshotError);
    const rotated = createSyncBootstrapSnapshotService({ authority: mounted, cursorSecret: 'y'.repeat(32), cursorKeyId: 'v2', attachmentExposure: DENY_ATTACHMENTS });
    await expect(rotated.query({ sessionId: 'ses_1', limit: 2, pageCursor: page.page.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor_scope' });
  });

  it.each([
    ['expired Session', { sessionExpiresAt: '2026-07-25T09:00:00.000Z' }, 'authentication_required'],
    ['generation mismatch', { leaseGeneration: 4 }, 'stale_replica'],
    ['policy change', { policyRevision: 'policy_5' }, 'snapshot_expired'],
  ] as const)('fails closed for %s without publishing mixed revisions', async (_name, drift, code) => {
    let calls = 0;
    const changing: SyncBootstrapAuthority = { async load(input) { calls += 1; return authority([root, ...children], calls === 1 ? {} : drift).load(input); } };
    const service = createSyncBootstrapSnapshotService({ authority: changing, cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'), attachmentExposure: DENY_ATTACHMENTS });
    const first = await service.query({ sessionId: 'ses_1', limit: 2 });
    await expect(service.query({ sessionId: 'ses_1', limit: 2, pageCursor: first.page.nextCursor! })).rejects.toMatchObject({ code });
  });

  it('serves recovery-required Replica bootstrap without activating it', async () => {
    const complete = vi.fn(async () => undefined);
    const recovery = { ...authority([root, ...children], { replicaState: 'recovery_required' }), markComplete: complete };
    const snapshot = await createSyncBootstrapSnapshotService({
      authority: recovery, cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'),
      attachmentExposure: DENY_ATTACHMENTS,
    }).query({ sessionId: 'ses_1' });
    expect(snapshot.syncCursor).toBe('ack_7');
    expect(complete).toHaveBeenCalledOnce();
    expect((await recovery.load({ sessionId: 'ses_1' })).replicaState).toBe('recovery_required');
  });

  it('keeps every recovery page on the same syncCursor and exposes the Ack capability as an independent field on the complete page', async () => {
    const pages: unknown[] = [];
    const complete = vi.fn(async () => undefined);
    const recovery: SyncBootstrapAuthority = {
      ...authority([root, ...children], { replicaState: 'recovery_required', protocolVersion: '0.2',
        parentRevisions: [
          { parentId: 'root_1', childrenRevision: 'root-children-r2' },
          { parentId: 'folder_1', childrenRevision: 'folder-children-r4' },
        ] }),
      async recordPage(page) { pages.push(page); },
      markComplete: complete,
      async issueRecoveryCapability() { return 'src1.recovery-v1.zz.claim.signature'; },
    };
    const service = createSyncBootstrapSnapshotService({ authority: recovery,
      cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'), attachmentExposure: DENY_ATTACHMENTS });
    const first = await service.query({ sessionId: 'ses_1', limit: 2 });
    expect(first.syncCursor).toBe('ack_7');
    expect(first.recoveryCapability).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    const second = await service.query({ sessionId: 'ses_1', limit: 2,
      pageCursor: first.page.nextCursor! });
    expect(second.syncCursor).toBe('ack_7');
    expect(second.recoveryCapability).toBe('src1.recovery-v1.zz.claim.signature');
    expect(pages).toMatchObject([{ sequence: 1, startOffset: 0, endOffset: 2, complete: false },
      { sequence: 2, startOffset: 2, endOffset: 4, complete: true }]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('keeps the legacy 0.1 recovery contract: the capability rides in syncCursor only on the final page', async () => {
    const complete = vi.fn(async () => undefined);
    const recovery: SyncBootstrapAuthority = {
      ...authority([root, ...children], { replicaState: 'recovery_required' }),
      markComplete: complete,
      async issueRecoveryCapability() { return 'src1.recovery-v1.zz.claim.signature'; },
    };
    const service = createSyncBootstrapSnapshotService({ authority: recovery,
      cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'), attachmentExposure: DENY_ATTACHMENTS });
    const first = await service.query({ sessionId: 'ses_1', limit: 2 });
    expect(first.syncCursor).toBe('ack_7');
    expect(first.recoveryCapability).toBeUndefined();
    const second = await service.query({ sessionId: 'ses_1', limit: 2,
      pageCursor: first.page.nextCursor! });
    expect(second.syncCursor).toBe('src1.recovery-v1.zz.claim.signature');
    expect(second.recoveryCapability).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('rejects duplicate canonical IDs and preserves nested unknown extension values', async () => {
    const service = createSyncBootstrapSnapshotService({ authority: authority([root, root]), cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS });
    await expect(service.query({ sessionId: 'ses_1' })).rejects.toThrow(/duplicate/i);
    const roundTrip = await createSyncBootstrapSnapshotService({ authority: authority([root, ...children]), cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS }).query({ sessionId: 'ses_1' });
    expect(JSON.parse(JSON.stringify(roundTrip.nodes[1]!.extensions))).toEqual(extension);
  });

  it('fails closed at composition when the attachment-exposure policy port is not composed', () => {
    // FIX-L-033 (SYNC-R17): an uncomposed policy is a composition error that
    // must fail loudly instead of silently allowing an attachment projection.
    expect(() => createSyncBootstrapSnapshotService({ authority: authority([root, ...children]),
      cursorSecret: 'x'.repeat(32) })).toThrow(/AttachmentExposurePolicyPort/);
  });

  it('consults the attachment-exposure policy with the session collection scope and keeps attachments empty', async () => {
    const scopes: string[] = [];
    const service = createSyncBootstrapSnapshotService({ authority: authority([root, ...children]),
      cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'),
      attachmentExposure: { async assertAttachmentsDenied(input) { scopes.push(input.collectionId); } } });
    const page = await service.query({ sessionId: 'ses_1', limit: 2 });
    expect(scopes).toEqual(['col_1']);
    expect(page.attachments).toEqual([]);
  });

  it('fails closed when the attachment-exposure policy errors', async () => {
    // FIX-L-033 (SYNC-R17): a throwing policy denies the Snapshot — the query
    // fails and no projection (with or without attachments) is produced.
    const policyError = new Error('exposure policy unavailable');
    const service = createSyncBootstrapSnapshotService({ authority: authority([root, ...children]),
      cursorSecret: 'x'.repeat(32), now: () => Date.parse('2026-07-25T10:00:00Z'),
      attachmentExposure: { async assertAttachmentsDenied() { throw policyError; } } });
    await expect(service.query({ sessionId: 'ses_1', limit: 2 })).rejects.toBe(policyError);
  });

  it('S-04 long URL / multibyte page budget trims to the fitting prefix and keeps every node reachable', async () => {
    const unicode = { ...children[1]!, parentId: 'root_1', title: '书签'.repeat(40),
      url: `https://example.test/${'a'.repeat(1_200)}` };
    const measured = await createSyncBootstrapSnapshotService({
      authority: authority([root, unicode], {
        protocolVersion: '0.2',
        parentRevisions: [{ parentId: 'root_1', childrenRevision: 'root-children-r2' }],
      }),
      cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS,
    }).query({ sessionId: 'ses_1', limit: 2 });
    const size = Buffer.byteLength(JSON.stringify(measured), 'utf8');
    const serviceWith = (budget: number) => createSyncBootstrapSnapshotService({
      authority: authority([root, unicode], {
        protocolVersion: '0.2', snapshotPageBytes: budget,
        parentRevisions: [{ parentId: 'root_1', childrenRevision: 'root-children-r2' }],
      }),
      cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS,
    });
    // F013: one byte under the two-node budget must not refuse the page — it
    // trims to the largest fitting prefix and every node stays reachable.
    const trimmed = serviceWith(size - 1);
    const first = await trimmed.query({ sessionId: 'ses_1', limit: 2 });
    expect(first.nodes.map((node) => node.id)).toEqual(['root_1']);
    expect(first.page).toMatchObject({ hasMore: true, sequence: 1 });
    const second = await trimmed.query({ sessionId: 'ses_1', limit: 2,
      pageCursor: first.page.nextCursor! });
    expect(second.nodes.map((node) => node.id)).toEqual(['bookmark_1']);
    expect(second.page).toMatchObject({ hasMore: false, nextCursor: null, sequence: 2 });
    await expect(serviceWith(size).query({ sessionId: 'ses_1', limit: 2 }))
      .resolves.toMatchObject({ snapshotId: measured.snapshotId, page: { hasMore: false } });
    await expect(serviceWith(size + 1).query({ sessionId: 'ses_1', limit: 2 }))
      .resolves.toMatchObject({ snapshotId: measured.snapshotId });
    // A single Node that alone exceeds the page budget stays inexpressible:
    // its page still fails payload_too_large instead of emitting empty progress.
    const oversized = { ...unicode, parentId: 'root_1', title: '书'.repeat(400),
      url: `https://example.test/${'a'.repeat(2_000)}` };
    const tight = createSyncBootstrapSnapshotService({
      authority: authority([root, oversized], {
        protocolVersion: '0.2', snapshotPageBytes: 2_048,
        parentRevisions: [{ parentId: 'root_1', childrenRevision: 'root-children-r2' }],
      }),
      cursorSecret: 'x'.repeat(32), attachmentExposure: DENY_ATTACHMENTS,
    });
    const head = await tight.query({ sessionId: 'ses_1', limit: 2 });
    expect(head.nodes.map((node) => node.id)).toEqual(['root_1']);
    expect(head.page.hasMore).toBe(true);
    await expect(tight.query({ sessionId: 'ses_1', limit: 2, pageCursor: head.page.nextCursor! }))
      .rejects.toMatchObject({ code: 'payload_too_large' });
  });
});
