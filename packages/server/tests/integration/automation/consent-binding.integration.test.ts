import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import type { WorkPrincipal } from '../../../src/modules/automation/index.js';

const CHATGPT = 'https://chatgpt.com/oauth/client.json';
type Fixture = Awaited<ReturnType<typeof automationWorkerFixture>>;

/** The Owner's Better Auth user; one per account. */
async function ownerUser(f: Fixture): Promise<string> {
  const existing = (await sql<{ id: string }>`SELECT auth_user_id AS id FROM auth_user_account_map WHERE account_id=${f.owner.accountId}`.execute(f.db)).rows[0];
  if (existing) return existing.id;
  const id = `user-${randomUUID()}`;
  await sql`INSERT INTO auth_users(id,name,email,"emailVerified") VALUES(${id},'Owner',${id+'@example.test'},true)`.execute(f.db);
  await sql`INSERT INTO auth_user_account_map(auth_user_id,account_id) VALUES(${id},${f.owner.accountId})`.execute(f.db);
  return id;
}
/** A client registered through DCR and the consent the Owner gave it on the consent page. */
async function consent(f: Fixture,clientId: string,name: string | null,scopes: string[]): Promise<void> {
  const userId = await ownerUser(f);
  await sql`INSERT INTO "auth_oauth_client"(id,"clientId",name,"redirectUris","createdAt","updatedAt") VALUES(${randomUUID()},${clientId},${name},'[]'::jsonb,clock_timestamp(),clock_timestamp())
    ON CONFLICT ("clientId") DO UPDATE SET name=EXCLUDED.name`.execute(f.db);
  await sql`INSERT INTO "auth_oauth_consent"(id,"clientId","userId",scopes,"createdAt","updatedAt") VALUES(${randomUUID()},${clientId},${userId},${JSON.stringify(scopes)}::jsonb,clock_timestamp(),clock_timestamp())`.execute(f.db);
}
const owner = (f: Fixture,path: string) => f.app.inject({ url: '/api/v1/me/automations'+path,headers: { cookie: f.owner.cookie } });
const asWorker = (f: Fixture,token: string) => f.app.inject({ url: '/api/v1/automation-work/jobs',headers: { authorization: 'Bearer '+token } });
async function principal(f: Fixture,token: string): Promise<WorkPrincipal> {
  const v = await f.verifier.verify({ authorization: 'Bearer '+token });
  return { accountId: v.binding.principalId,subjectId: v.accountSubjectId,clientId: v.binding.clientId,credentialBindingId: v.automationConnectionId ?? v.binding.credentialBindingId,
    resourceAudience: v.binding.resourceAudience,securityEpoch: v.binding.securityEpoch,scopes: v.scopes,credentialDigest: v.credentialDigest,expiresAt: v.expiresAt.toISOString(),
    issuedAtSeconds: v.issuedAtSeconds,accountSecurityEpoch: v.accountSecurityEpoch };
}

describeWithPostgres('Consent-granted worker binding: the consent page is the permit',() => {
  let f: Fixture;
  afterEach(async () => { await f?.close(); });

  test('an agent the Owner allowed to do rule work is a paired worker on first contact, without a code',async () => {
    f = await automationWorkerFixture('consent_bind',100,false,true);
    await consent(f,CHATGPT,'ChatGPT',['mcp:read:own','automation:work']);
    const token = await f.mint({ clientId: CHATGPT,scopes: ['mcp:read:own','automation:work'] });
    expect((await owner(f,'/targets')).json().items).toEqual([]);
    const listed = await asWorker(f,token);
    expect(listed.statusCode,listed.body).toBe(200);expect(listed.json().items).toEqual([]);
    const targets = (await owner(f,'/targets')).json().items;
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ configuration: { name: 'ChatGPT',privacy: 'standard',wakeMode: 'poll' },status: 'active',wakeReadiness: 'active',isolation: 'sharedCredential' });
    const actor = await principal(f,token),profiles = (await owner(f,'/connection-profiles')).json().items;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].configuration).toEqual({ name: 'ChatGPT',authorizedClientId: CHATGPT,credentialBindingId: actor.credentialBindingId,automationEnabled: true,catalogs: ['standard','automationWorker'] });
    // Secret-free evidence only, and a second contact changes nothing.
    const observation = (await sql<{ observation_json: unknown }>`SELECT observation_json FROM automation_connection_profiles`.execute(f.db)).rows[0]!.observation_json;
    expect(JSON.stringify(observation)).not.toContain(token);
    expect((await asWorker(f,token)).statusCode).toBe(200);
    expect((await owner(f,'/targets')).json().items).toHaveLength(1);
    expect((await owner(f,'/connection-profiles')).json().items).toHaveLength(1);
    // The MCP catalog sees the paired inbox at once; the same client in an ordinary chat, without the scope, sees nothing new.
    const access = await f.worker.access(actor);
    expect(access?.catalogs).toEqual(['standard','automationWorker']);expect(access?.pairedTargets).toHaveLength(1);
    expect(await f.worker.access(await principal(f,await f.mint({ clientId: CHATGPT,scopes: ['mcp:read:own'] })))).toBeNull();
  });

  test('a client allowed to manage rules too gets the manager catalog; the registered name falls back to the client host',async () => {
    f = await automationWorkerFixture('consent_manage',100,false,true);
    await consent(f,CHATGPT,null,['automation:work','automation:manage','automation:read']);
    const token = await f.mint({ clientId: CHATGPT,scopes: ['automation:work','automation:manage','automation:read'] });
    expect((await asWorker(f,token)).statusCode).toBe(200);
    const profile = (await owner(f,'/connection-profiles')).json().items[0];
    expect(profile.configuration).toMatchObject({ name: 'chatgpt.com',catalogs: ['standard','automationWorker','automationManager'] });
    expect((await owner(f,'/targets')).json().items[0].configuration.name).toBe('chatgpt.com');
  });

  test('without a consent that includes automation:work nothing binds: the one-use code remains the only path',async () => {
    f = await automationWorkerFixture('consent_scope',100,false,true);
    await consent(f,CHATGPT,'ChatGPT',['mcp:read:own']);
    const token = await f.mint({ clientId: CHATGPT,scopes: ['automation:work'] });
    expect((await asWorker(f,token)).statusCode).toBe(404);
    expect(await f.worker.access(await principal(f,token))).toBeNull();
    // The fixture's own credential has no consent row: the pairing tests keep their meaning.
    expect((await asWorker(f,f.token)).statusCode).toBe(404);
    expect((await owner(f,'/targets')).json().items).toEqual([]);
    expect((await owner(f,'/connection-profiles')).json().items).toEqual([]);
  });

  test('the Owner’s own registration (guided setup) is adopted on first contact, and an opt-in change re-pairs without a code',async () => {
    f = await automationWorkerFixture('consent_adopt',100,false,true);
    await consent(f,CHATGPT,'ChatGPT',['automation:work','automation:manage']);
    const registered = await f.ownerPost('/connection-profiles',{ name: 'ChatGPT',automationEnabled: true,authorizedClientId: CHATGPT,credentialBindingId: 'pending-owner-chose-agent',catalogs: ['standard','automationWorker'] });
    expect(registered.statusCode,registered.body).toBe(201);
    const target = await f.ownerPost('/targets',{ name: 'Research',providerLabel: '',broadcastOptIn: false,privacy: 'standard',connectionProfileId: registered.json().id,wakeMode: 'poll',pollIntervalMinutes: 5 });
    expect(target.statusCode,target.body).toBe(201);expect(target.json().wakeReadiness).toBe('waitingForPairing');
    const token = await f.mint({ clientId: CHATGPT,scopes: ['automation:work','automation:manage'] }),actor = await principal(f,token);
    expect((await asWorker(f,token)).statusCode).toBe(200);
    const profiles = (await owner(f,'/connection-profiles')).json().items;
    expect(profiles).toHaveLength(1);
    // Adoption binds the credential and keeps the Owner's opt-ins as they were.
    expect(profiles[0].configuration).toMatchObject({ credentialBindingId: actor.credentialBindingId,catalogs: ['standard','automationWorker'] });
    expect((await owner(f,`/targets/${target.json().id}`)).json()).toMatchObject({ wakeReadiness: 'active',configuration: { name: 'Research',pollIntervalMinutes: 5 } });
    expect((await owner(f,'/targets')).json().items).toHaveLength(1);

    const put = async (catalogs: string[]) => {
      const current = await owner(f,`/connection-profiles/${profiles[0].id}`);
      return f.app.inject({ method: 'PUT',url: `/api/v1/me/automations/connection-profiles/${profiles[0].id}`,headers: f.ownerHeaders(randomUUID(),String(current.headers.etag)),
        payload: { ...current.json().configuration,catalogs } });
    };
    const off = await put(['standard']);expect(off.statusCode,off.body).toBe(200);
    expect((await owner(f,`/targets/${target.json().id}`)).json().wakeReadiness).toBe('waitingForPairing');
    expect((await asWorker(f,token)).statusCode).toBe(404);
    expect((await owner(f,'/connection-profiles')).json().items).toHaveLength(1);
    const on = await put(['standard','automationWorker']);expect(on.statusCode,on.body).toBe(200);
    expect((await owner(f,`/targets/${target.json().id}`)).json().wakeReadiness).toBe('waitingForPairing');
    expect((await asWorker(f,token)).statusCode).toBe(200);
    expect((await owner(f,`/targets/${target.json().id}`)).json().wakeReadiness).toBe('active');
    expect((await owner(f,'/connection-profiles')).json().items).toHaveLength(1);
  });
});
