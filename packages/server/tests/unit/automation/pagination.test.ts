import { expect, test } from 'vitest';
import { createAutomationPagination } from '../../../src/modules/automation/index.js';

test('a continuation keeps its signed limit while rejecting changed limits, owners and resource types', () => {
  const pages = createAutomationPagination('automation-pagination-test-key-at-least-32'), now = new Date('2026-10-30T12:00:00Z');
  const after = { id: 'last', createdAt: now.toISOString() }, cursor = pages.next('owner', 'profiles', 1, after, now);
  expect(pages.read({ cursor }, 'owner', 'profiles', now)).toEqual({ limit: 1, after });
  expect(pages.read({ cursor, limit: '1' }, 'owner', 'profiles', now)).toEqual({ limit: 1, after });
  expect(() => pages.read({ cursor, limit: '2' }, 'owner', 'profiles', now)).toThrow('Invalid or expired');
  expect(() => pages.read({ cursor }, 'foreign', 'profiles', now)).toThrow('Invalid or expired');
  expect(() => pages.read({ cursor }, 'owner', 'targets', now)).toThrow('Invalid or expired');
});
