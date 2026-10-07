import assert from 'node:assert/strict';
import { test } from 'vitest';

import { ledgerPayloadPurgeCli } from '../../../scripts/ledger-payload-purge.js';

const SEGMENT = '11111111-1111-4111-8111-111111111111';

test('ledger payload purge apply refuses production before opening a database', async () => {
  await assert.rejects(() => ledgerPayloadPurgeCli([
    'apply', '--segment', SEGMENT, '--confirm-segment', SEGMENT,
  ], {
    NODE_ENV: 'production', LEDGER_ARCHIVE_DESTRUCTIVE_MODE: 'development',
    DATABASE_URL: 'postgres://must-not-connect',
  }), /forbidden in production/u);
});

test('ledger payload purge apply requires exact destructive mode and segment confirmation', async () => {
  await assert.rejects(() => ledgerPayloadPurgeCli([
    'apply', '--segment', SEGMENT, '--confirm-segment', SEGMENT,
  ], { NODE_ENV: 'development', DATABASE_URL: 'postgres://must-not-connect' }),
  /DESTRUCTIVE_MODE=development/u);

  await assert.rejects(() => ledgerPayloadPurgeCli([
    'apply', '--segment', SEGMENT,
    '--confirm-segment', '22222222-2222-4222-8222-222222222222',
  ], {
    NODE_ENV: 'development', LEDGER_ARCHIVE_DESTRUCTIVE_MODE: 'development',
    DATABASE_URL: 'postgres://must-not-connect',
  }), /must exactly repeat/u);
});

test('ledger payload purge CLI rejects unknown modes and unbounded batch input', async () => {
  await assert.rejects(() => ledgerPayloadPurgeCli(['delete', '--segment', SEGMENT], {}),
    /Usage:/u);
  await assert.rejects(() => ledgerPayloadPurgeCli([
    'dry-run', '--segment', SEGMENT, '--batch-size', '10001',
  ], {}), /Usage:/u);
});

test('enqueue requires complete family binding, authorization reference, and development gate', async () => {
  const enqueueArguments = [
    'enqueue', '--segment', SEGMENT, '--family', 'operation', '--scope', 'collection:test',
    '--lower', '1', '--upper', '11', '--floor-ordinal', '10',
    '--floor-tie-breaker', 'operation-10', '--floor-revision', '1',
    '--authorization-reference', 'DEV-123',
  ] as const;
  await assert.rejects(() => ledgerPayloadPurgeCli(enqueueArguments, {
    NODE_ENV: 'production', LEDGER_ARCHIVE_DESTRUCTIVE_MODE: 'development',
    DATABASE_URL: 'postgres://must-not-connect',
  }), /forbidden in production/u);
  await assert.rejects(() => ledgerPayloadPurgeCli([
    ...enqueueArguments,
  ], { NODE_ENV: 'development', DATABASE_URL: 'postgres://must-not-connect' }),
  /DESTRUCTIVE_MODE=development/u);
  await assert.rejects(() => ledgerPayloadPurgeCli([
    'enqueue', '--segment', SEGMENT, '--family', 'operation', '--scope', 'collection:test',
    '--lower', '1', '--upper', '11', '--authorization-reference', 'DEV-123',
  ], { NODE_ENV: 'development' }), /Usage:/u);
});

test('reclaim relation is allowlisted and routine VACUUM needs no destructive gate', async () => {
  await assert.rejects(() => ledgerPayloadPurgeCli([
    'reclaim', '--relation', 'operations',
  ], {}), /Usage:/u);
  await assert.rejects(() => ledgerPayloadPurgeCli([
    'reclaim', '--relation', 'operation_payloads',
  ], { NODE_ENV: 'production' }), /DATABASE_URL is required/u);
});

test('reclaim FULL requires development mode and exact relation confirmation', async () => {
  const base = ['reclaim', '--relation', 'outbox_events', '--full'] as const;
  await assert.rejects(() => ledgerPayloadPurgeCli([
    ...base, '--confirm-relation', 'outbox_events',
  ], {
    NODE_ENV: 'production', LEDGER_ARCHIVE_DESTRUCTIVE_MODE: 'development',
    DATABASE_URL: 'postgres://must-not-connect',
  }), /forbidden in production/u);
  await assert.rejects(() => ledgerPayloadPurgeCli([
    ...base, '--confirm-relation', 'outbox_events',
  ], { NODE_ENV: 'development', DATABASE_URL: 'postgres://must-not-connect' }),
  /DESTRUCTIVE_MODE=development/u);
  await assert.rejects(() => ledgerPayloadPurgeCli([
    ...base, '--confirm-relation', 'audit_event_payloads',
  ], {
    NODE_ENV: 'development', LEDGER_ARCHIVE_DESTRUCTIVE_MODE: 'development',
    DATABASE_URL: 'postgres://must-not-connect',
  }), /must exactly repeat/u);
});
