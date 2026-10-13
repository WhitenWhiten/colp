import { test, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { assertMigrationOrder, assertUniquePrefixes } from '../../../scripts/check-migration-order.mjs';
test('CI rejects inserted migrations before the actual applied head, including between Automation files', () => {
  const baseline = ['202610290100_link_preview_object_bytes.ts', '202610300100_automation_configuration.ts', '202610300200_automation_runtime.ts'];
  expect(() => assertMigrationOrder(baseline, [...baseline, '202610300150_wrong_order.ts'])).toThrow('must sort after');
  expect(() => assertMigrationOrder(baseline, [...baseline, '202610120100_calendar_only.ts'])).toThrow('must sort after');
  expect(assertMigrationOrder(baseline, [...baseline, '202610300300_next.ts']).added).toEqual(['202610300300_next.ts']);
});

test('G9: migration prefixes are unique so merges cannot interleave applied files', () => {
  expect(() => assertUniquePrefixes(['202610301000_a.ts', '202610301000_b.ts'])).toThrow('share prefix 202610301000');
  const automation = readdirSync(new URL('../../../migrations/', import.meta.url)).filter((name) => /^\d+_.*\.ts$/.test(name) && name > '202610290100_link_preview_object_bytes.ts');
  expect(() => assertUniquePrefixes(readdirSync(new URL('../../../migrations/', import.meta.url)), automation)).not.toThrow();
});
