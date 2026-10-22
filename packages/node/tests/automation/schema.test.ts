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

  test('guided setup has one agent destination and paired rule revision inputs', () => {
    const input = { definition: rule, bindings: { name: 'Test', values: {} },
      agent: { name: 'ChatGPT', clientId: 'https://chatgpt.com/oauth/client.json' } };
    expect(validateAutomation('AgentSetupInput', input).valid).toBe(true);
    expect(validateAutomation('AgentSetupInput', { ...input, targetId: 'target' }).valid).toBe(false);
    expect(validateAutomation('AgentSetupInput', { ...input, ruleId: 'rule' }).valid).toBe(false);
    expect(validateAutomation('AgentSetupInput', { ...input, ruleRevision: '1' }).valid).toBe(false);
    expect(validateAutomation('AgentSetupInput', { ...input, ruleId: 'rule', ruleRevision: '1' }).valid).toBe(true);
    expect(validateAutomation('AgentSetupInput', { ...input, allowAutomaticWrites: true }).valid).toBe(false);
  });

  test('connection profiles accept opaque and HTTPS CIMD client identities without widening other IDs', () => {
    const profile = { name: 'ChatGPT', automationEnabled: true, catalogs: ['standard', 'automationWorker'],
      credentialBindingId: 'pending-owner-chose-agent' };
    const valid = ['https://chatgpt.com/oauth/client.json', 'client-1._~', 'x'.repeat(256),
      `https://agent.example/${'x'.repeat(2026)}`, 'HTTPS://agent.example/client.json?version=1'];
    for (const authorizedClientId of valid) {
      const input = { ...profile, authorizedClientId };
      expect(validateAutomation('ConnectionProfileInput', input), authorizedClientId).toEqual({ valid: true, issues: [] });
      expect(validateAutomation('ConnectionProfile', { id: 'profile', revision: '1', configuration: input, eventsSupport: 'unknown' }).valid).toBe(true);
    }
    for (const authorizedClientId of ['', 'x'.repeat(257), 'http://agent.example/client.json',
      'https://', 'https://user:password@agent.example/client.json', 'https://agent.example/client.json#fragment',
      'https://agent.example/client name.json', 'https://agent.example/client\n.json',
      `https://agent.example/${'x'.repeat(2027)}`]) {
      expect(validateAutomation('ConnectionProfileInput', { ...profile, authorizedClientId }).valid, authorizedClientId).toBe(false);
    }
    const input = { ...profile, authorizedClientId: valid[0] };
    expect(validateAutomation('ConnectionProfileInput', { ...input, unexpected: true }).valid).toBe(false);
    expect(validateAutomation('ConnectionProfileInput', { ...input, credentialBindingId: valid[0] }).valid).toBe(false);
    expect(validateAutomation('OpaqueId', valid[0]).valid).toBe(false);
  });
});
