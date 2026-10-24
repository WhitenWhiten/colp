import { expect, test } from 'vitest';
import { withDestinationPolicyBoundary, unsettledCloudDestination } from '../src/classification-destination-boundary.js';
import type { CaptureTask } from '../src/capture/contracts.js';
test('exclusion activation cannot overtake an admitted cloud dispatch', async () => {
  const events: string[] = []; let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  const dispatch = withDestinationPolicyBoundary(async () => { events.push('dispatch'); await response; events.push('response'); });
  const exclusion = withDestinationPolicyBoundary(async () => { events.push('exclude'); });
  await Promise.resolve(); expect(events).toEqual(['dispatch']); release(); await Promise.all([dispatch, exclusion]);
  expect(events).toEqual(['dispatch', 'response', 'exclude']);
});
test('unknown cloud commands block new exclusion authority; proven terminal results and local tasks do not', () => {
  const automatic = { decision: null, applySubmitted: false } as unknown as NonNullable<CaptureTask['automatic']>;
  expect(unsettledCloudDestination({ automatic })).toBe(true);
  expect(unsettledCloudDestination({ automatic, local: { commandId: 'local', state: 'running' } })).toBe(false);
  const decided = { ...automatic, decision: { status: 'suggested' } as NonNullable<typeof automatic.decision>, applySubmitted: true };
  expect(unsettledCloudDestination({ automatic: decided })).toBe(true);
  expect(unsettledCloudDestination({ automatic: { ...decided, applyState: 'rejected' } })).toBe(false);
  expect(unsettledCloudDestination({ automatic: { ...decided, applyState: 'applied' } })).toBe(false);
});
