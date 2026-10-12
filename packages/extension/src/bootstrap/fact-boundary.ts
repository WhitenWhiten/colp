import { bookmarkRepresentability } from '../bookmark-event-codec.js';
import type { LocalNodeFact, MountFact } from './matcher.js';

/** Recheck durable/inbox facts too: they can predate the current boundary. */
export function filterBootstrapFacts(input: {
  readonly facts: readonly LocalNodeFact[];
  readonly parents: readonly { readonly nativeId: string; readonly parentNativeId?: string }[];
  readonly mounts: readonly MountFact[];
  readonly privateNativeIds: readonly string[];
  readonly excludedNativeIds: readonly string[];
}) {
  const privateIds = new Set(input.privateNativeIds); const excluded = new Set(input.excludedNativeIds);
  const mounts = new Set(input.mounts.map(mount => mount.nativeRootId));
  const parents = new Map(input.parents.map(row => [row.nativeId, row.parentNativeId]));
  const reasons = new Map<string, string>();
  for (const row of input.facts) {
    parents.set(row.nativeId, row.parentNativeId ?? undefined);
    if (row.managed) reasons.set(row.nativeId, 'managed');
    else if (row.privateLocal || privateIds.has(row.nativeId)) reasons.set(row.nativeId, 'private_local');
    else if (!mounts.has(row.nativeId)) {
      const reason = bookmarkRepresentability({ type: row.kind, title: row.title, url: row.url });
      if (reason !== 'supported') reasons.set(row.nativeId, reason);
    }
  }
  const skipped: Array<{ nativeId: string; reason: string }> = [];
  const facts = input.facts.filter(row => {
    let id: string | undefined = row.nativeId; const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const reason = privateIds.has(id) ? 'private_local' : excluded.has(id) ? 'unselected_range' : reasons.get(id);
      if (reason) { skipped.push({ nativeId: row.nativeId, reason }); return false; }
      id = parents.get(id);
    }
    return true;
  });
  return { facts, skipped };
}
