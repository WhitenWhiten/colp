import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  buildReadableSections,
  isFallbackNotice,
  normalizeInlineText,
  normalizePreformattedText,
  preCleanReadableDocument,
  type ReadableBlock,
} from '../../../src/infrastructure/collections/index.js';

const heading = (text: string): ReadableBlock => ({ kind: 'heading', text });
const paragraph = (text: string): ReadableBlock => ({ kind: 'paragraph', text });

test('fallback notice list matches the known no-JS shells and nothing long', () => {
  for (const notice of [
    'Notice: This page displays a fallback because interactive scripts did not run. '
      + 'Possible causes include disabled JavaScript or failure to load scripts or stylesheets.',
    'You need to enable JavaScript to run this app.',
    'Please enable JavaScript to view the comments powered by Disqus.',
    'JavaScript is disabled in your browser.',
    'JavaScript is required for this site.',
    'Please turn on JavaScript and reload the page.',
    'JavaScript must be enabled to use this feature.',
    'Your browser does not support JavaScript!',
  ]) {
    assert.equal(isFallbackNotice(notice), true, notice);
  }
  for (const prose of [
    'Interactive scripts are a common way to prototype tooling before committing to a compiled binary.',
    'The fallback allocator kicks in when the arena is exhausted.',
    'JavaScript is a dynamically typed language that runs in browsers and on servers alike.',
    'We enable a JavaScript bundle per route to keep the initial payload small.',
    `To enable JavaScript in an embedded webview you must ${'explain the security trade-offs '.repeat(25)}first.`,
  ]) {
    assert.equal(isFallbackNotice(prose), false, prose);
  }
});

test('inline normalization collapses whitespace and strips zero-width marks; pre keeps structure', () => {
  assert.equal(normalizeInlineText('  a\u00a0\u00a0b\n\tc\u200b\ufeff d '), 'a b c d');
  assert.equal(normalizeInlineText(null), '');
  assert.equal(normalizePreformattedText('\n\nline one   \r\n  line two\t\n\n'), 'line one\n  line two');
  assert.equal(normalizePreformattedText(undefined), '');
});

test('sections: leading title duplicate, empty headings, duplicate runs, and notices are removed', () => {
  const sections = buildReadableSections([
    paragraph('The Title'),
    heading('   '),
    paragraph('Notice: This page displays a fallback because interactive scripts did not run.'),
    paragraph('First body paragraph.'),
    paragraph('First body paragraph.'),
    paragraph('Second body paragraph.'),
    heading('Details'),
    paragraph('First body paragraph.'),
  ], { title: 'the  title' });
  assert.deepEqual(sections, [
    {
      id: 's0',
      heading: '',
      paragraphs: [
        { id: 's0-p0', text: 'First body paragraph.' },
        { id: 's0-p1', text: 'Second body paragraph.' },
      ],
    },
    {
      id: 's1',
      heading: 'Details',
      paragraphs: [{ id: 's1-p0', text: 'First body paragraph.' }],
    },
  ]);
});

test('sections: adjacent headings fold, trailing and content-less headings never produce empty sections', () => {
  const sections = buildReadableSections([
    heading('Part One'),
    heading('Chapter A'),
    paragraph('Body A.'),
    heading('Chapter B'),
    paragraph('You need to enable JavaScript to run this app.'),
    heading('Chapter C'),
    paragraph('Body C.'),
    heading('Dangling'),
  ], { title: null });
  assert.deepEqual(sections.map((section) => [section.heading, section.paragraphs.map((p) => p.text)]), [
    ['Part One · Chapter A', ['Body A.']],
    ['Chapter B · Chapter C', ['Body C.']],
  ]);
  for (const section of sections) assert.ok(section.paragraphs.length > 0);
});

test('sections: heading fold respects the 200-character wire cap by keeping the nearest heading', () => {
  const long = 'H'.repeat(150);
  const sections = buildReadableSections([
    heading(long),
    heading('Short but the combination would exceed two hundred characters easily'),
    paragraph('Body.'),
  ], { title: null });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.heading, 'Short but the combination would exceed two hundred characters easily');
  assert.ok((sections[0]?.heading.length ?? 0) <= 200);
});

test('sections: a leading heading equal to the title is dropped but a later one is kept', () => {
  const sections = buildReadableSections([
    heading('My Article'),
    paragraph('Intro.'),
    heading('My Article'),
    paragraph('Recap.'),
  ], { title: 'My Article' });
  assert.deepEqual(sections.map((section) => section.heading), ['', 'My Article']);
});

test('sections: ids stay contiguous and within the 32-character wire limit after filtering', () => {
  const blocks: ReadableBlock[] = [];
  for (let index = 0; index < 120; index += 1) {
    blocks.push(heading(`H${index}`));
    blocks.push(paragraph(index % 2 === 0 ? 'Please enable JavaScript.' : `Body ${index}`));
  }
  const sections = buildReadableSections(blocks, { title: null });
  sections.forEach((section, index) => {
    assert.equal(section.id, `s${index}`);
    assert.ok(section.id.length <= 32);
    section.paragraphs.forEach((item, paragraphIndex) => {
      assert.equal(item.id, `s${index}-p${paragraphIndex}`);
      assert.ok(item.id.length <= 32);
    });
    assert.ok(section.paragraphs.length > 0);
  });
});

test('pre-clean removes hidden, templated, chrome, and consent nodes but keeps content wrappers', () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div role="banner">BANNER</div>
    <nav>NAV</nav>
    <template><p>TEMPLATE</p></template>
    <noscript><div>NOSCRIPT</div></noscript>
    <div hidden>HIDDEN</div>
    <div aria-hidden="true">ARIA</div>
    <p style="color: red; display : none !important">STYLE_NONE</p>
    <p style="visibility:hidden">STYLE_VISIBILITY</p>
    <div role="dialog">DIALOG</div>
    <div role="alertdialog">ALERTDIALOG</div>
    <div id="onetrust-consent-sdk">ONETRUST</div>
    <div class="cookie-banner visible">COOKIE_BANNER</div>
    <section class="consent-notice">CONSENT</section>
    <main class="cookie-banner">MAIN_PROTECTED</main>
    <article id="gdpr-wall">${'ARTICLE_LONG '.repeat(200)}</article>
    <p class="cookie-recipe">KEEP_RECIPE</p>
    <p style="display:inline-block">KEEP_STYLE</p>
    <footer>FOOTER</footer>
    <div role="contentinfo">CONTENTINFO</div>
  </body></html>`);
  preCleanReadableDocument(document);
  const text = document.body.textContent ?? '';
  for (const gone of [
    'BANNER', 'NAV', 'TEMPLATE', 'NOSCRIPT', 'HIDDEN', 'ARIA', 'STYLE_NONE', 'STYLE_VISIBILITY',
    'DIALOG', 'ALERTDIALOG', 'ONETRUST', 'COOKIE_BANNER', 'CONSENT', 'FOOTER', 'CONTENTINFO',
  ]) {
    assert.equal(text.includes(gone), false, `${gone} should be removed`);
  }
  for (const kept of ['MAIN_PROTECTED', 'ARTICLE_LONG', 'KEEP_RECIPE', 'KEEP_STYLE']) {
    assert.equal(text.includes(kept), true, `${kept} should survive`);
  }
});
