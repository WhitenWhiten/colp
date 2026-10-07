import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validateDcrPublicClientMetadata } from '../../../src/infrastructure/auth/dcr-public-client-policy.js';

function validate(metadata: Record<string, unknown>) {
  return validateDcrPublicClientMetadata(
    Buffer.from(JSON.stringify(metadata)),
    'application/json',
  );
}

test('DCR accepts only explicit public-client auth and explicit application type', () => {
  assert.equal(validate({ token_endpoint_auth_method: 'none', application_type: 'native' }), null);
  assert.equal(validate({ token_endpoint_auth_method: 'none', application_type: 'web' }), null);

  assert.deepEqual(validate({ application_type: 'native' }), {
    error: 'invalid_client_metadata',
    error_description: 'token_endpoint_auth_method must be explicitly set to none',
  });
  assert.deepEqual(validate({ token_endpoint_auth_method: 'client_secret_basic', application_type: 'web' }), {
    error: 'invalid_client_metadata',
    error_description: 'token_endpoint_auth_method must be explicitly set to none',
  });
  assert.deepEqual(validate({ token_endpoint_auth_method: 'none' }), {
    error: 'invalid_client_metadata',
    error_description: 'application_type must be explicitly set to native or web',
  });
  assert.deepEqual(validate({ token_endpoint_auth_method: 'none', application_type: 'desktop' }), {
    error: 'invalid_client_metadata',
    error_description: 'application_type must be explicitly set to native or web',
  });
});

test('non-JSON registration cannot bypass the metadata policy', () => {
  assert.deepEqual(
    validateDcrPublicClientMetadata(
      Buffer.from('token_endpoint_auth_method=none&application_type=native'),
      'application/x-www-form-urlencoded',
    ),
    {
      error: 'invalid_client_metadata',
      error_description: 'dynamic client registration requires application/json',
    },
  );
});
