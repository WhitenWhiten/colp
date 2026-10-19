import { expect, test } from 'vitest';
import fixture from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };
import type { RuleDefinition } from '@know-n/colp/automation';
import { buildAutomationExport } from '../../../src/modules/automation/domain/export.js';

test('the export boundary returns a capacity problem instead of an internal error', () => {
  const rule = { definition: fixture as RuleDefinition, desiredState: 'draft' as const, bindingsByPath: {} };
  expect(buildAutomationExport(Array.from({ length: 500 }, () => rule), new Date()).rules).toHaveLength(500);
  expect(() => buildAutomationExport(Array.from({ length: 501 }, () => rule), new Date()))
    .toThrow(expect.objectContaining({ code: 'payload_too_large' }));
});
