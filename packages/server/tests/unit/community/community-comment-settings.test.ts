import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_COMMENT_SETTINGS_SCOPE,
  COMMUNITY_COMMENT_TARGET_STALE_MESSAGE,
  COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE,
  COMMUNITY_SETTINGS_PRECONDITION_MESSAGE,
  COMMUNITY_SETTINGS_VIRTUAL_REVISION,
  COMMUNITY_STATIC_GENERATION,
  CommunityCommentError,
  communityCommentEtag,
  communityCommentSettingsCommandFingerprint,
  communityCurationEtag,
  getCommunityCommentSettings,
  parseCommunityCommentSettingsBody,
  parseCommunityCommentSettingsQuery,
  setCommunityCommentSettings,
  type CommunityCommentSettingsInput,
} from '../../../src/modules/community/index.js';
import {
  AUTHOR,
  BOOKMARK_TARGET,
  COLLECTION,
  COLLECTION_B,
  COLLECTION_IDENTITY,
  COLLECTION_TARGET,
  CURATOR,
  CURATOR_SUBJECT,
  GENERATION,
  HMAC_KEY,
  NODE,
  NOW,
  READER,
  READER_SUBJECT,
  TARGET_CREATED,
  errorCheck,
  managePorts,
  settingsQueryPorts,
  settingsQuery,
  settingsRecord,
  settingsTag,
  settingsInput,
} from './community-comment-settings-helpers.js';

/* ——— closed query parsing ——— */

test('parseCommunityCommentSettingsQuery enforces the same closed per-kind schema as the list', async () => {
  const collection = parseCommunityCommentSettingsQuery({
    kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION,
  });
  assert.deepEqual(collection, {
    kind: 'collection', id: COLLECTION,
    collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
  });
  const bookmark = parseCommunityCommentSettingsQuery({
    kind: 'bookmark', id: NODE, collectionId: COLLECTION, generation: GENERATION,
  });
  assert.equal(bookmark.collectionId, COLLECTION);
  const edition = parseCommunityCommentSettingsQuery({
    kind: 'digest_edition', id: 'ed-1', seriesId: 'series-1', generation: COMMUNITY_STATIC_GENERATION,
  });
  assert.equal(edition.seriesId, 'series-1');

  const bad: [string, Record<string, unknown>][] = [
    ['missing kind', { id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION }],
    ['missing id', { kind: 'collection', generation: COMMUNITY_STATIC_GENERATION }],
    ['missing generation', { kind: 'collection', id: COLLECTION }],
    ['bad kind', { kind: 'account', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION }],
    ['bad id', { kind: 'collection', id: 'bad id!', generation: COMMUNITY_STATIC_GENERATION }],
    ['non-static generation on collection',
      { kind: 'collection', id: COLLECTION, generation: GENERATION }],
    ['bookmark without collectionId', { kind: 'bookmark', id: NODE, generation: GENERATION }],
    ['bookmark with seriesId',
      { kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: 's', generation: GENERATION }],
    ['bookmark bad generation',
      { kind: 'bookmark', id: NODE, collectionId: COLLECTION, generation: 'bad gen!' }],
    ['collection with a parent',
      { kind: 'collection', id: COLLECTION, collectionId: COLLECTION, generation: COMMUNITY_STATIC_GENERATION }],
    ['edition without seriesId',
      { kind: 'digest_edition', id: 'ed-1', generation: COMMUNITY_STATIC_GENERATION }],
    ['unknown key',
      { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, extra: 'x' }],
    ['null is not missing',
      { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, collectionId: null }],
  ];
  for (const [name, raw] of bad) {
    assert.throws(() => parseCommunityCommentSettingsQuery(raw),
      errorCheck('invalid_query'), name);
  }
});

test('parseCommunityCommentSettingsBody enforces the closed {target, locked, reason} shape', () => {
  const parsed = parseCommunityCommentSettingsBody({
    target: { ...COLLECTION_TARGET }, locked: true, reason: '  spam wave  ',
  });
  assert.equal(parsed.locked, true);
  assert.equal(parsed.reason, 'spam wave');
  assert.deepEqual(parsed.target, COLLECTION_TARGET);

  for (const raw of [
    null, 'x', [],
    { target: { ...COLLECTION_TARGET }, locked: true }, // missing reason
    { target: { ...COLLECTION_TARGET }, reason: 'r' }, // missing locked
    { locked: true, reason: 'r' }, // missing target
    { target: { ...COLLECTION_TARGET }, locked: true, reason: 'r', extra: 1 },
    { target: 'collection', locked: true, reason: 'r' },
    { target: { ...COLLECTION_TARGET, generation: 'wrong' }, locked: true, reason: 'r' },
    { target: { ...COLLECTION_TARGET }, locked: 'true', reason: 'r' },
    { target: { ...COLLECTION_TARGET }, locked: true, reason: '' },
    { target: { ...COLLECTION_TARGET }, locked: true, reason: 'x'.repeat(1_001) },
  ]) {
    assert.throws(() => parseCommunityCommentSettingsBody(raw),
      errorCheck('invalid_request'), JSON.stringify(raw));
  }
});

/* ——— getCommunityCommentSettings ——— */

test('getCommunityCommentSettings conceals unresolved targets and stale generations', async () => {
  const missing = settingsQueryPorts({ resolved: null });
  await assert.rejects(
    () => getCommunityCommentSettings(missing, {
      viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, query: settingsQuery(),
    }), errorCheck('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE));

  // A bookmark generation that no longer matches the authority conceals the area.
  const stale = settingsQueryPorts();
  await assert.rejects(
    () => getCommunityCommentSettings(stale, {
      viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT },
      query: settingsQuery({
        kind: 'bookmark', id: NODE, collectionId: COLLECTION, generation: 'bm-gen-old',
      }),
    }), errorCheck('resource_not_found'));
});

test('getCommunityCommentSettings requires an authenticated curator', async () => {
  const ports = settingsQueryPorts();
  await assert.rejects(
    () => getCommunityCommentSettings(ports, {
      viewer: { accountId: null, subjectId: null }, query: settingsQuery(),
    }), errorCheck('insufficient_permission', COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE));
  await assert.rejects(
    () => getCommunityCommentSettings(ports, {
      viewer: { accountId: READER, subjectId: READER_SUBJECT }, query: settingsQuery(),
    }), errorCheck('insufficient_permission', COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE));
});

test('getCommunityCommentSettings serves the virtual default, then the stored row', async () => {
  const virtual = await getCommunityCommentSettings(settingsQueryPorts(), {
    viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, query: settingsQuery(),
  });
  assert.deepEqual(virtual, {
    target: COLLECTION_TARGET,
    locked: false,
    reason: null,
    revision: COMMUNITY_SETTINGS_VIRTUAL_REVISION,
    // The virtual updatedAt is the target authority's created_at.
    updatedAt: TARGET_CREATED.toISOString(),
  });

  const stored = await getCommunityCommentSettings(settingsQueryPorts({ settings: settingsRecord() }), {
    viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, query: settingsQuery(),
  });
  assert.equal(stored.locked, true);
  assert.equal(stored.reason, 'brigading');
  assert.equal(stored.revision, '2');
  assert.equal(stored.updatedAt, NOW.toISOString());

  // The stored reason survives an unlock but never reaches the wire.
  const unlocked = await getCommunityCommentSettings(
    settingsQueryPorts({ settings: settingsRecord({ locked: false, revision: 3n }) }),
    { viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, query: settingsQuery() },
  );
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.reason, null);
});

/* ——— setCommunityCommentSettings ——— */

test('setCommunityCommentSettings: invalid inputs reject before any port call', async () => {
  for (const override of [
    { actor: { principalId: '', subjectId: CURATOR_SUBJECT } },
    { target: 'collection' },
    { target: { ...COLLECTION_TARGET, generation: 'wrong' } },
    { locked: 'true' },
    { reason: '' },
    { reason: 'x'.repeat(1_001) },
    { ifMatch: 'not-an-etag' },
    { ifMatch: 'W/"weak"' },
    { commandId: 'not-a-uuid' },
  ] as const) {
    const fixture = managePorts();
    await assert.rejects(
      () => setCommunityCommentSettings(fixture.ports,
        settingsInput(override as Partial<CommunityCommentSettingsInput>)),
      errorCheck('invalid_request'),
      JSON.stringify(override));
    assert.equal(fixture.effects.accountLocks.length, 0, JSON.stringify(override));
    assert.equal(fixture.effects.settingsUpserts.length, 0);
  }
});

test('setCommunityCommentSettings: account and target re-proof precede the claim', async () => {
  const inactive = managePorts({ account: null });
  await assert.rejects(() => setCommunityCommentSettings(inactive.ports, settingsInput()),
    errorCheck('resource_not_found'));
  assert.equal(inactive.effects.targetLocks.length, 0);
  assert.equal(inactive.effects.claims.length, 0);

  const unresolved = managePorts({ resolved: null });
  await assert.rejects(() => setCommunityCommentSettings(unresolved.ports, settingsInput()),
    errorCheck('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE));
  assert.equal(unresolved.effects.claims.length, 0);
});

test('setCommunityCommentSettings: a stale supplied generation is revision_conflict after the claim', async () => {
  const stale = { ...BOOKMARK_TARGET, generation: 'bm-gen-superseded' };
  const fixture = managePorts();
  await assert.rejects(
    () => setCommunityCommentSettings(fixture.ports,
      settingsInput({ target: stale, ifMatch: settingsTag('1', BOOKMARK_TARGET) })),
    errorCheck('revision_conflict', COMMUNITY_COMMENT_TARGET_STALE_MESSAGE));
  assert.equal(fixture.effects.claims.length, 1);
  assert.equal(fixture.effects.settingsUpserts.length, 0);
});

test('setCommunityCommentSettings: only a curator may write; lock CAS-es on the virtual tag', async () => {
  const reader = managePorts();
  await assert.rejects(
    () => setCommunityCommentSettings(reader.ports,
      settingsInput({ actor: { principalId: READER, subjectId: READER_SUBJECT } })),
    errorCheck('insufficient_permission', COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE));
  assert.equal(reader.effects.settingsUpserts.length, 0);

  const fixture = managePorts();
  const result = await setCommunityCommentSettings(fixture.ports, settingsInput());
  assert.equal(result.kind, 'succeeded');
  assert.equal(fixture.effects.settingsUpserts.length, 1);
  const stored = fixture.effects.settingsUpserts[0]!;
  assert.deepEqual(stored.target, COLLECTION_IDENTITY);
  assert.equal(stored.locked, true);
  assert.equal(stored.reason, 'brigading');
  // The virtual default is revision '1'; the first stored row is 2.
  assert.equal(stored.revision, 2n);
  assert.equal(stored.updatedByAccountId, CURATOR);
  if (result.kind === 'succeeded') {
    assert.equal(result.value.locked, true);
    assert.equal(result.value.reason, 'brigading');
    assert.equal(result.value.revision, '2');
    assert.deepEqual(result.value.target, COLLECTION_TARGET);
  }
  assert.equal(fixture.effects.commentUpdates, 0);
  const audit = fixture.effects.audits[0]!;
  assert.equal(audit.eventType, 'community.comment_settings_updated');
  assert.equal(audit.principalId, CURATOR);
  assert.equal(audit.details.targetKind, 'collection');
  assert.equal(audit.details.targetId, COLLECTION);
  assert.equal(audit.details.locked, true);
  assert.equal(audit.details.reason, 'brigading');
  assert.equal(audit.details.revision, '2');
  assert.equal(fixture.effects.completions[0]!.stableHeaders.etag, settingsTag(2n));
  assert.equal(fixture.effects.completions[0]!.targetIdentity, `comment-settings:collection:${COLLECTION}`);
  assert.equal(fixture.effects.claims[0]!.commandScope, COMMUNITY_COMMENT_SETTINGS_SCOPE);
  assert.equal(COMMUNITY_COMMENT_SETTINGS_SCOPE, 'community:comment-settings:v1');
});

test('setCommunityCommentSettings: unlock increments the stored revision; stale and foreign tags are 412', async () => {
  // The first stored revision is 2; the next write increments to 3.
  const existing = settingsRecord({ locked: true, revision: 2n });
  const fixture = managePorts({ settings: existing });
  const result = await setCommunityCommentSettings(fixture.ports,
    settingsInput({ locked: false, reason: 'appeal granted', ifMatch: settingsTag(2n) }));
  assert.equal(result.kind, 'succeeded');
  assert.equal(fixture.effects.settingsUpserts[0]!.revision, 3n);
  assert.equal(fixture.effects.settingsUpserts[0]!.locked, false);
  assert.equal(fixture.effects.settingsUpserts[0]!.reason, 'appeal granted');
  if (result.kind === 'succeeded') {
    assert.equal(result.value.locked, false);
    assert.equal(result.value.reason, null);
    assert.equal(result.value.revision, '3');
  }

  // A stale settings tag is refused with the CURRENT settings tag attached.
  const stale = managePorts({ settings: existing });
  await assert.rejects(
    () => setCommunityCommentSettings(stale.ports,
      settingsInput({ ifMatch: settingsTag(COMMUNITY_SETTINGS_VIRTUAL_REVISION) })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.message === COMMUNITY_SETTINGS_PRECONDITION_MESSAGE
      && error.currentEtag === settingsTag(2n));
  assert.equal(stale.effects.settingsUpserts.length, 0);

  // Comment and curation ETags are foreign authorities on this endpoint.
  const foreignComment = managePorts({ settings: existing });
  await assert.rejects(
    () => setCommunityCommentSettings(foreignComment.ports,
      settingsInput({ ifMatch: communityCommentEtag({ id: 'comment-1', revision: '1' }, HMAC_KEY) })),
    errorCheck('precondition_failed'));

  const foreignCuration = managePorts({ settings: existing });
  await assert.rejects(
    () => setCommunityCommentSettings(foreignCuration.ports,
      settingsInput({ ifMatch: communityCurationEtag({ commentId: 'comment-1', revision: '1' }, HMAC_KEY) })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.currentEtag === settingsTag(2n));
});

test('setCommunityCommentSettings: non-claimed receipt kinds map through without writes', async () => {
  for (const [claim, expected] of [
    [{ kind: 'reused' as const }, { kind: 'reused' }],
    [{ kind: 'in_progress' as const, retryAfterSeconds: 5 }, { kind: 'in_progress', retryAfterSeconds: 5 }],
    [{ kind: 'expired' as const, resultDigest: 'd' }, { kind: 'expired', resultDigest: 'd' }],
  ] as const) {
    const fixture = managePorts({ claim });
    assert.deepEqual(await setCommunityCommentSettings(fixture.ports, settingsInput()), expected);
    assert.equal(fixture.effects.settingsUpserts.length, 0);
  }
});

test('the settings fingerprint binds actor, target, locked flag and reason', async () => {
  const base = communityCommentSettingsCommandFingerprint({
    actorPrincipalId: CURATOR, target: COLLECTION_TARGET, locked: true, reason: 'r',
  });
  for (const variant of [
    { actorPrincipalId: AUTHOR },
    { target: { ...COLLECTION_TARGET, id: COLLECTION_B } },
    { locked: false },
    { reason: 'other' },
  ]) {
    assert.notEqual(base, communityCommentSettingsCommandFingerprint({
      actorPrincipalId: CURATOR, target: COLLECTION_TARGET, locked: true, reason: 'r', ...variant,
    }), JSON.stringify(variant));
  }
});
