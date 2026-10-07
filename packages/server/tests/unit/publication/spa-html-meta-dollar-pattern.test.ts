/**
 * SSR replacements must treat caller-supplied text as literal text.
 *
 * `String.prototype.replace` interprets `$$`, `$&`, `` $` ``, `$'` and `$1` in a
 * *string* replacement. Every SSR helper here builds a literal replacement from
 * escaped-but-not-dollar-neutralised page data, so a page value containing `$'`
 * used to splice a fragment of the document into itself.
 *
 * On the shared `/explore` page the `name` field of the ItemList JSON-LD comes
 * from *other accounts'* public collection titles, so one account's title decided
 * the markup of the page every visitor receives.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import * as backend from '../../../src/infrastructure/http/public-shell/spa-html-meta.js';
import * as frontend from '../../../../Known-Frontend/web/scripts/spa-html-meta.mjs';
import { injectPublicExploreShell } from '../../../src/infrastructure/http/public-shell/public-explore-shell.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const HOSTILE_TITLE = "Reading list $' $& $` $$ end";

function ldJsonBodies(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">\n([\s\S]*?)\n {4}<\/script>/gu)]
    .map((match) => match[1] as string);
}

describe('SSR replacements keep caller text literal (no $-pattern splicing)', () => {
  for (const [label, copy] of [['backend', backend], ['frontend', frontend]] as const) {
    test(`${label}: replaceExact does not expand $-patterns`, () => {
      const out = copy.replaceExact(
        '<title>old</title>',
        /<title>[^<]*<\/title>/u,
        `<title>${HOSTILE_TITLE}</title>`,
        '<title>',
      );
      assert.ok(out.includes(HOSTILE_TITLE), `${label}: literal title was not preserved`);
      assert.equal((out.match(/<title>/gu) ?? []).length, 1, `${label}: <title> duplicated by $' splicing`);
    });

    test(`${label}: applyPageHead keeps a $-bearing title literal`, () => {
      const html = copy.applyPageHead(PUBLIC_SHELL_FIXTURE, {
        title: HOSTILE_TITLE, description: 'Summary.', canonicalPath: '/about',
      });
      // HTML escaping is expected; the point is that no $-pattern was expanded,
      // so the escaped literal survives and the document is not duplicated.
      assert.ok(html.includes(copy.escapeHtml(HOSTILE_TITLE)),
        `${label}: escaped title literal missing from the document`);
      assert.equal((html.match(/<title>/gu) ?? []).length, 1, `${label}: <title> count changed`);
      assert.equal((html.match(/<script/gu) ?? []).length, (PUBLIC_SHELL_FIXTURE.match(/<script/gu) ?? []).length,
        `${label}: script element count changed`);
    });
  }

  test('explore shell keeps another account\'s $-bearing title literal and its JSON-LD parseable', () => {
    const html = injectPublicExploreShell(PUBLIC_SHELL_FIXTURE, [{
      slug: 'hostile-title', title: HOSTILE_TITLE, summary: null, nodeCount: 1,
      updatedAt: '2026-08-20T06:00:00.000Z',
    }]);

    assert.equal((html.match(/<script/gu) ?? []).length,
      (PUBLIC_SHELL_FIXTURE.match(/<script/gu) ?? []).length, 'script element count changed');
    assert.equal((html.match(/<title>/gu) ?? []).length, 1, '<title> count changed');

    const bodies = ldJsonBodies(html);
    assert.equal(bodies.length, 1, 'exactly one JSON-LD block must remain');
    const parsed = JSON.parse(bodies[0]!) as {
      mainEntity: { itemListElement: { name: string }[] };
    };
    assert.equal(parsed.mainEntity.itemListElement[0]?.name, HOSTILE_TITLE);
  });
});
