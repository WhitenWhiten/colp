import { expect, test } from 'vitest';
import { automationDigest } from '@know-n/colp/automation';
import { automationDigestV1 } from '../../../migrations/lib/automation-digest-v1.js';

test('the frozen migration digest equals the runtime digest for the values migrations hash', () => {
  for (const value of [
    { kind: 'folder', key: '', binding: '1', policy: null },
    { kind: 'rule', key: 'rule-id', binding: '12', policy: '3' },
    { academicRoot: { kind: 'folder', folder: { serverUuid: 's', collectionId: 'c', nodeId: 'n' }, followIdentity: true, notifyOn: ['rename', 'move'] },
      'ü-role': { kind: 'executor', executorId: 'e', z: 1.5, a: [true, false, null] } },
  ]) expect(automationDigestV1(value)).toBe(automationDigest(value));
});
