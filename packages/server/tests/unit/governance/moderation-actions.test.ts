import assert from 'node:assert/strict';
import { test } from 'vitest';
import { GovernanceModerationError } from '../../../src/modules/governance/domain/moderation.js';
import {
  applyCaseStatusTransition,
  composeAccountDecision,
  composeCollectionDecision,
  hasOfficialWrite,
  isEnabledActionPair,
  parseActionInput,
  parseCasePatch,
  parseRevokeReason,
  requireClosingResolution,
  targetsMatch,
  toAction,
  toMyAction,
} from '../../../src/modules/governance/domain/moderation-actions.js';

test('only unrevoked actions compose hide_public and delist independently', () => {
  const hide = { action: 'hide_public', state: 'active' };
  const delist = { action: 'delist', state: 'active' };
  const revokedHide = { action: 'hide_public', state: 'revoked' };
  assert.deepEqual(composeCollectionDecision([hide]), { hidePublic: true, delisted: true });
  assert.deepEqual(composeCollectionDecision([delist]), { hidePublic: false, delisted: true });
  assert.deepEqual(composeCollectionDecision([hide, delist]), { hidePublic: true, delisted: true });
  assert.deepEqual(composeCollectionDecision([revokedHide, delist]), { hidePublic: false, delisted: true });
  assert.deepEqual(composeCollectionDecision([revokedHide]), { hidePublic: false, delisted: false });
});

test('revoking one hide_public leaves a sibling hide_public in force', () => {
  const composed = composeCollectionDecision([
    { action: 'hide_public', state: 'revoked' },
    { action: 'hide_public', state: 'active' },
    { action: 'delist', state: 'active' },
  ]);
  assert.equal(composed.hidePublic, true);
  assert.equal(composed.delisted, true);
});

test('CG-06 enables collection, bookmark, digest hide/delist and account restrict', () => {
  const collection = { kind: 'collection' as const, id: 'col_1' };
  const bookmark = { kind: 'bookmark' as const, id: 'n1', collectionId: 'col_1' };
  const series = { kind: 'digest_series' as const, id: 'ser_1' };
  const edition = { kind: 'digest_edition' as const, id: 'ed_1', seriesId: 'ser_1' };
  assert.equal(isEnabledActionPair(collection, 'delist'), true);
  assert.equal(isEnabledActionPair(collection, 'hide_public'), true);
  assert.equal(isEnabledActionPair(collection, 'lock_comments'), true);
  assert.equal(isEnabledActionPair(bookmark, 'hide_public'), true);
  assert.equal(isEnabledActionPair(bookmark, 'delist'), true);
  assert.equal(isEnabledActionPair(bookmark, 'lock_comments'), true);
  assert.equal(isEnabledActionPair(series, 'delist'), true);
  assert.equal(isEnabledActionPair(series, 'hide_public'), true);
  assert.equal(isEnabledActionPair(series, 'lock_comments'), true);
  assert.equal(isEnabledActionPair(edition, 'hide_public'), true);
  assert.equal(isEnabledActionPair(edition, 'delist'), true);
  assert.equal(isEnabledActionPair({ kind: 'account', id: 'acc_1' }, 'restrict_interaction'), true);
  assert.equal(isEnabledActionPair({ kind: 'account', id: 'acc_1' }, 'restrict_publication'), true);
  assert.equal(isEnabledActionPair({ kind: 'account', id: 'acc_1' }, 'hide_public'), false);
  assert.equal(isEnabledActionPair({ kind: 'comment', id: 'cmt_1' }, 'hide_comment'), true);
  assert.equal(isEnabledActionPair(edition, 'lock_comments'), true);
});

test('only unrevoked account actions compose restrict_interaction and restrict_publication independently', () => {
  const interaction = { action: 'restrict_interaction', state: 'active' };
  const publication = { action: 'restrict_publication', state: 'active' };
  const revoked = { action: 'restrict_publication', state: 'revoked' };
  assert.deepEqual(composeAccountDecision([interaction]), {
    restrictInteraction: true, restrictPublication: false,
  });
  assert.deepEqual(composeAccountDecision([publication]), {
    restrictInteraction: false, restrictPublication: true,
  });
  assert.deepEqual(composeAccountDecision([interaction, publication]), {
    restrictInteraction: true, restrictPublication: true,
  });
  assert.deepEqual(composeAccountDecision([revoked, interaction]), {
    restrictInteraction: true, restrictPublication: false,
  });
  assert.deepEqual(composeAccountDecision([revoked]), {
    restrictInteraction: false, restrictPublication: false,
  });
});

test('case target must match action target including bookmark parents', () => {
  assert.equal(
    targetsMatch({ kind: 'collection', id: 'col_1' }, { kind: 'collection', id: 'col_1' }),
    true,
  );
  assert.equal(
    targetsMatch({ kind: 'collection', id: 'col_1' }, { kind: 'collection', id: 'col_2' }),
    false,
  );
  assert.equal(
    targetsMatch(
      { kind: 'bookmark', id: 'n1', collectionId: 'col_1' },
      { kind: 'bookmark', id: 'n1', collectionId: 'col_2' },
    ),
    false,
  );
});

test('ActionInput rejects unknown keys and invalid pairs', () => {
  const valid = {
    caseId: 'case_1',
    target: { kind: 'collection', id: 'col_1' },
    action: 'delist',
    reason: 'spam network',
  };
  assert.deepEqual(parseActionInput(valid), valid);
  assert.throws(
    () => parseActionInput({ ...valid, extra: true }),
    (error: unknown) => error instanceof GovernanceModerationError && error.code === 'invalid_request',
  );
  assert.throws(() => parseActionInput({ ...valid, action: 'restrict_interaction' }));
  assert.deepEqual(parseActionInput({
    caseId: 'case_1',
    target: { kind: 'comment', id: 'cmt_1' },
    action: 'hide_comment',
    reason: 'abuse',
  }).action, 'hide_comment');
  assert.deepEqual(parseActionInput({
    ...valid,
    target: { kind: 'collection', id: 'col_1' },
    action: 'lock_comments',
  }).action, 'lock_comments');
});

test('bookmark ActionInput requires collectionId and is CG-04-enabled for hide/delist', () => {
  const bookmark = parseActionInput({
    caseId: 'case_1',
    target: { kind: 'bookmark', id: 'n1', collectionId: 'col_1' },
    action: 'hide_public',
    reason: 'phishing',
  });
  assert.deepEqual(bookmark.target, { kind: 'bookmark', id: 'n1', collectionId: 'col_1' });
  assert.equal(isEnabledActionPair(bookmark.target, bookmark.action), true);
  assert.throws(() => parseActionInput({
    caseId: 'case_1',
    target: { kind: 'bookmark', id: 'n1' },
    action: 'hide_public',
    reason: 'phishing',
  }));
  const account = parseActionInput({
    caseId: 'case_1',
    target: { kind: 'account', id: 'acc_1' },
    action: 'restrict_publication',
    reason: 'spam farm',
  });
  assert.equal(isEnabledActionPair(account.target, account.action), true);
  assert.throws(() => parseActionInput({
    caseId: 'case_1',
    target: { kind: 'account', id: 'acc_1' },
    action: 'hide_public',
    reason: 'account hide is invalid',
  }));
  const series = parseActionInput({
    caseId: 'case_1',
    target: { kind: 'digest_series', id: 'ser_1' },
    action: 'delist',
    reason: 'spam digest',
  });
  assert.equal(isEnabledActionPair(series.target, series.action), true);
  const edition = parseActionInput({
    caseId: 'case_1',
    target: { kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' },
    action: 'hide_public',
    reason: 'withdrawn issue',
  });
  assert.deepEqual(edition.target, { kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' });
  assert.throws(() => parseActionInput({
    caseId: 'case_1',
    target: { kind: 'digest_edition', id: 'ed_1' },
    action: 'hide_public',
    reason: 'missing series',
  }));
});

test('CasePatch requires a field, rejects submitted, and enforces submitted→in_review→resolved/dismissed', () => {
  assert.throws(() => parseCasePatch({}));
  assert.throws(() => parseCasePatch({ status: 'submitted' }));
  assert.throws(() => parseCasePatch({ extra: true, status: 'in_review' }));
  assert.deepEqual(parseCasePatch({ status: 'in_review' }), { status: 'in_review' });
  assert.deepEqual(parseCasePatch({ assignedToAccountId: null }), { assignedToAccountId: null });
  assert.equal(applyCaseStatusTransition('submitted', 'in_review'), 'in_review');
  assert.equal(applyCaseStatusTransition('in_review', 'resolved'), 'resolved');
  assert.equal(applyCaseStatusTransition('in_review', 'dismissed'), 'dismissed');
  assert.throws(() => applyCaseStatusTransition('submitted', 'resolved'));
  assert.throws(() => applyCaseStatusTransition('resolved', 'in_review'));
  assert.throws(() => applyCaseStatusTransition('dismissed', 'resolved'));
  assert.throws(() => requireClosingResolution('resolved', null));
  requireClosingResolution('resolved', 'removed from Explore');
  requireClosingResolution('in_review', null);
});

test('revoke body is a closed reason object', () => {
  assert.equal(parseRevokeReason({ reason: 'false positive' }), 'false positive');
  assert.throws(() => parseRevokeReason({ reason: 'ok', extra: true }));
  assert.throws(() => parseRevokeReason({}));
});

test('MyAction omits actor, case, reporter, and evidence fields', () => {
  const action = toAction({
    id: 'act_1',
    caseId: 'case_1',
    target: { kind: 'collection', id: 'col_1' },
    action: 'hide_public',
    reason: 'illegal content',
    actorAccountId: 'mod_1',
    state: 'active',
    revision: '1',
    createdAt: '2026-09-15T00:00:00.000Z',
    revokedAt: null,
    revokeReason: null,
  });
  assert.deepEqual(Object.keys(action).sort(), [
    'action', 'actorAccountId', 'caseId', 'createdAt', 'id', 'reason', 'revision',
    'revokeReason', 'revokedAt', 'state', 'target',
  ]);
  const mine = toMyAction(action);
  assert.deepEqual(Object.keys(mine).sort(), [
    'action', 'createdAt', 'id', 'reason', 'revision', 'revokeReason', 'revokedAt', 'state', 'target',
  ]);
  assert.equal(Object.hasOwn(mine, 'actorAccountId'), false);
  assert.equal(Object.hasOwn(mine, 'caseId'), false);
});

test('only moderator can write; reviewer cannot', () => {
  assert.equal(hasOfficialWrite(new Set(['moderator'])), true);
  assert.equal(hasOfficialWrite(new Set(['reviewer', 'moderator'])), true);
  assert.equal(hasOfficialWrite(new Set(['reviewer'])), false);
  assert.equal(hasOfficialWrite(new Set()), false);
});
