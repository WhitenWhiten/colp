import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseLedgerArchiveCommand } from '../../../scripts/ledger-archive-command.js';

test('archive CLI separates synchronous export, durable enqueue, and one worker tick', () => {
  const exported = parseLedgerArchiveCommand([
    'export', '--family', 'operation', '--source-scope', 'collection:abc',
    '--lower', '1', '--upper', '3',
  ]);
  assert.equal(exported.name, 'export');
  if (exported.name === 'export') {
    assert.equal(exported.fixturePath, undefined);
    assert.equal(exported.sourceScope, 'collection:abc');
  }

  const socialOutbox = parseLedgerArchiveCommand([
    'export', '--family', 'outbox_social', '--source-scope', 'aggregate-scope',
    '--lower', '1', '--upper', '4',
  ]);
  assert.equal(socialOutbox.name, 'export');
  if (socialOutbox.name === 'export') {
    assert.equal(socialOutbox.family, 'outbox_social');
    assert.equal(socialOutbox.sourceScope, 'aggregate-scope');
    assert.equal(socialOutbox.fixturePath, undefined);
  }

  const enqueued = parseLedgerArchiveCommand([
    'enqueue', '--segment-id', '11b57ed4-4af8-49b2-857e-5d17d1f06095',
  ]);
  assert.equal(enqueued.name, 'enqueue');

  const once = parseLedgerArchiveCommand(['worker-once']);
  assert.deepEqual(once, { name: 'worker-once' });
});

test('fixture access is explicit and requires its complete source binding', () => {
  assert.throws(() => parseLedgerArchiveCommand([
    'export', '--fixture', '/tmp/archive.jsonl', '--family', 'operation',
    '--source-scope', 'collection:abc', '--lower', '1', '--upper', '2',
  ]), (error: unknown) => (error as { stableCode?: unknown }).stableCode
    === 'ledger_archive_cli_argument_missing');

  const fixture = parseLedgerArchiveCommand([
    'worker-once', '--fixture', '/tmp/archive.jsonl', '--family', 'operation',
    '--source-relation', 'public.operation_payloads', '--source-scope', 'collection:abc',
  ]);
  assert.equal(fixture.name, 'worker-once');
  if (fixture.name === 'worker-once') assert.equal(fixture.fixture?.path, '/tmp/archive.jsonl');
});

test('unknown commands and duplicate options fail with stable CLI codes', () => {
  assert.throws(
    () => parseLedgerArchiveCommand(['purge']),
    (error: unknown) => (error as { stableCode?: unknown }).stableCode === 'ledger_archive_cli_usage',
  );
  assert.throws(
    () => parseLedgerArchiveCommand(['verify', '--segment-id', 'a', '--segment-id', 'b']),
    (error: unknown) => (error as { stableCode?: unknown }).stableCode
      === 'ledger_archive_cli_argument_duplicate',
  );
});

test('cutover accepts only verified-to-reader-cutover CAS arguments and exact confirmation', () => {
  const segment = '11b57ed4-4af8-49b2-857e-5d17d1f06095';
  assert.deepEqual(parseLedgerArchiveCommand([
    'cutover', '--segment', segment, '--expected-revision', '4',
    '--confirm-segment', segment,
  ]), { name: 'cutover', segmentId: segment, expectedRevision: 4n });

  for (const arguments_ of [
    ['cutover', '--segment', segment, '--expected-revision', '4'],
    ['cutover', '--segment', segment, '--expected-revision', '-1', '--confirm-segment', segment],
    ['cutover', '--segment', segment, '--expected-revision', '4', '--confirm-segment',
      '22b57ed4-4af8-49b2-857e-5d17d1f06095'],
    ['cutover', '--segment', segment, '--expected-revision', '4', '--confirm-segment', segment,
      '--target', 'reader_cutover'],
  ]) {
    assert.throws(() => parseLedgerArchiveCommand(arguments_));
  }
});

test('cutover confirmation fails before database or object-reader configuration is inspected', async () => {
  const { runLedgerArchiveCli } = await import('../../../scripts/ledger-archive-command.js');
  await assert.rejects(() => runLedgerArchiveCli([
    'cutover', '--segment', '11b57ed4-4af8-49b2-857e-5d17d1f06095',
    '--expected-revision', '4', '--confirm-segment',
    '22b57ed4-4af8-49b2-857e-5d17d1f06095',
  ], { DATABASE_URL: 'postgres://must-not-connect' }),
  (error: unknown) => (error as { stableCode?: unknown }).stableCode
    === 'ledger_archive_cutover_confirmation_mismatch');
});
