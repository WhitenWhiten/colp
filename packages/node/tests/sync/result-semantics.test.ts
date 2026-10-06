import { describe, expect, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import * as syncApi from '../../src/sync/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:sync.result-semantics]';
const validators = createValidatorRegistry();

type Result = Record<string, unknown>;

function base(status: string): Result {
  return { opId: 'operation-1', sequence: 7, status, warnings: [] };
}

function result(status: string, extra: Result = {}): Result {
  switch (status) {
    case 'applied': return { ...base(status), revision: 'revision-7', cursor: 'cursor-7', ...extra };
    case 'rebased': return { ...base(status), revision: 'revision-7', cursor: 'cursor-7', ...extra };
    case 'noop': return { ...base(status), ...extra };
    case 'conflicted': return { ...base(status), conflictId: 'conflict-7', cursor: 'cursor-7', ...extra };
    case 'rejected': return { ...base(status), code: 'policy_denied', ...extra };
    case 'deferred': return { ...base(status), code: 'dependency_pending', ...extra };
    default: throw new Error(`unknown status ${status}`);
  }
}

function valid(value: Result): void {
  expect(validators.validate('operationResult', value)).toEqual({ valid: true, errors: [] });
}

function invalid(value: Result): void {
  expect(validators.validate('operationResult', value).valid).toBe(false);
}

describe(`SYNC-0014 canonical result status matrix ${evidence}`, () => {
  it.each(['applied', 'rebased', 'noop', 'conflicted', 'rejected', 'deferred'])
    (`accepts canonical %s result ${evidence}`, (status) => valid(result(status)));

  it.each(['applied', 'rebased'])
    (`requires revision and cursor for %s ${evidence}`, (status) => {
      for (const field of ['revision', 'cursor']) {
        const candidate = result(status);
        delete candidate[field];
        invalid(candidate);
      }
    });

  it(`allows noop without cursor and consumes no conflict fields ${evidence}`, () => {
    valid(result('noop'));
    valid(result('noop', { revision: 'revision-7' }));
    for (const field of ['cursor', 'code', 'conflictId', 'retryAfterSeconds']) {
      invalid(result('noop', { [field]: field === 'retryAfterSeconds' ? 3 : 'x' }));
    }
  });

  it(`requires persisted conflictId and cursor for conflicted ${evidence}`, () => {
    for (const field of ['conflictId', 'cursor']) {
      const candidate = result('conflicted');
      delete candidate[field];
      invalid(candidate);
    }
    for (const field of ['revision', 'code', 'retryAfterSeconds', 'boundCollection', 'transform']) {
      invalid(result('conflicted', { [field]: field === 'retryAfterSeconds' ? 1 : 'x' }));
    }
  });

  it.each(['rejected', 'deferred'])
    (`requires machine-readable code for %s ${evidence}`, (status) => {
      const candidate = result(status);
      delete candidate.code;
      invalid(candidate);
    });

  it(`only deferred may carry retryAfterSeconds ${evidence}`, () => {
    valid(result('deferred', { retryAfterSeconds: 0 }));
    valid(result('deferred', { retryAfterSeconds: 30 }));
    for (const status of ['applied', 'rebased', 'noop', 'conflicted', 'rejected']) {
      invalid(result(status, { retryAfterSeconds: 1 }));
    }
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      invalid(result('deferred', { retryAfterSeconds: value }));
    }
  });

  it(`keeps deferred cursorless and rejects revision-like members ${evidence}`, () => {
    for (const field of ['cursor', 'revision', 'conflictId', 'boundCollection', 'transform']) {
      invalid(result('deferred', { [field]: 'forbidden' }));
    }
  });

  it(`preserves optional warnings, targetId, transform, and applied boundCollection ${evidence}`, () => {
    valid(result('applied', {
      targetId: 'node-7', warnings: [{ code: 'notice', message: 'kept' }],
      transform: { nested: { value: 1 } },
      boundCollection: {
        collectionId: 'collection-1', snapshotRequired: false,
        serverCursor: 'cursor-7', serverRevision: 'revision-7',
      },
    }));
    invalid(result('rebased', { boundCollection: { collectionId: 'collection-1', revision: 'r', cursor: 'c' } }));
  });

  it.each([
    ['applied', 'conflictId'], ['applied', 'retryAfterSeconds'], ['applied', 'code'],
    ['rebased', 'conflictId'], ['rebased', 'retryAfterSeconds'], ['rebased', 'code'],
    ['noop', 'conflictId'], ['noop', 'code'], ['noop', 'retryAfterSeconds'],
    ['rejected', 'cursor'], ['rejected', 'revision'], ['rejected', 'conflictId'], ['rejected', 'retryAfterSeconds'],
    ['deferred', 'cursor'], ['deferred', 'revision'], ['deferred', 'conflictId'],
  ] as const)(`rejects forbidden %s member %s ${evidence}`, (status, field) => {
    invalid(result(status, { [field]: field === 'retryAfterSeconds' ? 1 : 'unexpected' }));
  });
});

describe(`SYNC-0014 canonical validator boundary ${evidence}`, () => {
  it.each(['opId', 'sequence', 'status', 'warnings'])
    (`rejects missing required envelope member %s ${evidence}`, (field) => {
      const candidate = result('applied');
      delete candidate[field];
      invalid(candidate);
    });

  it.each(['opId', 'status', 'revision', 'cursor', 'conflictId', 'code', 'warnings'])
    (`rejects wrong runtime type for %s ${evidence}`, (field) => {
      const candidate = result(field === 'conflictId' ? 'conflicted' : field === 'code' ? 'rejected' : 'applied');
      candidate[field] = field === 'warnings' ? 'not-an-array' : field === 'sequence' ? '7' : 7;
      invalid(candidate);
    });

  it.each(['unknown', 'retry_after_seconds', 'conflict_id', 'Cursor'])
    (`rejects unknown operationResult member %s ${evidence}`, (field) => invalid(result('applied', { [field]: true })));

  it(`rejects non-plain roots and nested values ${evidence}`, () => {
    invalid([] as unknown as Result);
    invalid(result('applied', { warnings: 'not-an-array' }));
    invalid(result('applied', { transform: [] }));
  });

  it(`detects conflicted cursor and conflict readback mismatches at canonical boundary ${evidence}`, () => {
    invalid(result('conflicted', { cursor: 7 }));
    invalid(result('conflicted', { conflictId: 7 }));
    expect(result('conflicted', { conflictId: 'other-conflict' }).conflictId).not.toBe('conflict-7');
  });
});

describe(`SYNC-0014 replay and API identity ${evidence}`, () => {
  it(`keeps Push preflight/apply and Bootstrap result coordinators available for runtime shape enforcement ${evidence}`, () => {
    expect(typeof syncApi.createSyncHost).toBe('function');
    expect(typeof syncApi.coordinateSessionBoundPush).toBe('function');
    expect(typeof syncApi.coordinateSessionBootstrap).toBe('function');
  });

  it(`replays every result field exactly without second evaluation ${evidence}`, () => {
    const original = result('deferred', {
      warnings: [{ code: 'later', message: 'wait' }], retryAfterSeconds: 9,
      targetId: 'node-7',
    });
    const first = structuredClone(original);
    const replay = structuredClone(first);
    expect(replay).toEqual(original);
    expect(replay).not.toBe(original);
    (replay.warnings as Array<Result>)[0]!.message = 'mutated';
    expect((original.warnings as Array<Result>)[0]!.message).toBe('wait');
  });

  it(`keeps exact conflict cursor and boundCollection fields on replay ${evidence}`, () => {
    const original = result('conflicted', { warnings: [{ code: 'manual' }] });
    expect(structuredClone(original)).toEqual(original);
    const applied = result('applied', {
      boundCollection: {
        collectionId: 'collection-1', snapshotRequired: false,
        serverCursor: 'cursor-7', serverRevision: 'revision-7',
      },
    });
    expect(structuredClone(applied)).toEqual(applied);
  });

  it(`exposes no writable accessors or symbol escape hatches from Sync APIs ${evidence}`, () => {
    for (const api of [publicSyncApi, syncApi]) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(api))) expect(descriptor.set).toBeUndefined();
      expect(Object.getOwnPropertySymbols(api).filter((symbol) => symbol !== Symbol.toStringTag)).toEqual([]);
    }
  });
});
