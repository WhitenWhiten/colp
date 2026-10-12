import { test, expect } from 'vitest';
import { assertMigrationOrder } from '../../../scripts/check-migration-order.mjs';
test('CI rejects inserted migrations before the actual applied head, including between Automation files', () => {
  const baseline = ['202610290100_link_preview_object_bytes.ts', '202610300100_automation_configuration.ts', '202610300200_automation_runtime.ts'];
  expect(() => assertMigrationOrder(baseline, [...baseline, '202610300150_wrong_order.ts'])).toThrow('must sort after');
  expect(() => assertMigrationOrder(baseline, [...baseline, '202610120100_calendar_only.ts'])).toThrow('must sort after');
  expect(assertMigrationOrder(baseline, [...baseline, '202610300300_next.ts']).added).toEqual(['202610300300_next.ts']);
});
