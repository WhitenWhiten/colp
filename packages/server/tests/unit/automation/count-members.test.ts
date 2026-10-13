import { expect, test } from 'vitest';
import { estimateCountMembers } from '../../../src/modules/automation/application/count-members.js';
import type { EventFacts } from '@know-n/colp/automation';
const event = (nodeId: string, folder: string) => ({ nodeId, collectionId: 'c',
  bookmark: { parent: { nodeId: folder } } }) as EventFacts;

test('partitioning precedes counting and repeated nodes are distinct only once per partition', () => {
  const trigger = { mode: 'countBatch', count: 2, partition: 'folder', distinctBy: 'node' } as const;
  expect(estimateCountMembers(trigger, ['a', 'b'].map((id, i) => ({ event: event(id, String(i)) }))))
    .toEqual({ plannedRunCount: 0, remainderCount: 2 });
  expect(estimateCountMembers(trigger, ['a', 'a', 'b'].map(id => ({ event: event(id, 'folder') }))))
    .toEqual({ plannedRunCount: 1, remainderCount: 0 });
});

test('full normalized URLs preserve queries, remove fragments and reject insufficient supplied facts', () => {
  const trigger = { mode: 'countBatch', count: 2, partition: 'rule', distinctBy: 'normalizedUrl' } as const;
  expect(estimateCountMembers(trigger, [
    { event: event('a', 'x'), url: 'https://EXAMPLE.com./p?q=1#one' },
    { event: event('b', 'y'), url: 'https://example.com/p?q=1#two' },
  ])).toEqual({ plannedRunCount: 0, remainderCount: 1 });
  expect(() => estimateCountMembers(trigger, [{ event: event('a', 'x') }])).toThrow('full canonical URLs');
});
