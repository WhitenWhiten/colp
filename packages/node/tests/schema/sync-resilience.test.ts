import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createValidatorRegistry } from '../../src/schema/index.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/protocol/examples/${name}.json`, import.meta.url), 'utf8'));
const health = read('sync-replica-health');
const result = read('sync-replica-health-result');
const validators = createValidatorRegistry();

describe('optional replica health wire contracts', () => {
  it('validates the report and command examples with the 0.2 registry', () => {
    expect(validators.validate('syncReplicaHealthReport', health).valid).toBe(true);
    expect(validators.validate('syncReplicaHealthResult', result).valid).toBe(true);
    expect(validators.validate('syncReplicaCommand', result.commands[0]).valid).toBe(true);
    // Multiple structured items must work through the registry's immutable snapshot.
    const items = [health.issues.items[0], { ...health.issues.items[0], issueId: 'other', count: 2 }];
    expect(validators.validate('syncReplicaHealthReport', { ...health, issues: { total: 2, items },
      commandResults: [{ commandId: 'one', outcome: 'done' }, { commandId: 'two', outcome: 'failed', code: 'issue_gone' }] }).valid).toBe(true);
  });

  it('keeps health optional, validates a credential-free HTTPS endpoint, and preserves 0.1', () => {
    const base = read('public-manifest');
    const manifest = { ...base, protocol: 'https://know-n.com/colp/spec/0.2', protocolVersions: ['0.1', '0.2'],
      syncEffectPages: 'https://alice.example/effects/{effectId}/{pageNumber}' };
    expect(validators.validate('manifestV02', manifest).valid).toBe(true);
    expect(validators.validate('manifestV02', { ...manifest, syncReplicaHealth: 'https://alice.example/health' }).valid).toBe(true);
    for (const endpoint of ['http://alice.example/health', 'https://alice.example/health?token=x',
      'https://secret@alice.example/health', 'https://alice.example/health#fragment', 'https://alice.example/{replicaId}']) {
      expect(validators.validate('manifestV02', { ...manifest, syncReplicaHealth: endpoint }).valid, endpoint).toBe(false);
    }
    expect(validators.validate('manifest', base).valid).toBe(true);
    expect(validators.validate('manifest', { ...base, syncReplicaHealth: 'https://alice.example/health' }).valid).toBe(false);
  });

  it('rejects unbounded, secret-bearing and malformed report fields', () => {
    const item = health.issues.items[0];
    for (const invalid of [
      { ...health, extra: true }, { ...health, state: 'unknown' }, { ...health, state: 'stopped', code: undefined },
      { ...health, code: 'Bad Code' }, { ...health, revision: 0 }, { ...health, since: 'yesterday' },
      { ...health, issues: { total: -1, items: [] } },
      { ...health, issues: { total: 51, items: Array.from({ length: 51 }, (_, n) => ({ ...item, issueId: `issue-${n}` })) } },
      { ...health, issues: { total: 1, items: [{ ...item, title: 'x'.repeat(257) }] } },
      { ...health, issues: { total: 1, items: [{ ...item, nativeId: '42' }] } },
      { ...health, actions: ['discard_local'] },
      { ...health, commandResults: Array.from({ length: 17 }, (_, n) => ({ commandId: `command-${n}`, outcome: 'done' })) },
    ]) expect(validators.validate('syncReplicaHealthReport', invalid).valid).toBe(false);
  });

  it('commands carry identities and actions, never data; standard warnings retain the existing envelope', () => {
    const reset = { commandId: 'reset', action: 'rebuild', replicaRetired: true };
    expect(validators.validate('syncReplicaCommand', reset).valid).toBe(true);
    for (const invalid of [{ ...reset, action: 'retry' }, { ...reset, issueId: 'one' }, { ...reset, replicaRetired: false }]) {
      expect(validators.validate('syncReplicaCommand', invalid).valid).toBe(false);
    }
    for (const invalid of [{ ...result.commands[0], payload: { title: 'New' } },
      { ...result.commands[0], action: 'format_disk' }, { commandId: '', action: 'retry' }]) {
      expect(validators.validate('syncReplicaCommand', invalid).valid).toBe(false);
    }
    for (const code of ['apply_set_aside', 'placement_unproven', 'identity_unproven', 'record_invalid', 'delete_held']) {
      const warning = { code, message: 'This browser set this node aside.', path: '/nodes/node-1', nodeId: 'node-1' };
      expect(validators.validate('syncSetAsideWarning', warning).valid).toBe(true);
      expect(validators.validate('warning', warning).valid).toBe(true);
    }
  });
});
