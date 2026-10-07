import assert from 'node:assert/strict';
import { Client } from 'pg';
import { test, vi } from 'vitest';
import { PostgresControlClient } from '../../../src/infrastructure/database/postgres-control-client.js';

test('a cancellation socket error stays inside its query boundary instead of escaping the process', async () => {
  const client = new PostgresControlClient({});
  const failure = new Error('cancellation connection terminated');
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(() => {
    client.emit('error', failure);
    return Promise.reject(failure);
  });
  try {
    await assert.rejects(client.query('select pg_cancel_backend(1)'), error => error === failure);
  } finally { query.mockRestore(); }
});

test('unawaited cancellation client teardown cannot become an unhandled rejection', async () => {
  const end = vi.spyOn(Client.prototype, 'end').mockRejectedValue(new Error('close failed'));
  try { await assert.doesNotReject(new PostgresControlClient({}).end()); }
  finally { end.mockRestore(); }
});
