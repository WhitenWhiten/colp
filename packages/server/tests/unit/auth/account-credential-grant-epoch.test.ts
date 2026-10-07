import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createGrantMachineBindingPort } from '../../../src/bootstrap/account-credential-grant-composition.js';
import { createMcpSecurityEpochReader } from '../../../src/bootstrap/api-mcp-oauth-composition.js';
import { createInMemoryMcpOauthRevocationStore } from '../../../src/modules/mcp/index.js';
import { machineCredentialBindingId } from '../../../src/modules/auth/index.js';
import { phase4bMcpConfigBaseEnv } from '../../support/phase4b-mcp-config-env.js';

test('grant binding follows live epoch rotation: old plans expire and new plans match', async () => {
  const config = loadConfig(phase4bMcpConfigBaseEnv);
  const store = createInMemoryMcpOauthRevocationStore();
  const machine = createGrantMachineBindingPort(config,
    createMcpSecurityEpochReader({ nodeEnv: 'production' }, store));
  const identity = { clientId: 'client', credentialId: 'child', resourceAudience: 'https://example.com/mcp',
    accountEpoch: '1', credentialEpoch: '1', ancestorEpochDigest: 'ancestor' };
  const originalEpoch = await machine.securityEpoch();
  const original = machine.expectedBindingId({ ...identity, serverSecurityEpoch: originalEpoch });
  await store.bumpSecurityEpoch('rotated-epoch');
  const epoch = await machine.securityEpoch();
  assert.equal(epoch, 'rotated-epoch');
  const current = machine.expectedBindingId({ ...identity, serverSecurityEpoch: epoch });
  assert.notEqual(current, original);
  assert.equal(current, machineCredentialBindingId({ ...identity, iss: machine.issuer(),
    serverSecurityEpoch: await store.securityEpoch() }));
});

test('production grant epoch fails closed when the authoritative store is missing or fails', async () => {
  await assert.rejects(createMcpSecurityEpochReader({ nodeEnv: 'production' }), /unavailable/);
  await assert.rejects(createMcpSecurityEpochReader({ nodeEnv: 'production' }, {
    securityEpoch: async () => { throw new Error('database unavailable'); },
  }), /database unavailable/);
});
