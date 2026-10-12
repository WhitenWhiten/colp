import type { FolderRef } from './types.generated.js';
export interface PlacementCandidate {
  ruleId: string;
  priority: number;
  folder: FolderRef;
  authorized: boolean;
  privacyAllowed: boolean;
  tags?: readonly string[];
}
export type PlacementDecision =
  | { kind: 'place'; folder: FolderRef; ruleIds: string[]; satisfiedTasks: ['classify.root']; tags: string[] }
  | { kind: 'keepParent' | 'review' | 'blocked' | 'conflict'; ruleIds: string[]; satisfiedTasks: []; tags: string[]; reason: string };
const identity = (ref: FolderRef) => JSON.stringify([ref.serverUuid, ref.collectionId, ref.nodeId]);
export function arbitratePlacement(candidates: readonly PlacementCandidate[], options: { explicitSelection?: boolean; intentKnown?: boolean } = {}): PlacementDecision {
  const allowed = candidates.filter((item) => item.authorized && item.privacyAllowed);
  const tags = [...new Set(allowed.flatMap((item) => item.tags ?? []))].sort();
  const ruleIds = candidates.map((item) => item.ruleId).sort();
  if (options.explicitSelection) return { kind: 'keepParent', ruleIds, satisfiedTasks: [], tags, reason: 'explicitChoice' };
  if (options.intentKnown === false) return { kind: 'review', ruleIds, satisfiedTasks: [], tags, reason: 'unknownIntent' };
  if (!allowed.length) return { kind: candidates.length ? 'blocked' : 'keepParent', ruleIds, satisfiedTasks: [], tags, reason: candidates.length ? 'authorityOrPrivacy' : 'noMatch' };
  const priority = Math.max(...allowed.map((item) => item.priority));
  const winners = allowed.filter((item) => item.priority === priority).sort((a, b) => a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);
  if (new Set(winners.map((item) => identity(item.folder))).size > 1) return {
    kind: 'conflict', ruleIds: winners.map((item) => item.ruleId), satisfiedTasks: [], tags, reason: 'equalPriorityDestinations',
  };
  return { kind: 'place', folder: { ...winners[0]!.folder }, ruleIds: winners.map((item) => item.ruleId), satisfiedTasks: ['classify.root'], tags };
}
