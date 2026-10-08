import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { test, vi } from 'vitest';
import { createR2ExportStore } from '../../../src/infrastructure/collections/export-object-store-r2-adapter.js';

test('put, get and delete resolve frozen configuration credentials through the real SDK', async () => {
  const rwCredential = Object.freeze({ accessKeyId: 'write-key', secretAccessKey: 'write-secret' });
  const roCredential = Object.freeze({ accessKeyId: 'read-key', secretAccessKey: 'read-secret' });
  const resolved: string[] = [];
  // Stop at the network boundary, retaining the SDK credential provider that
  // adds $source.CREDENTIALS_CODE (the production failure with frozen inputs).
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async function (this: S3Client, command: unknown) {
    resolved.push((await this.config.credentials()).accessKeyId);
    return command instanceof GetObjectCommand ? { Body: Readable.from(['{}']) } : {};
  });
  try {
    const store = createR2ExportStore({
      endpoint: 'https://export.example.test', region: 'auto', bucket: 'private',
      prefix: 'export/', rwCredential, roCredential,
    });
    await store.put('job-1', Buffer.from('{}'), 'application/json');
    assert.equal((await store.get('job-1'))?.toString(), '{}');
    await store.delete('job-1');
    assert.deepEqual(resolved, ['write-key', 'read-key', 'write-key']);
    assert.deepEqual(Object.keys(rwCredential), ['accessKeyId', 'secretAccessKey']);
    assert.deepEqual(Object.keys(roCredential), ['accessKeyId', 'secretAccessKey']);
  } finally {
    send.mockRestore();
  }
});
