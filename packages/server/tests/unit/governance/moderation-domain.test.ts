import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMENTS_IMPLEMENTED,
  GOVERNANCE_EVIDENCE_MAX_BYTES,
  GOVERNANCE_EVIDENCE_RETENTION_DAYS,
  captureEvidence,
  fillGovernancePage,
  hasOfficialRead,
  isOpenModerationStatus,
  myCaseFrom,
  officialCaseFrom,
  parseGovernanceTarget,
  parseReportInput,
  targetFingerprint,
  GovernanceModerationError,
} from '../../../src/modules/governance/domain/moderation.js';

test('comment targets are valid once comments are implemented', () => {
  assert.equal(COMMENTS_IMPLEMENTED, true);
  assert.deepEqual(
    parseReportInput({
      target: { kind: 'comment', id: 'cmt_1' },
      category: 'spam',
      description: 'this is spam',
    }),
    {
      target: { kind: 'comment', id: 'cmt_1' },
      category: 'spam',
      description: 'this is spam',
    },
  );
});

test('ReportInput rejects unknown keys, null, and invalid enums', () => {
  const valid = {
    target: { kind: 'collection', id: 'col_1' },
    category: 'spam',
    description: 'unsolicited ads',
  };
  assert.deepEqual(parseReportInput(valid), {
    target: { kind: 'collection', id: 'col_1' },
    category: 'spam',
    description: 'unsolicited ads',
  });
  assert.throws(() => parseReportInput({ ...valid, evidenceUrl: 'https://evil.test' }));
  assert.throws(() => parseReportInput({ ...valid, category: 'abuse' }));
  assert.throws(() => parseReportInput({ ...valid, description: null }));
  assert.throws(() => parseReportInput({ target: valid.target, category: 'spam' }));
});

test('bookmark and edition targets require parent locators; extra parent keys fail', () => {
  assert.deepEqual(
    parseGovernanceTarget({ kind: 'bookmark', id: 'node_1', collectionId: 'col_1' }),
    { kind: 'bookmark', id: 'node_1', collectionId: 'col_1' },
  );
  assert.throws(() => parseGovernanceTarget({ kind: 'bookmark', id: 'node_1' }));
  assert.throws(() => parseGovernanceTarget({ kind: 'collection', id: 'col_1', collectionId: 'x' }));
  assert.deepEqual(
    parseGovernanceTarget({ kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' }),
    { kind: 'digest_edition', id: 'ed_1', seriesId: 'ser_1' },
  );
});

test('description is trimmed and NFC-normalized before length checks', () => {
  const nfc = 'e\u0301';
  const parsed = parseReportInput({
    target: { kind: 'account', id: 'acc_1' },
    category: 'harassment',
    description: `  ${nfc}  `,
  });
  assert.equal(parsed.description, nfc.normalize('NFC'));
});

test('open cases are submitted or in_review only', () => {
  assert.equal(isOpenModerationStatus('submitted'), true);
  assert.equal(isOpenModerationStatus('in_review'), true);
  assert.equal(isOpenModerationStatus('resolved'), false);
  assert.equal(isOpenModerationStatus('dismissed'), false);
});

test('reviewer and moderator both have official read', () => {
  assert.equal(hasOfficialRead(new Set(['reviewer'])), true);
  assert.equal(hasOfficialRead(new Set(['moderator'])), true);
  assert.equal(hasOfficialRead(new Set()), false);
});

test('MyCase omits official-only fields', () => {
  const mine = myCaseFrom({
    id: 'case_1',
    target: { kind: 'collection', id: 'col_1' },
    category: 'spam',
    status: 'submitted',
    publicResolution: null,
    revision: '1',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(mine).sort(), [
    'category', 'createdAt', 'id', 'publicResolution', 'revision', 'status', 'target', 'updatedAt',
  ]);
  const official = officialCaseFrom({
    case: mine,
    reporterAccountId: 'acc_1',
    description: 'ads',
    assignedToAccountId: null,
    evidenceIds: ['ev_1'],
    actionIds: ['act_1'],
    internalNote: 'queue',
  });
  assert.deepEqual(Object.keys(official).sort(), [
    'actionIds', 'assignedToAccountId', 'case', 'description', 'evidenceIds', 'internalNote', 'reporterAccountId',
  ]);
});

test('evidence truncates at a UTF-8 character boundary and marks truncated', () => {
  assert.equal(GOVERNANCE_EVIDENCE_RETENTION_DAYS, 365);
  const snowman = '☃';
  const oversize = `${'a'.repeat(GOVERNANCE_EVIDENCE_MAX_BYTES)}${snowman}`;
  const captured = captureEvidence({
    target: { kind: 'collection', id: 'col_1' },
    capturedAt: '2026-09-15T00:00:00.000Z',
    sourceRevision: 'rev_1',
    title: 'Notes',
    text: oversize,
    sourceUrl: null,
  }, { id: 'ev_1', caseId: 'case_1' });
  assert.equal(captured.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(captured), 'utf8') <= GOVERNANCE_EVIDENCE_MAX_BYTES);
  assert.notEqual(captured.text?.endsWith('\uFFFD'), true);
  assert.notEqual(captured.text, oversize);
});

test('target fingerprints distinguish parent-scoped kinds', () => {
  assert.equal(
    targetFingerprint({ kind: 'bookmark', id: 'n1', collectionId: 'c1' }),
    'bookmark:c1:n1',
  );
  assert.notEqual(
    targetFingerprint({ kind: 'bookmark', id: 'n1', collectionId: 'c1' }),
    targetFingerprint({ kind: 'bookmark', id: 'n1', collectionId: 'c2' }),
  );
});

test('byte-limited pages still return nextCursor for the first unconsumed item', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ id: `item_${index}`, blob: 'x'.repeat(12_000) }));
  const page = fillGovernancePage(items, 20, (item) => `cursor-${item.id}`);
  assert.ok(page.items.length < items.length);
  assert.ok(page.items.length >= 1);
  assert.equal(page.nextCursor, `cursor-${items[page.items.length]!.id}`);
  assert.ok(Buffer.byteLength(JSON.stringify({
    items: page.items,
    nextCursor: page.nextCursor,
  }), 'utf8') <= 65_536);
});
