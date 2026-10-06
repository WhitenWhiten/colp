/**
 * T-11 / G1 source-size split: `src/sync/sequence-validation.ts` owns the
 * Sequence boundary normalization previously embedded in `sequence.ts`.
 * These cases pin the extracted module directly so the Tier A row added to
 * `docs/TESTING.md` has its own evidence instead of relying on the global
 * sync-core average.
 */

import { describe, expect, it } from 'vitest';

import {
  TERMINAL_STATUSES,
  claimForReceipt,
  claimForRequest,
  equalData,
  immutableEvaluation,
  immutableLane,
  immutableLaneState,
  immutableReceipt,
  immutableRequest,
  mutableData,
  receiptMatches,
} from '../../src/sync/sequence-validation.js';
import type { SequenceOperationRequest } from '../../src/sync/sequence.js';

const LANE = Object.freeze({ replicaId: 'replica-a', sequenceScope: 'collection:1' });

function request(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'op-1',
    replicaId: 'replica-a',
    sequenceScope: 'collection:1',
    sequence: 1,
    digest: 'digest-1',
    ...overrides,
  } as SequenceOperationRequest;
}

function receipt<Result>(result: Result, overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'op-1',
    replicaId: 'replica-a',
    sequenceScope: 'collection:1',
    sequence: 1,
    digest: 'digest-1',
    status: 'applied' as const,
    result,
    ...overrides,
  } as Parameters<typeof immutableReceipt<Result>>[0];
}

describe('Sequence boundary validation [review:sync.sequence-validation]', () => {
  it('freezes the terminal receipt status set', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      'applied', 'conflicted', 'noop', 'rebased', 'rejected',
    ]);
  });

  it('accepts a well-formed lane, request, lane state, receipt, and evaluation', () => {
    const lane = immutableLane({ replicaId: 'replica-a', sequenceScope: 'collection:1' });
    expect(Object.isFrozen(lane)).toBe(true);
    expect(lane).toEqual(LANE);

    expect(immutableRequest(request())).toEqual(request());
    expect(immutableRequest(request({ reevaluateDeferred: true }))).toEqual(
      request({ reevaluateDeferred: true }),
    );

    expect(immutableLaneState(undefined)).toEqual({ nextSequence: 1 });
    expect(immutableLaneState({ nextSequence: 7 })).toEqual({ nextSequence: 7 });

    expect(immutableReceipt(receipt({ status: 'applied' }), LANE, 1)).toEqual(
      receipt({ status: 'applied' }),
    );
    expect(immutableEvaluation({ status: 'deferred', result: { value: 1 } })).toEqual({
      status: 'deferred',
      result: { value: 1 },
    });
  });

  it('rejects malformed lanes before they reach the coordinator', () => {
    expect(() => immutableLane(undefined as never)).toThrow('Sequence lane must be an object.');
    expect(() => immutableLane({ replicaId: 'a', sequenceScope: 'b', extra: 'c' } as never))
      .toThrow('Sequence lane contains an unknown member.');
    expect(() => immutableLane({ replicaId: '  ', sequenceScope: 'b' }))
      .toThrow('replicaId must be a non-empty string.');
    expect(() => immutableLane({ replicaId: 'a', sequenceScope: '' }))
      .toThrow('sequenceScope must be a non-empty string.');
  });

  it('rejects malformed operation requests', () => {
    expect(() => immutableRequest(undefined as never))
      .toThrow('Sequence operation request must be an object.');
    expect(() => immutableRequest({ ...request(), unexpected: true } as never))
      .toThrow('Sequence operation request contains an unknown member.');
    expect(() => immutableRequest(request({ operationId: ' ' })))
      .toThrow('operationId must be a non-empty string.');
    expect(() => immutableRequest(request({ digest: '' })))
      .toThrow('digest must be a non-empty string.');
    expect(() => immutableRequest(request({ sequence: 0 })))
      .toThrow('sequence must be a positive safe integer.');
    expect(() => immutableRequest(request({ sequence: 1.5 })))
      .toThrow('sequence must be a positive safe integer.');
    expect(() => immutableRequest(request({ reevaluateDeferred: 'yes' } as never)))
      .toThrow('reevaluateDeferred must be a boolean when present.');
  });

  it('rejects malformed lane state', () => {
    expect(() => immutableLaneState(undefined)).not.toThrow();
    expect(() => immutableLaneState(null as never))
      .toThrow('Stored Sequence lane state must be an object.');
    expect(() => immutableLaneState({ nextSequence: 1, extra: 2 } as never))
      .toThrow('Stored Sequence lane state contains an unknown member.');
    expect(() => immutableLaneState({ nextSequence: 0 }))
      .toThrow('Stored nextSequence must be a positive safe integer.');
    expect(() => immutableLaneState({ nextSequence: '1' } as never))
      .toThrow('Stored nextSequence must be a positive safe integer.');
  });

  it('rejects receipts that do not belong to the lane, sequence, or status vocabulary', () => {
    expect(() => immutableReceipt(null as never, LANE))
      .toThrow('Stored Sequence receipt must be an object.');
    expect(() => immutableReceipt({ ...receipt({}), extra: 1 } as never, LANE))
      .toThrow('Stored Sequence receipt contains an unknown member.');
    expect(() => immutableReceipt(receipt({}, { operationId: '' }), LANE))
      .toThrow('Stored receipt operationId must be a non-empty string.');
    expect(() => immutableReceipt(receipt({}, { digest: ' ' }), LANE))
      .toThrow('Stored receipt digest must be a non-empty string.');
    expect(() => immutableReceipt(receipt({}, { replicaId: 'replica-b' }), LANE))
      .toThrow('Stored Sequence receipt belongs to a different lane.');
    expect(() => immutableReceipt(receipt({}, { sequenceScope: 'collection:2' }), LANE))
      .toThrow('Stored Sequence receipt belongs to a different lane.');
    expect(() => immutableReceipt(receipt({}, { sequence: 0 }), LANE))
      .toThrow('Stored receipt sequence must be a positive safe integer.');
    expect(() => immutableReceipt(receipt({}, { sequence: 2 }), LANE, 1))
      .toThrow('Stored Sequence receipt has a mismatched sequence.');
    expect(() => immutableReceipt(receipt({}, { status: 'pending' }), LANE))
      .toThrow('Stored Sequence receipt has an invalid status.');
    expect(() => immutableReceipt(receipt({ status: 'rejected' }), LANE))
      .toThrow('Stored Sequence receipt status differs from its operation result status.');
  });

  it('accepts a receipt whose result carries the matching status field', () => {
    expect(immutableReceipt(receipt({ status: 'applied', value: 1 }), LANE)).toEqual(
      receipt({ status: 'applied', value: 1 }),
    );
  });

  it('rejects malformed evaluations', () => {
    expect(() => immutableEvaluation(undefined as never))
      .toThrow('Sequence evaluation must be an object.');
    expect(() => immutableEvaluation({ status: 'applied', result: {}, extra: true } as never))
      .toThrow('Sequence evaluation contains an unknown member.');
    expect(() => immutableEvaluation({ status: 'pending', result: {} } as never))
      .toThrow('Sequence evaluation has an invalid status.');
    expect(() => immutableEvaluation({ status: 'applied', result: { status: 'noop' } }))
      .toThrow('Sequence evaluation status differs from its operation result status.');
  });

  it('compares receipts structurally, including nested operation results', () => {
    const left = immutableReceipt(
      receipt({ status: 'applied', nested: { list: [1, { deep: 'x' }] } }),
      LANE,
    );
    const right = immutableReceipt(
      receipt({ status: 'applied', nested: { list: [1, { deep: 'x' }] } }),
      LANE,
    );
    const drifted = immutableReceipt(
      receipt({ status: 'applied', nested: { list: [1, { deep: 'y' }] } }),
      LANE,
    );
    const statusDrifted = immutableReceipt(
      receipt({ nested: { list: [1, { deep: 'x' }] } }, { status: 'noop' }),
      LANE,
    );
    expect(receiptMatches(left, right)).toBe(true);
    expect(receiptMatches(left, drifted)).toBe(false);
    expect(receiptMatches(left, statusDrifted)).toBe(false);
  });

  it('treats non-object values and mismatched array shapes as unequal', () => {
    expect(equalData(1, 1)).toBe(true);
    expect(equalData({ a: 1 }, { a: 1 })).toBe(true);
    expect(equalData({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(equalData({ a: 1 }, { b: 1 })).toBe(false);
    expect(equalData([1, 2], [1, 2])).toBe(true);
    expect(equalData([1, 2], [1, 2, 3])).toBe(false);
    expect(equalData([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(equalData('a', 1)).toBe(false);
    expect(equalData(null, { a: 1 })).toBe(false);
  });

  it('derives lifetime Operation claims from requests and receipts', () => {
    expect(claimForRequest(request())).toEqual({
      operationId: 'op-1',
      digest: 'digest-1',
      replicaId: 'replica-a',
      sequenceScope: 'collection:1',
      sequence: 1,
    });
    expect(claimForReceipt(immutableReceipt(receipt({ status: 'applied' }), LANE))).toEqual(
      claimForRequest(request()),
    );
  });

  it('hands mutable clones of immutable inputs to adapters', () => {
    const frozen = immutableReceipt(receipt({ status: 'applied', nested: { value: 1 } }), LANE);
    const clone = mutableData(frozen);
    expect(clone).toEqual(frozen);
    expect(clone).not.toBe(frozen);
    expect(Object.isFrozen(clone)).toBe(false);
  });
});
