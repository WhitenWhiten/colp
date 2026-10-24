import type { ReplicaHealthIssue } from './sync-issue-snapshot.js';
import type { MappingInput, SyncScope } from './sync-state-store.js';

/** A move or delete names its target by id only; a window of lookups is plenty for the rows anyone reads. */
const MAX_LOOKUPS = 50;
const TITLE_MAX = 200;

export type MappingByColpId = (scope: SyncScope, colpId: string) => Promise<MappingInput | null | undefined>;

/**
 * Names the items that carry no title of their own. A change that moves or
 * deletes a bookmark records which node it is about, not what it was called,
 * so its row would read as a bare code. The mapping keeps the last title this
 * browser knew for the node; a missing or unreadable mapping leaves the row as
 * it was (the row then falls back to a plain stand-in).
 */
export async function withResolvedTitles<T extends ReplicaHealthIssue>(issues: readonly T[], scope: SyncScope,
  lookup: MappingByColpId | undefined): Promise<T[]> {
  if (!lookup) return [...issues];
  const names = new Map<string, string | undefined>();
  const out: T[] = [];
  for (const issue of issues) {
    if (issue.title || !issue.nodeId) { out.push(issue); continue; }
    if (!names.has(issue.nodeId)) {
      let title: string | undefined;
      if (names.size < MAX_LOOKUPS) {
        try {
          const raw = (await lookup(scope, issue.nodeId))?.projection.content?.title;
          title = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, TITLE_MAX) : undefined;
        } catch { title = undefined; }
      }
      names.set(issue.nodeId, title);
    }
    const title = names.get(issue.nodeId);
    out.push(title ? { ...issue, title } : issue);
  }
  return out;
}
