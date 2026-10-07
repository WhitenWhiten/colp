import { expect, test } from 'vitest';
import { CAPTURE_POLICY_VERSION, parseCaptureDecisionInput } from '../../../src/modules/collections/index.js';

const input = { captureId: '00000000-0000-4000-8000-000000000000', nodeId: 'node', nodeEtag: '"r1"', policyVersion: CAPTURE_POLICY_VERSION,
  controlGeneration: 0, periodPoints: 10, billing: { priceVersion: 'v1', maxPoints: 1 } };

test('a capture may state the browser tag mode; older clients omit it', () => {
  expect(parseCaptureDecisionInput(input)).toEqual(input);
  for (const tagMode of ['off', 'suggest', 'add']) expect(parseCaptureDecisionInput({ ...input, tagMode })).toMatchObject({ tagMode });
  for (const tagMode of ['auto', null, true]) expect(() => parseCaptureDecisionInput({ ...input, tagMode })).toThrow('invalid_request');
  expect(() => parseCaptureDecisionInput({ ...input, extra: 'add' })).toThrow('invalid_request');
});
