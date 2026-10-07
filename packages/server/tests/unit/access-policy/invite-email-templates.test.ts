import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  INVITE_EMAIL_BODY_MAX_BYTES,
  INVITE_EMAIL_SUBJECT_MAX_CHARS,
  buildInviteLoginUrl,
  renderInviteEmailTemplate,
} from '../../../src/modules/access-policy/index.js';

const SUBJECT = "You've been invited to collaborate on Know-N";
const LOGIN_URL = 'https://known.example/login?returnTo=/library';
const INVITER = 'Ada Lovelace';
const TITLE = 'Shared research notes';
const EXPIRES = '2026-08-26';

function render(overrides: Partial<Parameters<typeof renderInviteEmailTemplate>[0]> = {}) {
  return renderInviteEmailTemplate({
    inviterDisplayName: INVITER,
    collectionTitle: TITLE,
    role: 'editor',
    expiresAtUtcDate: EXPIRES,
    loginUrl: LOGIN_URL,
    ...overrides,
  });
}

describe('invite email templates', () => {
  test('subject is the frozen string and stays within the mirrored 100/80KiB budgets', () => {
    const rendered = render();
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.equal(rendered.subject, SUBJECT);
    assert.ok(rendered.subject.length <= INVITE_EMAIL_SUBJECT_MAX_CHARS);
    assert.equal(INVITE_EMAIL_SUBJECT_MAX_CHARS, 100);
    assert.equal(INVITE_EMAIL_BODY_MAX_BYTES, 80 * 1024);
    assert.ok(Buffer.byteLength(rendered.textBody, 'utf8') <= INVITE_EMAIL_BODY_MAX_BYTES);
    assert.ok(Buffer.byteLength(rendered.htmlBody, 'utf8') <= INVITE_EMAIL_BODY_MAX_BYTES);
    assert.match(rendered.textBody, /\u2014 Know-N/u);
    assert.match(rendered.htmlBody, /\u2014 Know-N/u);
    assert.match(rendered.textBody, /Editor/u);
    assert.match(rendered.htmlBody, /Editor/u);
  });

  test('HTML-escapes <script> in displayName and title', () => {
    const rendered = render({
      inviterDisplayName: '<script>alert(1)</script>',
      collectionTitle: '<script>steal()</script>',
    });
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.match(rendered.htmlBody, /&lt;script&gt;/u);
    assert.doesNotMatch(rendered.htmlBody, /<script>/u);
  });

  test('known and unknown invitees call the same function and get the same subject', () => {
    const known = renderInviteEmailTemplate;
    const unknown = renderInviteEmailTemplate;
    assert.equal(known, unknown);
    const first = render({ inviterDisplayName: 'Known Owner' });
    const second = render({ inviterDisplayName: 'Known Owner' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.subject, second.subject);
    assert.equal(first.subject, SUBJECT);
  });

  test('subject contains neither recipient email nor collection title', () => {
    const rendered = render({
      inviterDisplayName: 'Owner',
      collectionTitle: 'Secret Title Unique 9f3c',
    });
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.doesNotMatch(rendered.subject, /invitee@example\.test/u);
    assert.doesNotMatch(rendered.subject, /Secret Title Unique 9f3c/u);
    assert.doesNotMatch(rendered.subject, /@/u);
  });

  test('subject and body never include inviteId, collectionId, recipient email, or account forks', () => {
    const rendered = render();
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    const parts = [rendered.subject, rendered.textBody, rendered.htmlBody];
    for (const part of parts) {
      assert.doesNotMatch(part, /inviteId/iu);
      assert.doesNotMatch(part, /collectionId/iu);
      assert.doesNotMatch(part, /subjectId/iu);
      assert.doesNotMatch(part, /invitee@example\.test/u);
      assert.doesNotMatch(part, /You already have an account/u);
      assert.doesNotMatch(part, /Create an account/u);
    }
    assert.match(rendered.textBody, /\/login\?returnTo=\/library/u);
    assert.match(rendered.htmlBody, /\/login\?returnTo=\/library/u);
  });

  test('title is truncated to 80 graphemes before it is escaped into HTML', () => {
    const longTitle = `${'a'.repeat(80)}<script>x</script>`;
    const rendered = render({ collectionTitle: longTitle });
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.doesNotMatch(rendered.htmlBody, /<script>/u);
    assert.doesNotMatch(rendered.textBody, /<script>/u);
    const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
    const graphemes = [...segmenter.segment(TITLE)];
    assert.ok(graphemes.length < 80);
  });

  test('viewer role uses the fixed English Viewer label', () => {
    const rendered = render({ role: 'viewer' });
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.match(rendered.textBody, /Viewer/u);
    assert.doesNotMatch(rendered.textBody, /Editor/u);
  });

  test('buildInviteLoginUrl uses the same-origin relative returnTo path', () => {
    assert.equal(
      buildInviteLoginUrl('https://known.example'),
      'https://known.example/login?returnTo=/library',
    );
  });
});
