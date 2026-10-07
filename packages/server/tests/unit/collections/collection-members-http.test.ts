import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  UNKNOWN_EMAIL,
  INVITE_201_KEYS,
  FORBIDDEN_201_KEYS,
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  COMMAND_D,
  COMMAND_E,
  COMMAND_F,
  ALREADY_MEMBER_MESSAGE,
  COLLABORATION_MEMBERS_LIST_LIMIT,
  COLLABORATION_MY_INVITES_LIST_LIMIT,
  COLLABORATION_PENDING_INVITE_LIMIT,
  INVITE_ALREADY_PENDING_MESSAGE,
  ORIGIN,
  createHarness,
  seedCollection,
  seedPrincipal,
  session,
  writeHeaders,
  inviteUrl,
  membersUrl,
  etagOf,
  assertProductError,
  assertNoForbidden201Keys,
} from '../../support/collection-members-http-harness.js';

test('owner invite is 201 with frozen keys', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-invite', email: 'owner-invite@example.test', displayName: 'Ada Owner',
  });
  seedCollection(harness.state, { id: 'col-invite', ownerSubjectId: owner.subjectId });
  const response = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-invite'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-invite'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json() as Record<string, unknown>;
  assertNoForbidden201Keys(body);
  assert.equal(body.collectionId, 'col-invite');
  assert.equal(body.role, 'editor');
  assert.equal(typeof body.inviteId, 'string');
  assert.equal(typeof body.expiresAt, 'string');
  assert.equal(typeof body.policyEtag, 'string');
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('unknown vs registered-not-member 201 JSON key sets are identical', async () => {
  const unknownHarness = createHarness();
  const ownerA = await session(unknownHarness, {
    subject: 'owner-keys-a', email: 'owner-keys-a@example.test', displayName: 'Owner A',
  });
  seedCollection(unknownHarness.state, { id: 'col-keys-a', ownerSubjectId: ownerA.subjectId });
  const unknown = await unknownHarness.app.inject({
    method: 'POST',
    url: inviteUrl('col-keys-a'),
    headers: writeHeaders(ownerA, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(unknownHarness.state, 'col-keys-a'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'viewer' },
  });

  const registeredHarness = createHarness();
  const ownerB = await session(registeredHarness, {
    subject: 'owner-keys-b', email: 'owner-keys-b@example.test', displayName: 'Owner B',
  });
  const invitee = await session(registeredHarness, {
    subject: 'invitee-keys', email: 'invitee-keys@example.test', displayName: 'Ivy Invitee',
  });
  seedCollection(registeredHarness.state, { id: 'col-keys-b', ownerSubjectId: ownerB.subjectId });
  const registered = await registeredHarness.app.inject({
    method: 'POST',
    url: inviteUrl('col-keys-b'),
    headers: writeHeaders(ownerB, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_B,
      'if-match': etagOf(registeredHarness.state, 'col-keys-b'),
    }),
    payload: { email: invitee.subjectId ? 'invitee-keys@example.test' : '', role: 'viewer' },
  });

  assert.equal(unknown.statusCode, 201);
  assert.equal(registered.statusCode, 201);
  const unknownBody = unknown.json() as Record<string, unknown>;
  const registeredBody = registered.json() as Record<string, unknown>;
  assertNoForbidden201Keys(unknownBody);
  assertNoForbidden201Keys(registeredBody);
  assert.deepEqual(Object.keys(unknownBody).sort(), Object.keys(registeredBody).sort());
  assert.equal(JSON.stringify(unknownBody).includes(UNKNOWN_EMAIL), false);
  assert.equal(JSON.stringify(registeredBody).includes('invitee-keys@example.test'), false);
});

test('already member is 409 This person already has access', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-member', email: 'owner-member@example.test', displayName: 'Owner',
  });
  const editor = await session(harness, {
    subject: 'editor-member', email: 'editor-member@example.test', displayName: 'Ed Editor',
  });
  seedCollection(harness.state, { id: 'col-member', ownerSubjectId: owner.subjectId });
  harness.state.members.push({
    collectionId: 'col-member',
    subjectId: editor.subjectId,
    role: 'editor',
    grantedAt: new Date(harness.state.now),
  });
  const response = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-member'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-member'),
    }),
    payload: { email: 'editor-member@example.test', role: 'editor' },
  });
  const error = assertProductError(response, 409, 'mutation_conflict');
  assert.equal(error.message, ALREADY_MEMBER_MESSAGE);
  assert.equal(error.message, 'This person already has access');
  assert.equal(response.payload.includes('editor-member@example.test'), false);
});

test('same email pending again is 409 An invitation is already pending', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-pending', email: 'owner-pending@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-pending', ownerSubjectId: owner.subjectId });
  const first = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-pending'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-pending'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assert.equal(first.statusCode, 201);
  const second = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-pending'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_B,
      'if-match': etagOf(harness.state, 'col-pending'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'viewer' },
  });
  const error = assertProductError(second, 409, 'mutation_conflict');
  assert.equal(error.message, INVITE_ALREADY_PENDING_MESSAGE);
  assert.equal(error.message, 'An invitation is already pending');
});

test('revoke then invite again is 201', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-revoke', email: 'owner-revoke@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-revoke', ownerSubjectId: owner.subjectId });
  const invited = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-revoke'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-revoke'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assert.equal(invited.statusCode, 201);
  const inviteId = invited.json().inviteId as string;
  const revoked = await harness.app.inject({
    method: 'DELETE',
    url: `${inviteUrl('col-revoke')}/${inviteId}`,
    headers: writeHeaders(owner, {
      'known-command-id': COMMAND_B,
      'if-match': etagOf(harness.state, 'col-revoke'),
    }),
  });
  assert.equal(revoked.statusCode, 204);
  const again = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-revoke'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_C,
      'if-match': etagOf(harness.state, 'col-revoke'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assert.equal(again.statusCode, 201);
  assertNoForbidden201Keys(again.json() as Record<string, unknown>);
});

test('viewer invite is 403 insufficient_permission', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-viewer', email: 'owner-viewer@example.test', displayName: 'Owner',
  });
  const viewer = await session(harness, {
    subject: 'viewer-invite', email: 'viewer-invite@example.test', displayName: 'Vic Viewer',
  });
  seedCollection(harness.state, { id: 'col-viewer', ownerSubjectId: owner.subjectId });
  harness.state.members.push({
    collectionId: 'col-viewer',
    subjectId: viewer.subjectId,
    role: 'viewer',
    grantedAt: new Date(harness.state.now),
  });
  const response = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-viewer'),
    headers: writeHeaders(viewer, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-viewer'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assertProductError(response, 403, 'insufficient_permission');
});

test('outsider private GET members is 404 same status/code as fake collection ID', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-private', email: 'owner-private@example.test', displayName: 'Owner',
  });
  const outsider = await session(harness, {
    subject: 'outsider-private', email: 'outsider-private@example.test', displayName: 'Outsider',
  });
  seedCollection(harness.state, {
    id: 'col-private', ownerSubjectId: owner.subjectId, visibility: 'private',
  });
  const concealed = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-private'),
    headers: { cookie: outsider.cookie },
  });
  const fake = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-does-not-exist'),
    headers: { cookie: outsider.cookie },
  });
  assert.equal(concealed.statusCode, 404);
  assert.equal(fake.statusCode, 404);
  assert.equal(concealed.json().error.code, 'resource_not_found');
  assert.equal(fake.json().error.code, 'resource_not_found');
  assert.deepEqual(
    { status: concealed.statusCode, code: concealed.json().error.code },
    { status: fake.statusCode, code: fake.json().error.code },
  );
});

test('public outsider GET members is 403', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-public', email: 'owner-public@example.test', displayName: 'Owner',
  });
  const outsider = await session(harness, {
    subject: 'outsider-public', email: 'outsider-public@example.test', displayName: 'Outsider',
  });
  seedCollection(harness.state, {
    id: 'col-public', ownerSubjectId: owner.subjectId, visibility: 'public',
  });
  const response = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-public'),
    headers: { cookie: outsider.cookie },
  });
  assertProductError(response, 403, 'insufficient_permission');
});

test('If-Match wrong is 412 and missing is 428', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-etag', email: 'owner-etag@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-etag', ownerSubjectId: owner.subjectId });
  const wrong = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-etag'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': '"stale-policy"',
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  const stale = assertProductError(wrong, 412, 'precondition_failed');
  assert.ok(stale);
  const missing = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-etag'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_B,
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assertProductError(missing, 428, 'precondition_required');
});

test('command replay returns the original 201 without a second invite', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-replay', email: 'owner-replay@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-replay', ownerSubjectId: owner.subjectId });
  const headers = writeHeaders(owner, {
    'content-type': 'application/json',
    'known-command-id': COMMAND_A,
    'if-match': etagOf(harness.state, 'col-replay'),
  });
  const payload = { email: UNKNOWN_EMAIL, role: 'editor' };
  const first = await harness.app.inject({
    method: 'POST', url: inviteUrl('col-replay'), headers, payload,
  });
  assert.equal(first.statusCode, 201);
  const firstBody = first.json();
  const pendingCount = harness.state.invites.filter((row) => row.status === 'pending').length;
  const second = await harness.app.inject({
    method: 'POST', url: inviteUrl('col-replay'), headers, payload,
  });
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.json(), firstBody);
  assert.equal(
    harness.state.invites.filter((row) => row.status === 'pending').length,
    pendingCount,
  );
});

test('CSRF missing on POST invite is 403; GET members without CSRF is 200', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-csrf', email: 'owner-csrf@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-csrf', ownerSubjectId: owner.subjectId });
  const missingCsrf = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-csrf'),
    headers: {
      cookie: owner.cookie,
      origin: ORIGIN,
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-csrf'),
    },
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assertProductError(missingCsrf, 403, 'csrf_failed');
  const listed = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-csrf'),
    headers: { cookie: owner.cookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers['cache-control'], 'private, no-store');
  const body = listed.json();
  assert.deepEqual(Object.keys(body).sort(), ['caller', 'collection', 'invites', 'members', 'page', 'policyEtag']);
  assert.equal(body.page.hasMore, false);
  assert.equal(body.page.nextCursor, null);
  assert.equal(body.caller.canManage, true);
  assert.equal(body.caller.canLeave, false);
});

test("other people's email is null on editor GET members", async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-email', email: 'owner-email@example.test', displayName: 'Ada Owner',
  });
  const editor = await session(harness, {
    subject: 'editor-email', email: 'editor-email@example.test', displayName: 'Ed Editor',
  });
  seedCollection(harness.state, { id: 'col-email', ownerSubjectId: owner.subjectId });
  harness.state.members.push({
    collectionId: 'col-email',
    subjectId: editor.subjectId,
    role: 'editor',
    grantedAt: new Date(harness.state.now),
  });
  const response = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-email'),
    headers: { cookie: editor.cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.caller.canManage, false);
  assert.equal(body.caller.canLeave, true);
  assert.deepEqual(body.invites, []);
  const ownerRow = body.members.find((row: { subjectId: string }) => row.subjectId === owner.subjectId);
  const editorRow = body.members.find((row: { subjectId: string }) => row.subjectId === editor.subjectId);
  assert.equal(ownerRow.email, null);
  assert.equal(editorRow.email, 'editor-email@example.test');
  assert.equal(editorRow.initials, 'EE');
  assert.equal(ownerRow.avatarUrl, null);
  assert.equal(editorRow.avatarUrl, null);
});

test('GET members returns a safe profile avatarUrl and fail-closes invalid values', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-avatar',
    email: 'owner-avatar@example.test',
    displayName: 'Ada Owner',
    avatarUrl: 'https://cdn.example.test/ada.png',
  });
  const editor = await session(harness, {
    subject: 'editor-avatar',
    email: 'editor-avatar@example.test',
    displayName: 'Ed Editor',
    avatarUrl: 'javascript:alert(1)',
  });
  seedCollection(harness.state, { id: 'col-avatar', ownerSubjectId: owner.subjectId });
  harness.state.members.push({
    collectionId: 'col-avatar',
    subjectId: editor.subjectId,
    role: 'editor',
    grantedAt: new Date(harness.state.now),
  });
  const response = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-avatar'),
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  const ownerRow = body.members.find((row: { subjectId: string }) => row.subjectId === owner.subjectId);
  const editorRow = body.members.find((row: { subjectId: string }) => row.subjectId === editor.subjectId);
  assert.equal(ownerRow.avatarUrl, 'https://cdn.example.test/ada.png');
  assert.equal(editorRow.avatarUrl, null);
  assert.equal(editorRow.initials, 'EE');
});

test('error strings contain no raw email', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-log', email: 'owner-log@example.test', displayName: 'Owner',
  });
  const member = await session(harness, {
    subject: 'member-log', email: 'member-log@example.test', displayName: 'Mem Member',
  });
  seedCollection(harness.state, { id: 'col-log', ownerSubjectId: owner.subjectId });
  harness.state.members.push({
    collectionId: 'col-log',
    subjectId: member.subjectId,
    role: 'editor',
    grantedAt: new Date(harness.state.now),
  });
  const response = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-log'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_D,
      'if-match': etagOf(harness.state, 'col-log'),
    }),
    payload: { email: 'member-log@example.test', role: 'viewer' },
  });
  const error = assertProductError(response, 409, 'mutation_conflict');
  assert.equal(error.message, ALREADY_MEMBER_MESSAGE);
  const serialized = `${response.payload}\n${JSON.stringify(response.json())}`;
  assert.equal(serialized.includes('member-log@example.test'), false);
  assert.equal(serialized.includes('owner-log@example.test'), false);
});

test('expired pending invite is absent from invites[]', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-expire', email: 'owner-expire@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-expire', ownerSubjectId: owner.subjectId });
  const invited = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-expire'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-expire'),
    }),
    payload: { email: UNKNOWN_EMAIL, role: 'editor' },
  });
  assert.equal(invited.statusCode, 201);
  harness.state.now = new Date(harness.state.now.getTime() + 8 * 24 * 60 * 60 * 1000);
  const listed = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-expire'),
    headers: { cookie: owner.cookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().invites, []);
});

test('accept and decline succeed without If-Match', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-accept', email: 'owner-accept@example.test', displayName: 'Owner',
  });
  const invitee = await session(harness, {
    subject: 'invitee-accept', email: 'invitee-accept@example.test', displayName: 'Ivy',
  });
  const decliner = await session(harness, {
    subject: 'invitee-decline', email: 'invitee-decline@example.test', displayName: 'Dee',
  });
  seedCollection(harness.state, { id: 'col-accept', ownerSubjectId: owner.subjectId });
  const invited = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-accept'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_A,
      'if-match': etagOf(harness.state, 'col-accept'),
    }),
    payload: { email: 'invitee-accept@example.test', role: 'editor' },
  });
  assert.equal(invited.statusCode, 201);
  const acceptId = invited.json().inviteId as string;
  const accepted = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/me/collaboration-invites/${acceptId}/accept`,
    headers: writeHeaders(invitee, { 'known-command-id': COMMAND_B }),
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().role, 'editor');

  const second = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-accept'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_C,
      'if-match': etagOf(harness.state, 'col-accept'),
    }),
    payload: { email: 'invitee-decline@example.test', role: 'viewer' },
  });
  assert.equal(second.statusCode, 201);
  const declineId = second.json().inviteId as string;
  const declined = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/me/collaboration-invites/${declineId}/decline`,
    headers: writeHeaders(decliner, { 'known-command-id': COMMAND_E }),
  });
  assert.equal(declined.statusCode, 204);
});

test('51st pending invite is 409 mutation_conflict and does not enqueue mail', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-cap', email: 'owner-cap@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-cap', ownerSubjectId: owner.subjectId });
  const expiresAt = new Date(harness.state.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  for (let index = 0; index < COLLABORATION_PENDING_INVITE_LIMIT; index += 1) {
    harness.state.invites.push({
      id: `seed-cap-${index}`,
      collectionId: 'col-cap',
      role: 'viewer',
      emailNormalized: `cap-${index}@example.test`,
      invitedSubjectId: null,
      invitedBySubjectId: owner.subjectId,
      status: 'pending',
      expiresAt,
      createdAt: harness.state.now,
      resolvedAt: null,
      acceptedSubjectId: null,
      collectionTitleSnapshot: 'Team notes',
    });
  }
  assert.equal(harness.state.deliveries.length, 0);
  const response = await harness.app.inject({
    method: 'POST',
    url: inviteUrl('col-cap'),
    headers: writeHeaders(owner, {
      'content-type': 'application/json',
      'known-command-id': COMMAND_D,
      'if-match': etagOf(harness.state, 'col-cap'),
    }),
    payload: { email: 'one-more@example.test', role: 'viewer' },
  });
  assertProductError(response, 409, 'mutation_conflict');
  assert.equal(harness.state.invites.length, COLLABORATION_PENDING_INVITE_LIMIT);
  assert.equal(harness.state.deliveries.length, 0);
});

test('a different subject with the same email cannot HTTP-accept a bound invite', async () => {
  const harness = createHarness();
  const sharedEmail = 'shared-bound@example.test';
  const owner = await session(harness, {
    subject: 'owner-bound', email: 'owner-bound@example.test', displayName: 'Owner',
  });
  const bound = await session(harness, {
    subject: 'invitee-bound', email: sharedEmail, displayName: 'Bound',
  });
  const thief = await session(harness, {
    subject: 'invitee-thief', email: 'thief-bound@example.test', displayName: 'Thief',
  });
  await harness.identityUnitOfWork.execute((ports) => ports.accounts.updateEmail(thief.accountId, sharedEmail));
  const thiefAccount = harness.state.accounts.find((row) => row.subjectId === thief.subjectId);
  assert.ok(thiefAccount);
  thiefAccount.email = sharedEmail;
  seedCollection(harness.state, { id: 'col-bound', ownerSubjectId: owner.subjectId });
  const expiresAt = new Date(harness.state.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  harness.state.invites.push({
    id: 'invite-bound-theft',
    collectionId: 'col-bound',
    role: 'editor',
    emailNormalized: sharedEmail,
    invitedSubjectId: bound.subjectId,
    invitedBySubjectId: owner.subjectId,
    status: 'pending',
    expiresAt,
    createdAt: harness.state.now,
    resolvedAt: null,
    acceptedSubjectId: null,
    collectionTitleSnapshot: 'Team notes',
  });
  const stolen = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/me/collaboration-invites/invite-bound-theft/accept',
    headers: writeHeaders(thief, { 'known-command-id': COMMAND_E }),
  });
  assertProductError(stolen, 404, 'resource_not_found');
  assert.equal(harness.state.invites[0]?.status, 'pending');
  assert.equal(harness.state.members.some((row) => row.subjectId === thief.subjectId), false);
  const accepted = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/me/collaboration-invites/invite-bound-theft/accept',
    headers: writeHeaders(bound, { 'known-command-id': COMMAND_F }),
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().role, 'editor');
});

test('members GET pages past the hard LIMIT with hasMore and nextCursor', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-page', email: 'owner-page@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-page', ownerSubjectId: owner.subjectId });
  const extra = COLLABORATION_MEMBERS_LIST_LIMIT;
  for (let index = 0; index < extra; index += 1) {
    const subjectId = `member-extra-${String(index).padStart(3, '0')}`;
    seedPrincipal(harness.state, {
      id: `acct-${subjectId}`,
      subjectId,
      email: `${subjectId}@example.test`,
      displayName: `Member ${index}`,
    });
    harness.state.members.push({
      collectionId: 'col-page',
      subjectId,
      role: 'viewer',
      grantedAt: new Date(harness.state.now.getTime() + index + 1),
    });
  }
  const first = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-page'),
    headers: { cookie: owner.cookie },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.members.length, COLLABORATION_MEMBERS_LIST_LIMIT);
  assert.equal(firstBody.page.hasMore, true);
  assert.equal(typeof firstBody.page.nextCursor, 'string');
  assert.equal(firstBody.page.returnedCount, firstBody.members.length + firstBody.invites.length);
  const second = await harness.app.inject({
    method: 'GET',
    url: `${membersUrl('col-page')}?cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.members.length, 1);
  assert.equal(secondBody.page.hasMore, false);
  assert.equal(secondBody.page.nextCursor, null);
  const subjectIds = new Set([
    ...firstBody.members.map((row: { subjectId: string }) => row.subjectId),
    ...secondBody.members.map((row: { subjectId: string }) => row.subjectId),
  ]);
  assert.equal(subjectIds.size, COLLABORATION_MEMBERS_LIST_LIMIT + 1);
});

test('members GET rejects an invalid cursor with 400 invalid_cursor', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-bad-cursor', email: 'owner-bad-cursor@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-bad-cursor', ownerSubjectId: owner.subjectId });
  const response = await harness.app.inject({
    method: 'GET',
    url: `${membersUrl('col-bad-cursor')}?cursor=not-a-cursor`,
    headers: { cookie: owner.cookie },
  });
  assertProductError(response, 400, 'invalid_cursor');
});

test('members GET does not change pending invite rows', async () => {
  const harness = createHarness();
  const owner = await session(harness, {
    subject: 'owner-ro', email: 'owner-ro@example.test', displayName: 'Owner',
  });
  seedCollection(harness.state, { id: 'col-ro', ownerSubjectId: owner.subjectId });
  const expiresAt = new Date(harness.state.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  harness.state.invites.push({
    id: 'invite-ro',
    collectionId: 'col-ro',
    role: 'viewer',
    emailNormalized: 'pending-ro@example.test',
    invitedSubjectId: null,
    invitedBySubjectId: owner.subjectId,
    status: 'pending',
    expiresAt,
    createdAt: harness.state.now,
    resolvedAt: null,
    acceptedSubjectId: null,
    collectionTitleSnapshot: 'Team notes',
  });
  const before = structuredClone(harness.state.invites);
  const response = await harness.app.inject({
    method: 'GET',
    url: membersUrl('col-ro'),
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().invites.length, 1);
  assert.deepEqual(harness.state.invites, before);
});

test('my invites GET pages past the hard LIMIT with hasMore and nextCursor', async () => {
  const harness = createHarness();
  const invitee = await session(harness, {
    subject: 'invitee-page', email: 'invitee-page@example.test', displayName: 'Invitee',
  });
  const extra = COLLABORATION_MY_INVITES_LIST_LIMIT + 1;
  const expiresAt = new Date(harness.state.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  for (let index = 0; index < extra; index += 1) {
    harness.state.invites.push({
      id: `my-inv-${String(index).padStart(3, '0')}`,
      collectionId: `col-mine-${index}`,
      role: 'viewer',
      emailNormalized: invitee.email,
      invitedSubjectId: invitee.subjectId,
      invitedBySubjectId: 'owner-other',
      status: 'pending',
      expiresAt,
      createdAt: new Date(harness.state.now.getTime() + index),
      resolvedAt: null,
      acceptedSubjectId: null,
      collectionTitleSnapshot: 'Cap',
    });
  }
  const first = await harness.app.inject({
    method: 'GET',
    url: '/api/v1/me/collaboration-invites',
    headers: { cookie: invitee.cookie },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.items.length, COLLABORATION_MY_INVITES_LIST_LIMIT);
  assert.equal(firstBody.page.hasMore, true);
  assert.equal(typeof firstBody.page.nextCursor, 'string');
  const second = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/me/collaboration-invites?cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
    headers: { cookie: invitee.cookie },
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.items.length, 1);
  assert.equal(secondBody.page.hasMore, false);
  const ids = new Set([
    ...firstBody.items.map((row: { inviteId: string }) => row.inviteId),
    ...secondBody.items.map((row: { inviteId: string }) => row.inviteId),
  ]);
  assert.equal(ids.size, extra);
});
