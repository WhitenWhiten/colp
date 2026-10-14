import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('Automation OAuth connection refresh', () => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });

  test('real refreshed Bearer retains pairing, updates observations and still enforces client/scope revocation', async () => {
    f = await automationWorkerFixture('automation_oauth_refresh', 100, false, true);
    const setup = await f.setup({ wakeMode: 'poll' });
    expect((await f.pair(setup.grant)).statusCode).toBe(200);
    const list = (token: string) => f.app.inject({
      url: `/api/v1/automation-work/jobs?targetId=${setup.target.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await list(f.token)).statusCode).toBe(200);
    const token = await f.mint();
    const verified = await f.verifier.verify({ authorization: `Bearer ${token}`, requiredScopes: ['automation:work'] });
    // The worker connection is stable across refresh; the MCP binding stays token-specific.
    expect(verified.automationConnectionId).toBe(f.actor.credentialBindingId);
    expect(verified.binding.credentialBindingId).not.toBe(f.actor.credentialBindingId);
    await sql`UPDATE automation_connection_profiles SET observation_json=jsonb_set(observation_json,
      '{expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text))`.execute(f.db);
    expect((await list(token)).statusCode).toBe(200);
    const target = await f.app.inject({ url: `/api/v1/me/automations/targets/${setup.target.id}`, headers: { cookie: f.owner.cookie } });
    expect(target.json().wakeReadiness).toBe('active');
    expect((await list(await f.mint({ clientId: 'other-client' }))).statusCode).toBe(404);
    expect((await list(await f.mint({ scopes: ['automation:work', 'mcp:read:own'] }))).statusCode).toBe(404);
    await f.revocations.revokeClient(f.actor.clientId);
    expect((await list(token)).statusCode).toBe(401);
  });
});
