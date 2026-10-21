import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('AW-26 authenticated worker bootstrap and pairing',() => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });
  test('ChatGPT CIMD identity can create, read, update and pair an Events worker',async () => {
    f = await automationWorkerFixture('cimd_worker');
    const clientId = 'https://chatgpt.com/oauth/client.json';
    const profile = await f.ownerPost('/connection-profiles',{
      name: 'ChatGPT',automationEnabled: true,authorizedClientId: clientId,
      credentialBindingId: 'pending-owner-chose-agent',catalogs: ['standard','automationWorker'],
    });
    expect(profile.statusCode,profile.body).toBe(201);
    expect(profile.json().configuration.authorizedClientId).toBe(clientId);
    const target = await f.ownerPost('/targets',{
      name: 'default-worker',providerLabel: '',broadcastOptIn: false,privacy: 'standard',
      connectionProfileId: profile.json().id,wakeMode: 'events',
    });
    expect(target.statusCode,target.body).toBe(201);
    const grant = await f.ownerPost(`/targets/${target.json().id}/pairings`,{ reason: 'Pair ChatGPT' },String(target.headers.etag));
    expect(grant.statusCode,grant.body).toBe(201);
    // The exact authenticated URL is the identity; another client cannot redeem its grant.
    expect((await f.pair(grant.json())).statusCode).toBe(404);
    const token = await f.mint({ clientId });
    const paired = await f.pair(grant.json(),randomUUID(),token);
    expect(paired.statusCode,paired.body).toBe(200);
    expect(paired.json()).toMatchObject({ wakeMode: 'events',wakeReadiness: 'waitingForSubscription' });
    const read = await f.app.inject({ url: `/api/v1/me/automations/connection-profiles/${profile.json().id}`,headers: { cookie: f.owner.cookie } });
    expect(read.statusCode,read.body).toBe(200);
    expect(read.json().configuration.authorizedClientId).toBe(clientId);
    const renamed = await f.app.inject({ method: 'PUT',url: `/api/v1/me/automations/connection-profiles/${profile.json().id}`,
      headers: f.ownerHeaders(randomUUID(),String(read.headers.etag)),payload: { ...read.json().configuration,name: 'ChatGPT summaries' } });
    expect(renamed.statusCode,renamed.body).toBe(200);
    expect(renamed.json().configuration.authorizedClientId).toBe(clientId);
  });
  test('worker-only bootstrap pairs via real JWT without manager scope, code is hashed and secret-free replay is fenced',async () => {
    f = await automationWorkerFixture('aw26_bootstrap'); const setup = await f.setup();
    expect(f.actor.scopes).toEqual(['automation:work']); expect(setup.target.wakeReadiness).toBe('waitingForPairing');
    const command = randomUUID(),paired = await f.pair(setup.grant,command); expect(paired.statusCode,paired.body).toBe(200);
    expect(paired.json()).toMatchObject({ status: 'active',wakeMode: 'poll',wakeReadiness: 'active',isolation: 'sharedCredential' });
    expect((await f.pair(setup.grant,command)).body).toBe(paired.body);
    expect((await f.pair(setup.grant)).statusCode).toBe(404);
    const stored = (await sql<{ code_hash: string; consumed_at: Date }>`SELECT code_hash,consumed_at FROM automation_pairings`.execute(f.db)).rows[0]!;
    expect(stored.code_hash).toMatch(/^[a-f0-9]{64}$/);expect(stored.consumed_at).toBeTruthy();
    const receipts = await f.db.selectFrom('product_command_receipts').select('result_bytes').execute();
    expect(receipts.map(r => Buffer.from(r.result_bytes ?? []).toString('utf8')).join('\n')).not.toContain(setup.grant.code);
    const observation = (await sql<{ observation_json: unknown }>`SELECT observation_json FROM automation_connection_profiles`.execute(f.db)).rows[0]!.observation_json;
    expect(JSON.stringify(observation)).not.toContain(f.token);expect(JSON.stringify(observation)).not.toContain(f.owner.cookie);
    const current = paired.json();
    const revoked = await f.ownerPost(`/targets/${current.id}/revoke`,{ reason: 'Owner revokes' },`"${current.revision}"`);expect(revoked.statusCode,revoked.body).toBe(200);
    expect((await f.pair(setup.grant,command)).statusCode).toBe(404);
  });
  test('foreign client/Owner, invalid codes and expired grants cannot bind; racing claims consume once',async () => {
    f = await automationWorkerFixture('aw26_negative'); const setup = await f.setup();
    const otherClient = await f.mint({ clientId: 'other-client' });expect((await f.pair(setup.grant,randomUUID(),otherClient)).statusCode).toBe(404);
    const foreign = await f.issue('foreign'),otherOwner = await f.mint({ subjectId: foreign.subjectId });expect((await f.pair(setup.grant,randomUUID(),otherOwner)).statusCode).toBe(404);
    expect((await f.pair({ ...setup.grant,code: 'wrong' })).statusCode).toBe(404);
    await sql`UPDATE automation_pairings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${setup.grant.pairingId}`.execute(f.db);
    expect((await f.pair(setup.grant)).statusCode).toBe(404);
    const fresh = await f.ownerPost(`/targets/${setup.target.id}/pairings`,{ reason: 'Fresh grant' },setup.grantEtag);expect(fresh.statusCode,fresh.body).toBe(201);
    const races = await Promise.all([f.pair(fresh.json()),f.pair(fresh.json())]);expect(races.map(r => r.statusCode).sort()).toEqual([200,404]);
  });
  test('the chosen agent confirms its credential with its first valid code, and only then',async () => {
    f = await automationWorkerFixture('aw26_adopt'); const setup = await f.setup({ credentialBindingId: 'pending-owner-chose-agent' });
    const binding = async () => (await sql<{ binding: string; revision: string }>`SELECT configuration_json->>'credentialBindingId' AS binding,revision::text AS revision
      FROM automation_connection_profiles WHERE id=${setup.profile.id}`.execute(f.db)).rows[0]!;
    // Another client, another Owner or a wrong code leaves the Owner's registration alone.
    expect((await f.pair(setup.grant,randomUUID(),await f.mint({ clientId: 'other-client' }))).statusCode).toBe(404);
    const foreign = await f.issue('adopt_foreign');expect((await f.pair(setup.grant,randomUUID(),await f.mint({ subjectId: foreign.subjectId }))).statusCode).toBe(404);
    expect((await f.pair({ ...setup.grant,code: 'wrong' })).statusCode).toBe(404);
    expect(await binding()).toEqual({ binding: 'pending-owner-chose-agent',revision: setup.profile.revision });

    const command = randomUUID(),paired = await f.pair(setup.grant,command);expect(paired.statusCode,paired.body).toBe(200);
    expect(paired.json()).toMatchObject({ id: setup.target.id,wakeReadiness: 'active' });
    expect((await binding()).binding).toBe(f.actor.credentialBindingId);
    expect(Number((await binding()).revision)).toBe(Number(setup.profile.revision)+1);
    await f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id));
    expect((await f.pair(setup.grant,command)).body).toBe(paired.body);
    const profile = await f.app.inject({ url: `/api/v1/me/automations/connection-profiles/${setup.profile.id}`,headers: { cookie: f.owner.cookie } });
    expect(profile.json().configuration.credentialBindingId).toBe(f.actor.credentialBindingId);
  });
  test('a code never moves a working worker to another credential of its agent',async () => {
    f = await automationWorkerFixture('aw26_adopt_guard'); const setup = await f.setup();
    expect((await f.pair(setup.grant)).statusCode).toBe(200);
    const second = await f.ownerPost('/targets',{ ...setup.target.configuration,name: 'Second target' });expect(second.statusCode,second.body).toBe(201);
    const grant = await f.ownerPost(`/targets/${second.json().id}/pairings`,{ reason: 'Owner pairs a second worker' },String(second.headers.etag));
    expect(grant.statusCode,grant.body).toBe(201);
    // Same agent, different scopes: a different OAuth connection.
    const other = await f.mint({ scopes: ['automation:work','automation:read'] });
    expect((await f.pair(grant.json(),randomUUID(),other)).statusCode).toBe(404);
    const stored = (await sql<{ binding: string }>`SELECT configuration_json->>'credentialBindingId' AS binding FROM automation_connection_profiles`.execute(f.db)).rows[0]!;
    expect(stored.binding).toBe(f.actor.credentialBindingId);
    await f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id));
  });
  test('pairing a lone worker again moves it to the agent’s new credential',async () => {
    f = await automationWorkerFixture('aw26_adopt_rotate'); const setup = await f.setup();
    const first = await f.pair(setup.grant);expect(first.statusCode,first.body).toBe(200);
    const again = await f.ownerPost(`/targets/${setup.target.id}/pairings`,{ reason: 'Owner pairs again' },`"${first.json().revision}"`);
    expect(again.statusCode,again.body).toBe(201);
    const rotated = await f.mint({ scopes: ['automation:work','automation:read'] });
    const verified = await f.verifier.verify({ authorization: 'Bearer '+rotated,requiredScopes: ['automation:work'] });
    expect(verified.automationConnectionId).not.toBe(f.actor.credentialBindingId);
    expect((await f.pair(again.json(),randomUUID(),rotated)).statusCode).toBe(200);
    const stored = (await sql<{ binding: string }>`SELECT configuration_json->>'credentialBindingId' AS binding FROM automation_connection_profiles`.execute(f.db)).rows[0]!;
    expect(stored.binding).toBe(verified.automationConnectionId);
    await expect(f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id))).rejects.toMatchObject({ code: 'resource_not_found' });
  });
  test('shared credentials cannot activate restricted work; Events readiness is unavailable rather than inferred',async () => {
    f = await automationWorkerFixture('aw26_restricted'); const setup = await f.setup({ privacy: 'restricted',wakeMode: 'events' });
    const paired = await f.pair(setup.grant);expect(paired.statusCode,paired.body).toBe(200);
    expect(paired.json()).toMatchObject({ isolation: 'sharedCredential',wakeReadiness: 'blocked',subscriptionCount: 0 });
    await expect(f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id))).rejects.toMatchObject({ code: 'resource_not_found' });
    const updated = await f.app.inject({ method: 'PUT',url: `/api/v1/me/automations/targets/${setup.target.id}`,headers: f.ownerHeaders(randomUUID(),`"${paired.json().revision}"`),payload: { ...setup.target.configuration,privacy: 'standard' } });
    expect(updated.statusCode,updated.body).toBe(200);expect(updated.json()).toMatchObject({ status: 'awaitingSubscription',wakeReadiness: 'waitingForSubscription',subscriptionCount: 0 });
  });
  test('renames keep the pairing and Events generation; a new credential or data terms do not',async () => {
    f = await automationWorkerFixture('aw26_edits'); const setup = await f.setup();
    const paired = await f.pair(setup.grant);expect(paired.statusCode,paired.body).toBe(200);
    const state = async () => (await sql<{ generation: number; paired: boolean }>`SELECT pairing_generation::int AS generation,paired
      FROM automation_targets WHERE id=${setup.target.id}`.execute(f.db)).rows[0]!;
    const put = (path: string,revision: string,payload: unknown) => f.app.inject({ method: 'PUT',url: '/api/v1/me/automations'+path,headers: f.ownerHeaders(randomUUID(),`"${revision}"`),payload });
    const before = await state();expect(before.paired).toBe(true);
    const renamed = await put(`/targets/${setup.target.id}`,paired.json().revision,{ ...setup.target.configuration,name: 'Renamed target',providerLabel: 'Renamed provider' });
    expect(renamed.statusCode,renamed.body).toBe(200);expect(await state()).toEqual(before);
    const profile = await put(`/connection-profiles/${setup.profile.id}`,setup.profile.revision,{ ...setup.profile.configuration,name: 'Renamed profile' });
    expect(profile.statusCode,profile.body).toBe(200);expect(await state()).toEqual(before);
    const restricted = await put(`/targets/${setup.target.id}`,renamed.json().revision,{ ...renamed.json().configuration,privacy: 'restricted' });
    expect(restricted.statusCode,restricted.body).toBe(200);expect(await state()).toEqual({ generation: before.generation+1,paired: true });
    const rebound = await put(`/connection-profiles/${setup.profile.id}`,profile.json().revision,{ ...profile.json().configuration,credentialBindingId: 'another-credential' });
    expect(rebound.statusCode,rebound.body).toBe(200);expect(await state()).toEqual({ generation: before.generation+2,paired: false });
  });
  test('worker HTTP routes share a per-connection request budget and answer 429 with Retry-After',async () => {
    f = await automationWorkerFixture('aw26_work_budget',2,false,true); const setup = await f.setup();
    expect((await f.pair(setup.grant)).statusCode).toBe(200);
    const list = () => f.app.inject({ url: '/api/v1/automation-work/jobs',headers: { authorization: 'Bearer '+f.token } });
    for (let i = 0; i < 2; i++) { const allowed = await list();expect(allowed.statusCode,allowed.body).toBe(200); }
    const limited = await list();expect(limited.statusCode,limited.body).toBe(429);expect(limited.headers['retry-after']).toBeTruthy();
  });
  test('current OAuth revocation blocks authorization and pairing; invalid code rate limit is shared',async () => {
    f = await automationWorkerFixture('aw26_revocation',2); const setup = await f.setup();
    expect((await f.pair({ ...setup.grant,code: 'wrong' })).statusCode).toBe(404);
    expect((await f.pair({ ...setup.grant,code: 'wrong' })).statusCode).toBe(404);
    const limited = await f.pair(setup.grant);expect(limited.statusCode,limited.body).toBe(429);expect(limited.headers['retry-after']).toBeTruthy();
    f.limiter.reset();expect((await f.pair(setup.grant)).statusCode).toBe(200);
    await f.revocations.revokeClient(f.actor.clientId);
    const status = await f.app.inject({ url: `/api/v1/me/automations/targets/${setup.target.id}`,headers: { cookie: f.owner.cookie } });
    expect(status.json().wakeReadiness).toBe('blocked');
    expect((await f.pair(setup.grant)).statusCode).toBe(401);
    await expect(f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id))).rejects.toMatchObject({ code: 'resource_not_found' });
  });  test('an account epoch change fences the cached pairing and the signed bearer',async () => {
    f = await automationWorkerFixture('aw26_epoch');const setup = await f.setup();expect((await f.pair(setup.grant)).statusCode).toBe(200);
    await sql`UPDATE accounts SET security_epoch=security_epoch+1,security_epoch_bumped_at=clock_timestamp() WHERE id=${f.owner.accountId}`.execute(f.db);
    expect((await f.pair(setup.grant)).statusCode).toBe(401);
    await expect(f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id))).rejects.toMatchObject({ code: 'resource_not_found' });
  });
  test('a real child-key exchange gives a stable dedicated binding, which current revocation fences',async () => {
    f = await automationWorkerFixture('aw26_machine',100,true);const setup = await f.setup({ privacy: 'restricted' });
    const command = randomUUID(),paired = await f.pair(setup.grant,command);expect(paired.statusCode,paired.body).toBe(200);
    expect(paired.json()).toMatchObject({ isolation: 'dedicatedCredential',wakeReadiness: 'active' });
    const fresh = await f.mint(),verified = await f.verifier.verify({ authorization: 'Bearer '+fresh });
    expect(verified.binding.credentialBindingId).toBe(f.actor.credentialBindingId);
    expect(verified.automationConnectionId).toBe(f.actor.credentialBindingId);
    expect((await f.pair(setup.grant,command,fresh)).statusCode).toBe(200);
    await f.revokeWorker();expect((await f.pair(setup.grant,command,fresh)).statusCode).toBe(401);
    await expect(f.db.transaction().execute(tx => f.worker.authorize(tx,f.actor,setup.target.id))).rejects.toMatchObject({ code: 'resource_not_found' });
  });

});
