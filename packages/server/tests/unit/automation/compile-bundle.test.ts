import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { compileBundle } from '../../../src/modules/automation/application/compile-bundle.js';
import type { RuleDefinition } from '@know-n/colp/automation';
const definition = JSON.parse(readFileSync('../node/tests/fixtures/automation/m1-placement.json', 'utf8')) as RuleDefinition;
const rule = { ruleId: 'rule', ruleRevision: '1', bindingRevision: '1', definition, values: {} };
const input = { revision: '1', settingsRevision: 0, paused: false, now: new Date('2026-10-12T00:00:00Z'), previousRuleIds: [], profile: 'browser-bounded-v1' };
test('generic finite path predicate and priority survive packaging without host-only approximation', () => {
  const modified = { ...definition, priority: 7, match: { kind: 'field' as const, field: 'bookmark.url.path' as const, op: 'startsWith' as const, value: '/docs/' } };
  const bundle = compileBundle({ ...input, rules: [{ ...rule, definition: modified }] });
  expect(bundle.rules[0]!.definition).toEqual(modified); expect(bundle.rules[0]!.programId).toBe('fieldFilter');
});
test('oversized full snapshots fail instead of truncating or digesting a partial ruleset', () => {
  expect(() => compileBundle({ ...input, rules: Array(1001).fill(rule) })).toThrow('bounds');
  expect(() => compileBundle({ ...input, rules: Array.from({ length: 500 }, (_, i) => ({ ...rule, ruleId: `rule-${i}`, definition: { ...definition, description: 'x'.repeat(2000) } })) })).toThrow('1 MiB');
});
