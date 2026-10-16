import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const serverDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const assertions = `
  assert.equal(typeof core.preparePredicateInput, 'function',
    'The installed Automation package is stale; update @know-n/colp and regenerate both dependency locks.');
  const facts = {
    eventId: 'packaged-event', operationId: 'packaged-operation', type: 'node.created',
    collectionId: 'packaged-collection', nodeId: 'packaged-node', commitOrdinal: '1',
    occurredAt: '2026-10-13T09:00:00Z', origin: 'user', changedFields: ['create'], hopCount: 0,
    bookmark: { kind: 'bookmark', url: { host: 'ARXIV.ORG.', path: '/abs/fixture' }, title: 'Fixture', tags: [] },
  };
  const predicate = { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' };
  const compiled = core.compilePredicate(predicate);
  assert.equal(compiled.valid, true);
  const now = () => 0; // This test isolates the package contract, not scheduler timing.
  const inputSnapshot = core.preparePredicateInput(facts, { now });
  assert.equal(compiled.evaluate(facts, { inputSnapshot, now }).outcome, 'matched');
  // The compiled evaluator and public snapshot factory must share one registry.
  // Mutating the caller's object cannot mutate the privately captured snapshot.
  facts.bookmark.url.host = 'different.example';
  assert.equal(compiled.evaluate(facts, { inputSnapshot, now }).outcome, 'matched');
  assert.equal(compiled.evaluate(facts, { now }).outcome, 'notMatched');
  assert.equal(compiled.evaluate(facts, { inputSnapshot: {}, now }).outcome, 'error');
  assert.equal(compiled.evaluate(structuredClone(facts), { inputSnapshot, now }).outcome, 'error');
  // Exercise the shipped validator, not only the sibling TypeScript sources.
  // A killable subprocess bounds an accidental return to exponential all/any validation.
  let nested = predicate;
  for (let depth = 0; depth < 22; depth++) nested = { kind: 'all', items: [nested] };
  assert.equal(core.validateAutomation('Predicate', nested).valid, true);
  assert.equal(core.compilePredicate(nested).valid, false);
  assert.equal(core.validateAutomation('Predicate', { ...predicate, unexpected: true }).valid, false);
  const rule = JSON.parse(readFileSync('../node/tests/fixtures/automation/m1-placement.json', 'utf8'));
  assert.equal(core.validateAutomation('PreviewInput', { rule: { definition: rule, bindingSetId: 'b' }, ruleId: 'owned-rule', mode: 'currentState' }).valid, true);
  assert.equal(core.validateAutomation('ChangeInput', { definition: rule, bindingSetId: 'b', executionPolicyId: null, pendingRuns: 'hold', counterPolicy: 'resetOnSemanticChange' }).valid, true);
  process.stdout.write('packaged-automation-ok');
`;

for (const format of ['module', 'commonjs'] as const) {
  test(`installed Automation ${format} exports and hardened behavior agree`, () => {
    const imports = format === 'module'
      ? "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import * as core from '@know-n/colp/automation';"
      : "const assert = require('node:assert/strict'); const { readFileSync } = require('node:fs'); const core = require('@know-n/colp/automation');";
    const result = execFileSync(process.execPath, [`--input-type=${format}`, '-e', imports + assertions], {
      cwd: serverDirectory,
      timeout: 10_000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
    expect(result).toBe('packaged-automation-ok');
  }, 15_000);
}
