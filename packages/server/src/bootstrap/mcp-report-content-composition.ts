import { getPublicationSnapshotPage, type PublicationSnapshotQueryPorts } from '../modules/publication/index.js';
import { decodeOwnedSnapshotCursor, projectOwnedSnapshot, PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX, type Phase4bMcpOwnedCollectionReadPort, type ReportIssueContentReader } from '../modules/mcp/index.js';

export function createReportIssueContentReader(
  owned: Phase4bMcpOwnedCollectionReadPort,
  publication: PublicationSnapshotQueryPorts,
): ReportIssueContentReader {
  return async input => {
    if (!input.publicOnly && (input.cursor === undefined || input.cursor.startsWith(PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX))) {
      const after = input.cursor === undefined ? undefined : decodeOwnedSnapshotCursor(input.collectionId, input.cursor);
      if (input.cursor !== undefined && !after) throw new Error('invalid_cursor');
      const record = await owned.readSnapshot({ collectionId: input.collectionId, actorSubjectId: input.subjectId!, limit: 100,
        ...(after === undefined ? {} : { after }) });
      if (record) {
      if (record.consistency !== 'version-fenced') throw new Error('not_found');
      const page = projectOwnedSnapshot(record, input.cursor);
      return { items: [...(input.cursor === undefined && page.root ? [page.root] : []), ...(page.nodes as readonly unknown[])],
        revision: `${record.collection.contentRevision}:${record.collection.policyRevision}`,
        nextCursor: (page.page as { nextCursor: string | null }).nextCursor };
      }
      if (input.cursor !== undefined) throw new Error('not_found');
    }
    const page = await getPublicationSnapshotPage(publication, { collectionId: input.collectionId,
      principal: { kind: 'anonymous' }, query: { limit: 100, ...(input.cursor ? { pageCursor: input.cursor } : {}) } });
    return { items: page.snapshot.nodes.filter(node => !input.cursor || node.id !== page.snapshot.collection.rootNodeId),
      revision: page.snapshot.revision, nextCursor: page.nextCursor };
  };
}
