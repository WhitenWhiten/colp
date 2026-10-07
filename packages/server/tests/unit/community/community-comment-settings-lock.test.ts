import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_LOCKED_MESSAGE,
  createCommunityComment,
  setCommunityCommentSettings,
  type CommunityCommentSettingsRecord,
  type CommunityTarget,
} from '../../../src/modules/community/index.js';
import {
  AUTHOR,
  AUTHOR_SUBJECT,
  COLLECTION_B,
  COLLECTION_IDENTITY,
  COLLECTION_TARGET,
  COMMAND_ID,
  commandPorts,
  errorCheck,
  identityKey,
  managePorts,
  settingsInput,
  settingsRecord,
  settingsTag,
} from './community-comment-settings-helpers.js';

/* ——— the lock rejects comment writes; per-target rows are independent ——— */

test('a locked comment area rejects new roots and replies for everyone', async () => {
  const locked = settingsRecord({ locked: true });
  for (const replyToId of [null, 'comment-parent'] as const) {
    const fixture = commandPorts({ settings: locked });
    await assert.rejects(
      () => createCommunityComment(fixture.ports, {
        actor: { principalId: AUTHOR, subjectId: AUTHOR_SUBJECT },
        target: { ...COLLECTION_TARGET },
        body: 'hi',
        replyToId,
        commandId: COMMAND_ID,
      }),
      errorCheck('insufficient_permission', COMMUNITY_COMMENT_LOCKED_MESSAGE));
    assert.equal(fixture.inserted.length, 0);
    // The lock check precedes the reply-parent lock: no parent row was touched.
    assert.equal(fixture.parentLocks.length, 0);
  }
  // An unlocked row (locked=false) and an absent row both admit writes.
  for (const settings of [settingsRecord({ locked: false }), null]) {
    const fixture = commandPorts({ settings });
    const outcome = await createCommunityComment(fixture.ports, {
      actor: { principalId: AUTHOR, subjectId: AUTHOR_SUBJECT },
      target: { ...COLLECTION_TARGET },
      body: 'hi',
      replyToId: null,
      commandId: COMMAND_ID,
    });
    assert.equal(outcome.kind, 'succeeded');
    assert.equal(fixture.inserted.length, 1);
  }
});

test('unlocking one target leaves overlapping locks on other targets in place', async () => {
  // Two independent settings rows keyed by the full target identity.
  const store = new Map<string, CommunityCommentSettingsRecord>([
    [identityKey(COLLECTION_IDENTITY), settingsRecord({ locked: true, revision: 2n })],
    [identityKey({ ...COLLECTION_IDENTITY, id: COLLECTION_B }),
      settingsRecord({
        target: { ...COLLECTION_IDENTITY, id: COLLECTION_B }, locked: true, revision: 2n,
      })],
  ]);
  const manage = managePorts({ settingsStore: store });

  // Unlock collection A; the settings row of collection B is untouched.
  const targetB: CommunityTarget = { ...COLLECTION_TARGET, id: COLLECTION_B };
  const unlockA = await setCommunityCommentSettings(manage.ports, settingsInput({
    locked: false, reason: 'wave over', ifMatch: settingsTag(2n),
  }));
  assert.equal(unlockA.kind, 'succeeded');
  assert.equal(store.get(identityKey(COLLECTION_IDENTITY))!.locked, false);
  assert.equal(store.get(identityKey({ ...COLLECTION_IDENTITY, id: COLLECTION_B }))!.locked, true,
    'one revocation never clears a second, independent settings row');

  // Collection B still rejects writes; collection A admits them again.
  const stillLocked = commandPorts({ settingsFind: (identity) => store.get(identityKey(identity)) ?? null });
  await assert.rejects(
    () => createCommunityComment(stillLocked.ports, {
      actor: { principalId: AUTHOR, subjectId: AUTHOR_SUBJECT },
      target: targetB,
      body: 'hi',
      replyToId: null,
      commandId: COMMAND_ID,
    }), errorCheck('insufficient_permission', COMMUNITY_COMMENT_LOCKED_MESSAGE));

  const reopened = commandPorts({ settingsFind: (identity) => store.get(identityKey(identity)) ?? null });
  const outcome = await createCommunityComment(reopened.ports, {
    actor: { principalId: AUTHOR, subjectId: AUTHOR_SUBJECT },
    target: { ...COLLECTION_TARGET },
    body: 'hi',
    replyToId: null,
    commandId: COMMAND_ID,
  });
  assert.equal(outcome.kind, 'succeeded');
});
