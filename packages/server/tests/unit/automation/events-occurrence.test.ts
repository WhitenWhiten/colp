import { expect, test } from 'vitest';
import { wellFormedOccurrence } from '../../../src/infrastructure/automation/delivery-worker.js';

const data = { runId: 'run', jobId: 'job', ruleId: 'rule', ruleRevision: '1', targetId: 'target', matchedCount: 1, deliveryHandle: 'handle' };
const body = (patch: Record<string, unknown> = {}, dataPatch: Record<string, unknown> = {}) => JSON.stringify({
  eventId: 'event', name: 'colp.automation.triggered', timestamp: '2026-10-13T00:00:00Z', cursor: null, data: { ...data, ...dataPatch }, ...patch });

test('only occurrences matching the advertised payload schema leave the server', () => {
  expect(wellFormedOccurrence(body())).toBe(true);
  expect(wellFormedOccurrence(body({ name: 'other.event' }))).toBe(false);
  expect(wellFormedOccurrence(body({}, { matchedCount: '1' }))).toBe(false);
  expect(wellFormedOccurrence(body({}, { extra: 'field' }))).toBe(false);
  const { deliveryHandle: _handle, ...missing } = data;
  expect(wellFormedOccurrence(body({ data: missing }))).toBe(false);
  expect(wellFormedOccurrence('not json')).toBe(false);
});
