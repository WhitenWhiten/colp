import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  LIBRARY_ORDER_COMMAND_CONTRACT_VERSION,
  LIBRARY_ORDER_MAX_ITEMS,
  LIBRARY_ORDER_SECTIONS,
  LibraryOrderCommandError,
  libraryOrderCommandFingerprint,
  queryLibraryOrder,
  sanitizeLibraryOrderIds,
  updateLibraryOrder,
  type LibraryOrderCommandInput,
  type LibraryOrderCommandPorts,
  type LibraryOrderQueryPorts,
} from '../../../src/modules/collections/index.js';

const PRINCIPAL = 'EREREREREREREREREREREQ';
const SUBJECT = 'subject-actor';
const COLLECTION_A = 'IiIiIiIiIiIiIiIiIiIiIg';
const COLLECTION_B = 'M2NkNGU1ZjZhN2I4YzlkMG';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const NOW = new Date('2026-08-26T08:00:00.000Z');

interface Effects {
  saved: Array<{ subjectId: string; section: string; collectionIds: readonly string[] }>;
  completed: number;
}

function input(overrides: Partial<LibraryOrderCommandInput> = {}): LibraryOrderCommandInput {
  return {
    actor: { principalId: PRINCIPAL, subjectId: SUBJECT },
    section: 'mine',
    collectionIds: [COLLECTION_A, COLLECTION_B],
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function ports(options: {
  claim?: Awaited<ReturnType<LibraryOrderCommandPorts['receipts']['claim']>>;
} = {}): { ports: LibraryOrderCommandPorts; effects: Effects } {
  const effects: Effects = { saved: [], completed: 0 };
  return {
    effects,
    ports: {
      receipts: {
        async claim() { return options.claim ?? { kind: 'claimed' }; },
        async complete(_binding, _fingerprint, receipt) {
          effects.completed += 1;
          assert.equal(receipt.contractVersion, LIBRARY_ORDER_COMMAND_CONTRACT_VERSION);
          assert.equal(receipt.targetIdentity, 'mine');
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      orders: {
        async save(entry) {
          effects.saved.push({
            subjectId: entry.subjectId,
            section: entry.section,
            collectionIds: entry.collectionIds,
          });
        },
      },
      clock: { async now() { return NOW; } },
    },
  };
}

test('sections contract is the frozen sidebar triple', () => {
  assert.deepEqual([...LIBRARY_ORDER_SECTIONS], ['mine', 'shared', 'following']);
  assert.equal(LIBRARY_ORDER_MAX_ITEMS, 200);
});

test('update persists the section order, completes the receipt, and echoes the order', async () => {
  const fixture = ports();
  const result = await updateLibraryOrder(fixture.ports, input());
  assert.deepEqual(result, {
    kind: 'succeeded',
    order: { section: 'mine', collectionIds: [COLLECTION_A, COLLECTION_B] },
  });
  assert.deepEqual(fixture.effects.saved, [{
    subjectId: SUBJECT,
    section: 'mine',
    collectionIds: [COLLECTION_A, COLLECTION_B],
  }]);
  assert.equal(fixture.effects.completed, 1);
});

test('an empty id list clears the stored order and still succeeds', async () => {
  const fixture = ports();
  const result = await updateLibraryOrder(fixture.ports, input({ collectionIds: [] }));
  assert.deepEqual(result, {
    kind: 'succeeded',
    order: { section: 'mine', collectionIds: [] },
  });
  assert.deepEqual(fixture.effects.saved[0]?.collectionIds, []);
});

test('receipt claims short-circuit before the store is touched', async () => {
  for (const claim of [
    { kind: 'reused' as const },
    { kind: 'in_progress' as const, retryAfterSeconds: 2 },
    {
      kind: 'replay' as const,
      result: {
        status: 200,
        body: Buffer.from('{}'),
        stableHeaders: {},
        mediaType: 'application/json',
        contractVersion: LIBRARY_ORDER_COMMAND_CONTRACT_VERSION,
      },
    },
  ]) {
    const fixture = ports({ claim });
    const result = await updateLibraryOrder(fixture.ports, input());
    assert.equal(result.kind, claim.kind);
    assert.deepEqual(fixture.effects.saved, []);
    assert.equal(fixture.effects.completed, 0);
  }
});

test('invalid inputs are rejected as invalid_request without side effects', async () => {
  const tooMany = Array.from(
    { length: LIBRARY_ORDER_MAX_ITEMS + 1 },
    (_, index) => `${COLLECTION_A.slice(0, 18)}${String(index).padStart(4, '0')}`,
  );
  const invalidInputs: Array<Partial<LibraryOrderCommandInput>> = [
    { commandId: 'not-a-uuid' },
    { section: 'invitations' as never },
    { collectionIds: [COLLECTION_A, COLLECTION_A] },
    { collectionIds: ['bad id with spaces'] },
    { collectionIds: tooMany },
    { actor: { principalId: '', subjectId: SUBJECT } },
    { actor: { principalId: PRINCIPAL, subjectId: ' padded ' } },
  ];
  for (const overrides of invalidInputs) {
    const fixture = ports();
    await assert.rejects(
      updateLibraryOrder(fixture.ports, input(overrides)),
      (error: unknown) => error instanceof LibraryOrderCommandError && error.code === 'invalid_request',
      JSON.stringify(overrides).slice(0, 80),
    );
    assert.deepEqual(fixture.effects.saved, []);
    assert.equal(fixture.effects.completed, 0);
  }
});

test('fingerprint is stable per input and distinct across sections and orders', () => {
  const base = libraryOrderCommandFingerprint(input());
  assert.equal(libraryOrderCommandFingerprint(input()), base);
  assert.notEqual(libraryOrderCommandFingerprint(input({ section: 'shared' })), base);
  assert.notEqual(
    libraryOrderCommandFingerprint(input({ collectionIds: [COLLECTION_B, COLLECTION_A] })),
    base,
  );
});

test('query drops corrupt stored ids instead of echoing them', async () => {
  assert.deepEqual(
    sanitizeLibraryOrderIds(['ok-id', 'bad id', 'ok-id', 1, '', `${'x'.repeat(129)}`]),
    ['ok-id'],
  );
  const queryPorts: LibraryOrderQueryPorts = {
    orders: {
      async load() {
        return [{
          section: 'mine',
          collectionIds: [COLLECTION_A, 'bad id', COLLECTION_A, 'not valid'],
        }];
      },
    },
  };
  const result = await queryLibraryOrder(queryPorts, { subjectId: SUBJECT });
  assert.deepEqual(result.sections.mine, [COLLECTION_A]);
});

test('query returns every section with stored orders merged over empty defaults', async () => {
  const queryPorts: LibraryOrderQueryPorts = {
    orders: {
      async load(subjectId) {
        assert.equal(subjectId, SUBJECT);
        return [
          { section: 'following', collectionIds: [COLLECTION_B] },
          { section: 'mine', collectionIds: [COLLECTION_A, COLLECTION_B] },
        ];
      },
    },
  };
  const result = await queryLibraryOrder(queryPorts, { subjectId: SUBJECT });
  assert.deepEqual(result, {
    sections: {
      mine: [COLLECTION_A, COLLECTION_B],
      shared: [],
      following: [COLLECTION_B],
    },
  });
});
