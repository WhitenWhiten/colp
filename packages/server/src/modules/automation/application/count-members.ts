import { automationDigest, normalizeUrlIdentity, NORMALIZER_VERSION, type EventFacts, type RuleDefinition } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';

type CountTrigger = Extract<RuleDefinition['trigger'], { mode: 'countBatch' }>;

export function countPartition(trigger: CountTrigger, event: EventFacts, ruleId: string) {
  return { kind: trigger.partition, key: trigger.partition === 'folder' ? event.bookmark.parent?.nodeId ?? ''
    : trigger.partition === 'collection' ? event.collectionId : ruleId };
}

export function countDistinctKey(trigger: CountTrigger, event: EventFacts, rawUrl?: string): string {
  if (trigger.distinctBy === 'node') return event.nodeId;
  if (!rawUrl) throw new AutomationError('automation_unsupported_capability',
    'normalizedUrl batch estimates require full canonical URLs; use currentState preview instead of supplied facts.');
  // The shared core normalizer, so browser and server agree on what counts as the same URL.
  // URLs it does not accept (javascript:, file:) are distinct by their exact text.
  return automationDigest({ normalizer: NORMALIZER_VERSION, url: normalizeUrlIdentity(rawUrl) ?? rawUrl });
}

export function estimateCountMembers(trigger: CountTrigger, members: readonly { event: EventFacts; url?: string }[]) {
  const partitions = new Map<string, Set<string>>();
  for (const { event, url } of members) {
    const partition = automationDigest(countPartition(trigger, event, 'preview'));
    const distinct = partitions.get(partition) ?? new Set<string>();
    distinct.add(countDistinctKey(trigger, event, url));
    partitions.set(partition, distinct);
  }
  return [...partitions.values()].reduce((count, members) => ({
    plannedRunCount: count.plannedRunCount + Math.floor(members.size / trigger.count),
    remainderCount: count.remainderCount + members.size % trigger.count,
  }), { plannedRunCount: 0, remainderCount: 0 });
}
