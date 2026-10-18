import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PullAckFacts, PullCursorWriteFacts } from '../src/pull-ack-boundary.js';

export type Action = { kind: 'publish'; hasWait: boolean }
  | { kind: 'ack'; page: number }
  | { kind: 'confirm'; page: number; generation: number; proof: boolean }
  | { kind: 'prune' | 'crash' };
export interface Observation {
  published: number;
  serverAck: number;
  rows: Array<{ page: number; generation: number; settled: boolean }>;
}
export interface Trace {
  name: string;
  initial: Observation;
  checkpoints: Array<{ action: Action; expected: Observation }>;
}
interface Vectors {
  schemaVersion: number;
  orders: Array<{ left: string; right: string; expected: string }>;
  acks: Array<{ input: PullAckFacts; expected: string }>;
  writes: Array<{ input: PullCursorWriteFacts; expected: string }>;
  traces: Trace[];
  authorityTraces: Array<{ name: string; initial: unknown; checkpoints: Array<{
    action: { kind: 'freeze'; expected: number }
      | { kind: 'rebase'; expected: number; captured: number; next: number }
      | { kind: 'finish'; expected: number; session: number }
      | { kind: 'pendingAck' | 'stagePull' | 'revisionRace' | 'crash' };
    expected: unknown; outcome: string;
  }> }>;
  unfreezeCases: Array<{ pendingIncompletePull: boolean; nativeResultUnknown: boolean; expected: boolean }>;
  sessionCases: Array<{ lease: string; snapshot: boolean; refresh: boolean; bootstrapped: boolean; expected: string }>;
  recoveryBranches: Array<{ interrupted: boolean; checkpoints: Array<{ point: string; observed: unknown }> }>;
  ackFenceTraces: Array<{ name: string; initial: unknown; checkpoints: Array<{
    action: { kind: 'reject'; expected: number } | { kind: 'revisionRace' | 'lateReceipt' | 'activate' | 'crash' };
    expected: unknown; outcome: string;
  }> }>;
}

// Read expectations from the compiled Lean model, never a hand-copied golden file.
// Dedicated npm entry builds this executable before running these optional tests.
const executable = fileURLToPath(new URL('../../../formal/sync/.lake/build/bin/sync_export', import.meta.url));
export const vectors = JSON.parse(execFileSync(executable, [], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
})) as Vectors;
assert.equal(vectors.schemaVersion, 1);
assert.equal(vectors.orders.length, 400);
assert.equal(vectors.acks.length, 3528);
assert.equal(vectors.writes.length, 8400);
assert.equal(vectors.traces.length, 4);
assert.equal(vectors.authorityTraces.length, 6);
assert.equal(vectors.unfreezeCases.length, 4);
assert.equal(vectors.sessionCases.length, 40);
assert.equal(vectors.recoveryBranches.length, 2);
assert.equal(vectors.ackFenceTraces.length, 3);
