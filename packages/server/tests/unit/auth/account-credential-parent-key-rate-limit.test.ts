import assert from 'node:assert/strict';
import { test } from 'vitest';
import { issueAccountCredentialSecret } from '../../../src/modules/auth/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';
import {
  requireParentKey,
  type AccountCredentialParentKeyRoutesDependencies,
} from '../../../src/transport/auth/account-credential-parent-key-routes.js';

test('invalid parent-key guesses consume the trusted client IP budget before lookup', async () => {
  const validShapeWrongSecret = issueAccountCredentialSecret('parent').secret;
  let lookups = 0;
  const deps = {
    enabled: true,
    cursors: {},
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    unitOfWork: {
      async execute(work: (ports: unknown) => Promise<unknown>) {
        return work({
          credentials: {
            async findBySecretHash() { lookups += 1; return null; },
          },
          clock: { async now() { return new Date('2026-10-09T00:00:00.000Z'); } },
          accounts: { async findAccountById() { return null; } },
        });
      },
    },
  } as unknown as AccountCredentialParentKeyRoutesDependencies;
  const request = {
    ip: '198.51.100.7',
    headers: { authorization: `Bearer ${validShapeWrongSecret}` },
  } as never;

  await assert.rejects(() => requireParentKey(request, deps), (error: unknown) => {
    return error instanceof ProductHttpError && error.productCode === 'resource_not_found';
  });
  assert.equal(lookups, 1);

  await assert.rejects(() => requireParentKey(request, deps), (error: unknown) => {
    return error instanceof ProductHttpError && error.productCode === 'rate_limited';
  });
  assert.equal(lookups, 1, 'the rate-limited guess must not reach credential lookup');
});
