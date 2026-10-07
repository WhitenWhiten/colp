import assert from 'node:assert/strict';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, test } from 'vitest';
import type { Account, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import {
  omitAutomationIdentityFields,
  rejectMixedCarriers,
  type ProductBearerAuthority,
} from '../../../src/transport/product-actor.js';
import {
  optionalSessionActor,
  requireProductActor,
  requireSessionActor,
} from '../../../src/transport/session-auth.js';
import { requireMutationActor } from '../../../src/transport/mutation-actor.js';
import { redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';

const unusedUnitOfWork: IdentityUnitOfWork = {
  execute: async () => {
    throw new Error('cookie session must not run on the bearer path');
  },
};

const account: Account = {
  id: 'acct_1',
  subjectId: 'sub_1',
  status: 'active',
  email: null,
  securityEpoch: 0n,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

function bearerAuthority(scopes: readonly string[] = ['product:read', 'product:write']): ProductBearerAuthority {
  const actor = {
    account,
    credentialId: 'cred_1',
    subjectId: account.subjectId,
    scopes,
    expiresAt: new Date('2026-01-01T00:05:00.000Z'),
  };
  return {
    async requireRead() {
      if (!scopes.includes('product:read')) {
        throw new ProductHttpError({ statusCode: 403, code: 'insufficient_permission', message: 'missing read' });
      }
      return actor;
    },
    async requireWrite() {
      if (!scopes.includes('product:write')) {
        throw new ProductHttpError({ statusCode: 403, code: 'insufficient_permission', message: 'missing write' });
      }
      return actor;
    },
    async inspect() { return actor; },
  };
}

function request(headers: Record<string, string>, authority?: ProductBearerAuthority): FastifyRequest {
  return {
    headers,
    server: { productBearerAuthority: authority },
  } as unknown as FastifyRequest;
}

async function injectProductJson(
  exposeAutomationIdentity: boolean | undefined,
  url: string,
): Promise<Record<string, unknown>> {
  const server = Fastify({ logger: false });
  if (exposeAutomationIdentity === undefined) installProductAdmission(server);
  else installProductAdmission(server, { exposeAutomationIdentity });
  server.get('/api/v1/dummy-product', async () => ({ title: 'x', isBot: false, credentialId: 'c' }));
  server.get('/api/v1/credential-decoy', async () => ({ credentialId: 'c' }));
  server.setNotFoundHandler(async () => ({ credentialId: 'c' }));
  server.get('/api/v1/collections', async () => ({ title: 'x', credentialId: 'c' }));
  server.get('/api/v1/me/credential-grants/:grantId', { config: { credentialAccess: async () => {} } }, async () => ({
    id: 'grant_1',
    credentialId: 'c',
  }));
  server.get('/api/v1/me/credential-identity', { config: { credentialAccess: async () => {} } }, async () => ({
    accountId: 'a',
    credentialId: 'c',
    expiresAt: '2026-01-01T00:00:00.000Z',
    scopes: ['product:read'],
    subjectId: 's',
  }));
  try {
    const response = await server.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Record<string, unknown>;
  } finally {
    await server.close();
  }
}

describe('product actor mixed carriers', () => {
  test('rejectMixedCarriers throws 400 invalid_request', () => {
    assert.throws(
      () => rejectMixedCarriers(request({ cookie: 'x=1', authorization: 'Bearer t' })),
      (error: unknown) => {
        assert.ok(error instanceof ProductHttpError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.productCode, 'invalid_request');
        return true;
      },
    );
  });

  test('requireSessionActor and requireProductActor read reject mixed Cookie+Authorization', async () => {
    const mixed = request({ cookie: 'x=1', authorization: 'Bearer t' }, bearerAuthority());
    await assert.rejects(
      () => requireSessionActor(mixed, unusedUnitOfWork, { touch: false }),
      (error: unknown) => error instanceof ProductHttpError && error.statusCode === 400,
    );
    await assert.rejects(
      () => requireProductActor(mixed, { identityUnitOfWork: unusedUnitOfWork }, { access: 'read', touch: false }),
      (error: unknown) => error instanceof ProductHttpError && error.statusCode === 400,
    );
  });

  test('requireMutationActor rejects mixed carriers before CSRF', async () => {
    await assert.rejects(
      () => requireMutationActor(
        request({ cookie: 'x=1', authorization: 'Bearer t' }, bearerAuthority()),
        { identityUnitOfWork: unusedUnitOfWork, allowedOrigins: ['https://app.example.test'] },
      ),
      (error: unknown) => error instanceof ProductHttpError && error.statusCode === 400,
    );
  });
});

describe('product actor bearer admission', () => {
  test('GET helper accepts product-audience bearer with product:read', async () => {
    const actor = await requireSessionActor(
      request({ authorization: 'Bearer t' }, bearerAuthority(['product:read'])),
      unusedUnitOfWork,
      { touch: false },
    );
    assert.equal(actor.account.id, account.id);
    assert.equal('session' in actor && actor.session !== undefined, false);
  });

  test('write helper requires product:write and skips CSRF', async () => {
    const actor = await requireMutationActor(
      request({ authorization: 'Bearer t' }, bearerAuthority(['product:write'])),
      { identityUnitOfWork: unusedUnitOfWork, allowedOrigins: ['https://app.example.test'] },
    );
    assert.equal(actor.account.id, account.id);
    await assert.rejects(
      () => requireMutationActor(
        request({ authorization: 'Bearer t' }, bearerAuthority(['product:read'])),
        { identityUnitOfWork: unusedUnitOfWork, allowedOrigins: ['https://app.example.test'] },
      ),
      (error: unknown) => error instanceof ProductHttpError && error.statusCode === 403,
    );
  });

  test('optionalSessionActor admits bearer and does not fall back to anonymous', async () => {
    const actor = await optionalSessionActor(
      request({ authorization: 'Bearer t' }, bearerAuthority(['product:read'])),
      unusedUnitOfWork,
    );
    assert.equal(actor?.account.id, account.id);
    await assert.rejects(
      () => optionalSessionActor(request({ authorization: 'Bearer t' }), unusedUnitOfWork),
      (error: unknown) => error instanceof ProductHttpError && error.statusCode === 401,
    );
  });
});

describe('automation identity omission', () => {
  test('omits identity-source keys when the switch is off and does not rewrite body text', () => {
    const body = {
      title: 'the isBot automation credentialId issuanceSource marker stays in prose',
      isBot: false,
      automation: null,
      credentialId: 'cred_1',
      issuanceSource: 'child',
    };
    const omitted = omitAutomationIdentityFields(body, false);
    assert.equal('isBot' in omitted, false);
    assert.equal('automation' in omitted, false);
    assert.equal('credentialId' in omitted, false);
    assert.equal('issuanceSource' in omitted, false);
    assert.equal(omitted.title, body.title);
    const exposed = omitAutomationIdentityFields(body, true);
    assert.equal(exposed.isBot, false);
    assert.equal(exposed.credentialId, 'cred_1');
  });

  test('preSerialization omits identity-source keys on ordinary Product JSON when the switch is off', async () => {
    const body = await injectProductJson(undefined, '/api/v1/dummy-product');
    assert.equal(body.title, 'x');
    assert.equal('isBot' in body, false);
    assert.equal('credentialId' in body, false);
  });

  test('preSerialization keeps identity-source keys on ordinary Product JSON when the switch is on', async () => {
    const body = await injectProductJson(true, '/api/v1/dummy-product');
    assert.equal(body.title, 'x');
    assert.equal(body.isBot, false);
    assert.equal(body.credentialId, 'c');
  });

  test('preSerialization keeps credentialId on credential-identity when the switch is off', async () => {
    const body = await injectProductJson(false, '/api/v1/me/credential-identity');
    assert.equal(body.credentialId, 'c');
  });

  test('preSerialization keeps credentialId on credential-grant item GET when the switch is off', async () => {
    const body = await injectProductJson(false, '/api/v1/me/credential-grants/grant_1');
    assert.equal(body.credentialId, 'c');
  });

  test('a credential substring in a registered or unknown path cannot enable identity exposure', async () => {
    for (const url of ['/api/v1/credential-decoy', '/api/v1/not-found/credential-identity']) {
      const body = await injectProductJson(false, url);
      assert.equal('credentialId' in body, false);
    }
  });

  test('preSerialization omits credentialId on collections when the switch is off', async () => {
    const body = await injectProductJson(false, '/api/v1/collections');
    assert.equal(body.title, 'x');
    assert.equal('credentialId' in body, false);
  });

  test('redactSensitiveText removes kn_c_ and kn_p_ secrets', () => {
    const child = 'kn_c_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const parent = 'kn_p_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const redacted = redactSensitiveText(`issued ${child} then ${parent}`);
    assert.equal(redacted.includes(child), false);
    assert.equal(redacted.includes(parent), false);
    assert.match(redacted, /\[REDACTED\]/u);
    assert.equal(redactSensitiveText('known collections stay visible').includes('known collections stay visible'), true);
  });
});
