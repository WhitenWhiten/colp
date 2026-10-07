/**
 * P4A-P08 evidence active-content media-declaration contract suite.
 *
 * A real-R2 p08 evidence run failed deterministically 3 times with
 * `verification_not_converged:stored_private:expired:quarantined:media_mismatch`:
 * the three active-content objects (html/svg/pdf-polyglot) were uploaded with
 * `mediaType: 'image/png'` (L701-706 of the evidence CLI), while the
 * production verification route sniffs the REAL bytes to text/html /
 * image/svg+xml / pdf-polyglot (suspicious), and
 * `mediaMismatch('image/png', suspicious & !polyglot)` is TRUE because
 * `image/png` is in the production SAFE allowlist — the declaration was a
 * false cleanliness claim, so the blob was quarantined and expired before the
 * final re-read. The production policy was CORRECT; the evidence fixture
 * declaration was wrong.
 *
 * This suite pins the fix at BOTH levels (failure-detail static-source-pin
 * pattern):
 *   (a) the evidence CLI's active-content uploads declare ONE shared
 *       exported constant `P08_ACTIVE_CONTENT_MEDIA_TYPE` = `'text/plain'`
 *       for exactly the three kinds html/svg/polyglot — `text/plain` is the
 *       unique member of the product allowed-media set that is NOT in the
 *       verification SAFE allowlist, so the issue/complete routes accept it
 *       (422 media_not_allowed otherwise — `application/octet-stream` is
 *       rejected) while the production `mediaMismatch` never quarantines it
 *       (unknown/non-SAFE claims never mismatch, the I11/I16 browser-object
 *       precedent — delivery still degrades to forced download);
 *   (b) the PRODUCTION `mediaMismatch` (modules/attachments/verify-generation)
 *       never quarantines a text/plain declaration, and the REAL
 *       active-content fixture bytes really sniff to suspicious/polyglot —
 *       with a NEGATIVE CONTROL proving the pre-fix `image/png` declaration
 *       WOULD quarantine the same bytes (the test is not vacuous).
 *
 * Everything is asserted against the REAL evidence CLI module and the REAL
 * production verification module; no copy of the policy exists in the test.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mediaMismatch, sniffMime, ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST } from '../../../src/modules/attachments/index.js';
import {
  P08_ACTIVE_CONTENT_KINDS,
  P08_ACTIVE_CONTENT_MEDIA_TYPE,
} from '../../../scripts/phase4a-p08-evidence.js';
import {
  activeHtmlBytes,
  polyglotPdfBytes,
  svgBytes,
} from '../../support/phase4a-i11-test-helpers.js';

/** The production SAFE allowlist from verify-generation (closed set, pinned). */
const PRODUCTION_SAFE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif'] as const;

test('the p08 evidence active-content uploads declare ONE shared allowed-but-not-SAFE constant', () => {
  // text/plain is one of the two product allowed-media members outside the
  // verification SAFE allowlist (image/webp, text/plain): a declaration the
  // production issue/complete routes accept that never quarantines suspicious
  // or polyglot bytes and never makes a SAFE cleanliness claim. It is the
  // text-channel choice for these html/svg/polyglot fixtures.
  assert.equal(
    P08_ACTIVE_CONTENT_MEDIA_TYPE,
    'text/plain',
    'the active-content declaration must be the allowed-but-not-SAFE claim (text/plain), never a SAFE type',
  );
  // The declaration must be acceptable to the production issue/complete
  // routes (they answer 422 media_not_allowed otherwise). In particular
  // application/octet-stream is rejected by ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST.
  assert.ok(
    ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST.includes(P08_ACTIVE_CONTENT_MEDIA_TYPE),
    `the declaration ${P08_ACTIVE_CONTENT_MEDIA_TYPE} must be inside the product allowed-media set`,
  );
  // The three active-content object kinds the upload loop stores: html, svg,
  // pdf-polyglot. A fourth kind or a renamed kind breaks the shape pin.
  assert.deepEqual([...P08_ACTIVE_CONTENT_KINDS], ['html', 'svg', 'polyglot']);
});

test('the declaration is inside the product allowed-media set but outside the SAFE allowlist', () => {
  // Fail-closed: an allowlisted declaration (e.g. image/png) on bytes that
  // sniff suspicious is a media_mismatch -> quarantine on a real run. The
  // test must fail if the constant ever drifts onto the SAFE allowlist. The
  // product allowed-media set has exactly two members OUTSIDE the SAFE
  // allowlist (image/webp, text/plain) — the only declarations the product
  // flow accepts that never quarantine suspicious/polyglot bytes. text/plain
  // is the text-channel choice for these html/svg/polyglot fixtures.
  const nonSafeAllowed = ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST.filter(
    (media) => !PRODUCTION_SAFE_TYPES.includes(media as (typeof PRODUCTION_SAFE_TYPES)[number]),
  );
  assert.deepEqual(
    nonSafeAllowed,
    ['image/webp', 'text/plain'],
    'the flow-accepted declarations outside the SAFE allowlist must stay exactly image/webp and text/plain',
  );
  assert.equal(
    PRODUCTION_SAFE_TYPES.includes(P08_ACTIVE_CONTENT_MEDIA_TYPE as (typeof PRODUCTION_SAFE_TYPES)[number]),
    false,
    `text/plain is not in the SAFE allowlist ${PRODUCTION_SAFE_TYPES.join(', ')}`,
  );
});

test('the real active-content fixture bytes sniff to suspicious/polyglot (the pin is not vacuous)', () => {
  const html = sniffMime(activeHtmlBytes('p08-html-marker'));
  assert.equal(html.mediaType, 'text/html');
  assert.equal(html.category, 'suspicious');
  assert.equal(html.polyglot, false);

  const svg = sniffMime(svgBytes('p08-svg-marker'));
  assert.equal(svg.mediaType, 'image/svg+xml');
  assert.equal(svg.category, 'suspicious');
  assert.equal(svg.polyglot, false);

  const polyglot = sniffMime(polyglotPdfBytes('p08-polyglot-marker'));
  assert.equal(polyglot.mediaType, 'application/pdf');
  assert.equal(polyglot.category, 'suspicious');
  assert.equal(polyglot.polyglot, true);
});

test('production mediaMismatch never quarantines a text/plain declaration (pinned fix semantics)', () => {
  // The exact calls the fix relies on: every p08 active-content sniff category
  // with the non-SAFE allowed declaration.
  assert.equal(
    mediaMismatch('text/plain', { mediaType: 'text/html', category: 'suspicious', polyglot: false }),
    false,
    'text/plain + suspicious HTML must verify (forced-download evidence)',
  );
  assert.equal(
    mediaMismatch('text/plain', { mediaType: 'image/svg+xml', category: 'suspicious', polyglot: false }),
    false,
    'text/plain + suspicious SVG must verify',
  );
  assert.equal(
    mediaMismatch('text/plain', { mediaType: 'application/pdf', category: 'suspicious', polyglot: true }),
    false,
    'text/plain + pdf-polyglot must verify',
  );

  // The same contract through the REAL sniffed fixture bytes and the shared
  // evidence constant, i.e. the exact decision the production verification
  // route makes for the p08 evidence uploads.
  const sniffed = [
    sniffMime(activeHtmlBytes('p08-html-marker')),
    sniffMime(svgBytes('p08-svg-marker')),
    sniffMime(polyglotPdfBytes('p08-polyglot-marker')),
  ] as const;
  for (const mime of sniffed) {
    assert.equal(
      mediaMismatch(P08_ACTIVE_CONTENT_MEDIA_TYPE, mime),
      false,
      `mediaMismatch(${P08_ACTIVE_CONTENT_MEDIA_TYPE}, ${JSON.stringify(mime)}) must be false`,
    );
  }
});

test('negative control: the pre-fix image/png declaration WOULD quarantine the same bytes', () => {
  // Regression proof: with the old fixture declaration the production policy
  // isolates the blob (media_mismatch -> quarantine), which is exactly the
  // `verification_not_converged:stored_private:expired:quarantined:
  // media_mismatch` tail the real R2 runs produced.
  const html = sniffMime(activeHtmlBytes('p08-html-marker'));
  assert.equal(
    mediaMismatch('image/png', html),
    true,
    'image/png declared on text/html suspicious bytes must mismatch (the pre-fix quarantine)',
  );
  const svg = sniffMime(svgBytes('p08-svg-marker'));
  assert.equal(
    mediaMismatch('image/png', svg),
    true,
    'image/png declared on image/svg+xml suspicious bytes must mismatch (the pre-fix quarantine)',
  );
});
