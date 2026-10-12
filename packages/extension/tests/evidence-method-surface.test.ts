import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  SYNC_STATE_EVIDENCE_MAX_ARGS, SYNC_STATE_EVIDENCE_METHODS, isSyncStateEvidenceMethod,
} from '../src/sw/evidence-methods.js';
import { validSyncStateEvidenceRequest } from '../src/sw/messages.js';

/**
 * The evidence channel dispatches on `message.method`, so the method name is the
 * whole surface. The validator must reject anything that is not dispatched, and
 * the allowlist must stay in step with the dispatcher.
 */

function request(overrides: Record<string, unknown> = {}) {
  return { kind: 'known.sync-state.evidence', method: 'exportScope', args: [], ...overrides };
}

test('an unlisted evidence method never reaches the dispatcher', () => {
  assert.equal(validSyncStateEvidenceRequest(request()), true);
  assert.equal(validSyncStateEvidenceRequest(request({ method: 'notADispatchedMethod' })), false);
  assert.equal(validSyncStateEvidenceRequest(request({ method: '__proto__' })), false);
  assert.equal(validSyncStateEvidenceRequest(request({ method: 'ExportScope' })), false,
    'method matching is exact, not case-insensitive');
});

test('argument count and serialized size are bounded', () => {
  assert.equal(validSyncStateEvidenceRequest(request({
    args: Array.from({ length: SYNC_STATE_EVIDENCE_MAX_ARGS }, () => 1),
  })), true);
  assert.equal(validSyncStateEvidenceRequest(request({
    args: Array.from({ length: SYNC_STATE_EVIDENCE_MAX_ARGS + 1 }, () => 1),
  })), false);
  assert.equal(validSyncStateEvidenceRequest(request({ args: ['x'.repeat(70 * 1024)] })), false);
  assert.equal(validSyncStateEvidenceRequest({ kind: 'known.sync-state.evidence',
    method: 'exportScope', args: [], extra: true }), false, 'unknown keys are rejected');
});

test('the allowlist matches the dispatched cases in evidence.ts', () => {
  // A method added to the dispatcher without the allowlist would be unreachable
  // in every build; one removed from the dispatcher would be dead weight here.
  const source = readFileSync(new URL('../src/sw/evidence.ts', import.meta.url), 'utf8');
  const dispatched = [...source.matchAll(/case '([A-Za-z0-9_]+)':/gu)].map((match) => match[1]);
  assert.deepEqual([...SYNC_STATE_EVIDENCE_METHODS].sort(), [...new Set(dispatched)].sort());
  for (const method of SYNC_STATE_EVIDENCE_METHODS) {
    assert.equal(isSyncStateEvidenceMethod(method), true);
    assert.equal(validSyncStateEvidenceRequest(request({ method })), true, `${method} must validate`);
  }
});
