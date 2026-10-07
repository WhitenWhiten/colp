/**
 * C-02: unverified occupancy is not a product actor, but it is not a missing
 * session either. 401 authentication_required is only for no usable session;
 * occupancy maps to 403 verification_required. optionalSessionActor stays null
 * so anonymous insight ingest does not owner-skip.
 */
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { describe, test } from 'vitest';
import {
  BrowserSessionAuthenticationError,
  type BrowserSessionAuthority,
} from '../../../src/modules/auth/index.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';
import {
  optionalSessionActor,
  requireSessionActor,
} from '../../../src/transport/session-auth.js';

const unusedUnitOfWork: IdentityUnitOfWork = {
  execute: async () => {
    throw new Error('legacy identity work must not run when the authority is injected');
  },
};

function occupancyAuthority(): BrowserSessionAuthority {
  return {
    authenticate: async () => null,
    requireMutationActor: async () => {
      throw new BrowserSessionAuthenticationError(
        'verification_required',
        'email verification is required',
      );
    },
    bootstrap: async () => ({ authenticated: false, verificationRequired: true }),
    signOut: async () => undefined,
    revokeAll: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
    revokeOthersKeepingCurrent: async () => ({
      securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0,
    }),
    listLiveSessions: async () => [],
    revokeSessionById: async () => ({ revoked: false }),
  } as unknown as BrowserSessionAuthority;
}

function missingAuthority(): BrowserSessionAuthority {
  return {
    authenticate: async () => null,
    requireMutationActor: async () => {
      throw new BrowserSessionAuthenticationError(
        'authentication_required',
        'a valid browser session is required',
      );
    },
    bootstrap: async () => ({ authenticated: false }),
    signOut: async () => undefined,
    revokeAll: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
    revokeOthersKeepingCurrent: async () => ({
      securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0,
    }),
    listLiveSessions: async () => [],
    revokeSessionById: async () => ({ revoked: false }),
  } as unknown as BrowserSessionAuthority;
}

describe('C-02 occupancy HTTP mapping', () => {
  test('requireSessionActor maps occupancy to 403 verification_required', async () => {
    const request = {
      headers: { cookie: 'x=1' },
      server: { browserSessionAuthority: occupancyAuthority() },
    } as unknown as FastifyRequest;

    await assert.rejects(
      () => requireSessionActor(request, unusedUnitOfWork, { touch: false }),
      (error: unknown) => {
        assert.ok(error instanceof ProductHttpError);
        assert.equal(error.statusCode, 403);
        assert.equal(error.productCode, 'verification_required');
        return true;
      },
    );
  });

  test('requireSessionActor maps a missing session to 401 authentication_required', async () => {
    const request = {
      headers: {},
      server: { browserSessionAuthority: missingAuthority() },
    } as unknown as FastifyRequest;

    await assert.rejects(
      () => requireSessionActor(request, unusedUnitOfWork, { touch: false }),
      (error: unknown) => {
        assert.ok(error instanceof ProductHttpError);
        assert.equal(error.statusCode, 401);
        assert.equal(error.productCode, 'authentication_required');
        return true;
      },
    );
  });

  test('optionalSessionActor stays null for occupancy (anonymous ingest)', async () => {
    const request = {
      headers: { cookie: 'x=1' },
      server: { browserSessionAuthority: occupancyAuthority() },
    } as unknown as FastifyRequest;
    assert.equal(await optionalSessionActor(request, unusedUnitOfWork), null);
  });

  test('optionalSessionActor stays null when there is no session', async () => {
    const request = {
      headers: {},
      server: { browserSessionAuthority: missingAuthority() },
    } as unknown as FastifyRequest;
    assert.equal(await optionalSessionActor(request, unusedUnitOfWork), null);
  });
});
