import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
import { compilePredicate, validateAutomation } from '../../src/automation/index.js';
import rule from '../fixtures/automation/m1-placement.json' with { type: 'json' };

const leaf = { kind: 'field', field: 'bookmark.kind', op: 'eq', value: 'bookmark' };

test('recursive all/any validation stays bounded in a separately killable production-code process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-validation-'));
  try {
    const entry = join(directory, 'automation.cjs');
    await build({ entryPoints: ['src/automation/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: entry });
    const code = `
      const assert = require('node:assert/strict');
      const { compilePredicate, validateAutomation } = require(process.argv[1]);
      const rule = JSON.parse(process.argv[2]);
      for (const kind of ['all', 'any']) {
        for (const depth of [15, 16, 24, 30]) {
          let match = { kind: 'field', field: 'bookmark.kind', op: 'eq', value: 'bookmark' };
          for (let level = 0; level < depth; level++) match = { kind, items: [match] };
          const compiled = compilePredicate(match);
          assert.equal(compiled.valid, depth === 15);
          const input = { definition: { ...rule, match }, bindingSetId: 'bounded' };
          assert.equal(typeof validateAutomation('RuleInput', input).valid, 'boolean');
        }
      }
      process.stdout.write('recursive-validation-ok');
    `;
    const output = execFileSync(process.execPath, ['-e', code, entry, JSON.stringify(rule)], { timeout: 5000, encoding: 'utf8' });
    expect(output).toBe('recursive-validation-ok');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);

test.each([null, true, 1, 'field', [], {}, { kind: 'unknown' }])('tag dispatch never weakens Predicate shape: %j', value => {
  expect(validateAutomation('Predicate', value).valid).toBe(false);
});

test('selected recursive branches still reject extra keys and invalid nested operands', () => {
  expect(validateAutomation('Predicate', { kind: 'all', items: [leaf], extra: true }).valid).toBe(false);
  expect(validateAutomation('Predicate', { kind: 'any', items: [{ ...leaf, value: null }] }).valid).toBe(false);
  expect(validateAutomation('RuleInput', { definition: { ...rule, match: true }, bindingSetId: 'bounded' }).valid).toBe(false);
});

test('facts normalization is charged before reporting missingInput', () => {
  const compiled = compilePredicate(leaf);
  if (!compiled.valid) throw new Error('Invalid fixture');
  let tick = 0;
  expect(compiled.evaluate(null, { now: () => tick++ * 51 })).toEqual({ outcome: 'error', code: 'evaluationBudgetExceeded' });
  expect(compiled.evaluate(null).outcome).toBe('missingInput');
});
