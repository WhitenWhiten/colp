import { normalizeUrl, type BookmarkFacts, type EventFacts } from '@know-n/colp/automation';
import type { AutomationSource } from './source-position-store.js';
import type { AutomationNodeSnapshot } from './fact-capture.js';
export function sourceEvent(source: AutomationSource, serverUuid: string, collectionId: string, rootNodeId: string): EventFacts | null {
  const facts = source.facts_json;
  if (source.facts_version !== 1 || !facts || !source.source_event_id || !source.node_id || !source.occurred_at
    || facts.after?.kind !== 'bookmark' || !facts.after.ancestryComplete) return null;
  const folder = (nodeId: string) => ({ serverUuid, collectionId, nodeId });
  const bookmark = (snapshot: AutomationNodeSnapshot): BookmarkFacts => {
    const url = normalizeUrl(snapshot.url ?? '');
    return { kind: 'bookmark', nodeId: source.node_id!, title: snapshot.title ?? '', tags: [...snapshot.tags],
      url: url.status === 'available' ? { host: url.host, path: url.path } : { host: '' },
      ...(snapshot.parentId ? { parent: folder(snapshot.parentId) } : {}), ancestors: snapshot.ancestorIds.map(folder) };
  };
  const origin = source.origin === 'web' || source.origin === 'mcp' ? 'user'
    : source.origin === 'sync' || source.origin === 'import' || source.origin === 'restore' || source.origin === 'automation' ? source.origin : 'system';
  return { eventId: source.source_event_id, operationId: source.operation_id, collectionId, nodeId: source.node_id,
    commitOrdinal: source.commit_ordinal, occurredAt: source.occurred_at.toISOString(),
    type: `node.${facts.action === 'create' ? 'created' : facts.action === 'move' ? 'moved' : facts.action === 'update' ? 'updated' : facts.action}`,
    origin, hopCount: facts.hopCount, ...(facts.rootRunId ? { rootRunId: facts.rootRunId } : {}), ...(facts.stageId ? { stageId: facts.stageId } : {}),
    changedFields: facts.action === 'create' ? ['create'] : ['url', 'title', 'tags', 'parent'].filter(key => {
      const field = key === 'parent' ? 'parentId' : key as 'url' | 'title' | 'tags';
      return JSON.stringify(facts.before?.[field]) !== JSON.stringify(facts.after?.[field]);
    }), bookmark: bookmark(facts.after), ...(facts.before?.kind === 'bookmark' ? { before: bookmark(facts.before) } : {}),
    intakeDisposition: facts.action !== 'create' || !['user', 'sync'].includes(origin) ? 'notIntake'
      : (facts.after.parentId === rootNodeId || facts.after.parentIsIntakeRoot === true) ? 'userDefault' : 'userSelected' };
}
