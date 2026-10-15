import { describe, expect, test } from 'vitest';
import rule from '../fixtures/automation/m1-placement.json' with { type: 'json' };
import { validateAutomation } from '../../src/automation/index.js';

describe('reviewed closed Automation schema', () => {
  test('M1 needs no tasks, policy, executor or credential', () => {
    expect(validateAutomation('RuleInput', { definition: rule, bindingSetId: 'bindings_test' }).valid).toBe(true);
  });
  test('rejects unknown keys, versions and invalid task count', () => {
    expect(validateAutomation('RuleDefinition', { ...rule, secret: 'x' }).valid).toBe(false);
    expect(validateAutomation('RuleDefinition', { ...rule, apiVersion: 'v99' }).valid).toBe(false);
    expect(validateAutomation('RuleDefinition', { ...rule, tasks: Array(9).fill({}) }).valid).toBe(false);
  });
  test('preview modes have closed, conditional inputs', () => {
    const input = { rule: { definition: rule, bindingSetId: 'b' }, mode: 'currentState' };
    expect(validateAutomation('PreviewInput', input).valid).toBe(true);
    expect(validateAutomation('PreviewInput', { ...input, ruleId: 'owned-rule' }).valid).toBe(true);
    expect(validateAutomation('PreviewInput', { ...input, ruleId: '' }).valid).toBe(false);
    expect(validateAutomation('PreviewInput', { ...input, events: [] }).valid).toBe(false);
    expect(validateAutomation('PreviewInput', { ...input, mode: 'supplied' }).valid).toBe(false);
  });
  test('replacement distinguishes preserving a policy from explicit removal', () => {
    const input = { definition: rule, bindingSetId: 'b', pendingRuns: 'hold', counterPolicy: 'resetOnSemanticChange' };
    for (const patch of [{}, { executionPolicyId: 'policy' }, { executionPolicyId: null }])
      expect(validateAutomation('ChangeInput', { ...input, ...patch }).valid).toBe(true);
    expect(validateAutomation('ChangeInput', { ...input, executionPolicyId: '' }).valid).toBe(false);
  });
  test('bounds recursive input and rejects cycles before schema evaluation', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(validateAutomation('RuleDefinition', cycle).valid).toBe(false);
  });
});
