import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as backend from '../../../src/infrastructure/http/public-shell/spa-html-meta.js';
import * as frontend from '../../../../Known-Frontend/web/scripts/spa-html-meta.mjs';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

test('backend typed copy matches frontend spa-html-meta replacements', () => {
  const title = 'About Know-N';
  const description = 'A "quoted" & <tagged> summary.';
  const pageUrl = 'https://know-n.com/about';
  const inner = '<h1>About</h1>';

  const fe = frontend.applyPageHead(
    frontend.replaceMarkedRegion(PUBLIC_SHELL_FIXTURE, frontend.wrapAgentPublicFallback(inner)),
    { title, description, canonicalPath: '/about' },
  );
  const be = backend.applyPageHead(
    backend.replaceMarkedRegion(PUBLIC_SHELL_FIXTURE, backend.wrapAgentPublicFallback(inner)),
    { title, description, canonicalPath: '/about' },
  );
  assert.equal(be, fe);

  assert.equal(backend.escapeHtml(description), frontend.escapeHtml(description));
  assert.equal(backend.escapeAttr(description), frontend.escapeAttr(description));
  assert.equal(backend.SITE_ORIGIN, frontend.SITE_ORIGIN);
  assert.equal(backend.SITE_OG_IMAGE_URL, frontend.SITE_OG_IMAGE_URL);

  const removedFe = frontend.applyPageHead(PUBLIC_SHELL_FIXTURE, {
    title: 'Page not found', description: 'gone', canonicalPath: null,
  });
  const removedBe = backend.applyPageHead(PUBLIC_SHELL_FIXTURE, {
    title: 'Page not found', description: 'gone', canonicalPath: null,
  });
  assert.equal(removedBe, removedFe);

  assert.equal(
    backend.replaceOgImage(PUBLIC_SHELL_FIXTURE, 'https://know-n.com/api/v1/og/x.png'),
    frontend.replaceOgImage(PUBLIC_SHELL_FIXTURE, 'https://know-n.com/api/v1/og/x.png'),
  );
  assert.equal(
    backend.replaceOgType(PUBLIC_SHELL_FIXTURE, 'profile'),
    frontend.replaceOgType(PUBLIC_SHELL_FIXTURE, 'profile'),
  );
});

test('language replacements are fail-closed and equivalent without duplicate og:locale', () => {
  for (const copy of [backend, frontend]) {
    assert.throws(() => copy.replaceHtmlLang('<html>', 'zh-CN'), /html lang.*exactly one baseline/u);
    assert.throws(() => copy.replaceOgLocale('<head></head>', 'zh_CN'), /og:locale.*exactly one baseline/u);
    assert.throws(
      () => copy.replaceOgLocale(`${PUBLIC_SHELL_FIXTURE}${copy.HOME_OG_LOCALE}`, 'zh_CN'),
      /og:locale.*exactly one baseline.*found 2/u,
    );
  }

  const feRegional = frontend.replaceOgLocale(
    frontend.replaceHtmlLang(PUBLIC_SHELL_FIXTURE, 'zh-CN'),
    'zh_CN',
  );
  const beRegional = backend.replaceOgLocale(
    backend.replaceHtmlLang(PUBLIC_SHELL_FIXTURE, 'zh-CN'),
    'zh_CN',
  );
  assert.equal(beRegional, feRegional);
  assert.match(beRegional, /<html lang="zh-CN">/u);
  assert.deepEqual([...beRegional.matchAll(/property="og:locale"/gu)].length, 1);
  assert.match(beRegional, /property="og:locale" content="zh_CN"/u);

  const feLanguageOnly = frontend.replaceOgLocale(
    frontend.replaceHtmlLang(PUBLIC_SHELL_FIXTURE, 'zh'),
    null,
  );
  const beLanguageOnly = backend.replaceOgLocale(
    backend.replaceHtmlLang(PUBLIC_SHELL_FIXTURE, 'zh'),
    null,
  );
  assert.equal(beLanguageOnly, feLanguageOnly);
  assert.match(beLanguageOnly, /<html lang="zh">/u);
  assert.doesNotMatch(beLanguageOnly, /property="og:locale"/u);
});

test('applyPageHead can set a distinct og:url from canonical', () => {
  const html = backend.applyPageHead(PUBLIC_SHELL_FIXTURE, {
    title: 'Notes',
    description: 'Desc',
    canonicalPath: '/c/notes',
    ogUrlPath: '/share/notes',
  });
  assert.match(html, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/notes" \/>/u);
  assert.match(html, /<meta property="og:url" content="https:\/\/know-n\.com\/share\/notes" \/>/u);
});

test('WebPage JSON-LD cannot break out of its script element in either maintained copy', () => {
  const hostile = '</ScRiPt><script>alert(1)</script><!--&>\u2028\u2029';
  const input = { name: hostile, description: hostile, url: 'https://know-n.com/about' };
  const be = backend.buildWebPageJsonLd(input);
  const fe = frontend.buildWebPageJsonLd(input);

  assert.equal(be, fe);
  const body = be.slice(be.indexOf('\n') + 1, be.lastIndexOf('\n    </script>'));
  assert.doesNotMatch(body, /[<>&\u2028\u2029]/u);
  assert.match(body, /\\u003c\/ScRiPt\\u003e/u);
  assert.match(body, /\\u0026/u);
  const parsed = JSON.parse(body) as { name: string; description: string };
  assert.equal(parsed.name, hostile);
  assert.equal(parsed.description, hostile);
});

test('backend truncatePublicShellDescription matches the generator truncateMetaDescription', async () => {
  const { truncateMetaDescription } = await import('../../../../Known-Frontend/web/scripts/generate-agent-public.mjs') as {
    truncateMetaDescription: (text: string, maxLength?: number) => string;
  };
  const { truncatePublicShellDescription } = await import('../../../src/infrastructure/http/public-shell/sanitize-public-shell-text.js');
  const cases = [
    'Short.',
    `${'A long sentence that keeps going and going without stopping at all. '.repeat(5)}Tail without punctuation`,
    `${'word '.repeat(60)}`,
    'x'.repeat(400),
    `${'???????????????????????????????'.repeat(3)}???????`,
    'Question? Exclamation! Period. Then a very long trailing fragment that certainly exceeds the window by itself and keeps going far beyond the maximum allowed length of the snippet',
    '  spaced   out\n\nwith   whitespace  ',
  ];
  for (const text of cases) {
    assert.equal(truncatePublicShellDescription(text), truncateMetaDescription(text), text.slice(0, 40));
    assert.equal(truncatePublicShellDescription(text, 80), truncateMetaDescription(text, 80), text.slice(0, 40));
  }
});
