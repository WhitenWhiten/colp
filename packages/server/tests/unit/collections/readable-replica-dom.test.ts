import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  extractReadableArticle,
  type ReadableArticleExtractResult,
} from '../../../src/modules/collections/index.js';
import { createMozillaReadableArticleExtractor } from '../../../src/infrastructure/collections/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '../../fixtures/readable-replica');
const applicationSourcePath = join(here, '../../../src/modules/collections/application/readable-article.ts');
const PAGE_URL = 'https://readable.test/article';
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu;
const CJK_34 = '这是一篇关于知识管理的中文文章正文需要三十四个汉字凑齐测试内容完毕了';

const extract = createMozillaReadableArticleExtractor();

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function run(name: string): ReadableArticleExtractResult {
  return extract({ html: loadFixture(name), url: PAGE_URL });
}

function asArticle(result: ReadableArticleExtractResult) {
  assert.equal(result.kind, 'article');
  if (result.kind !== 'article') throw new Error('expected article');
  return result;
}

function allText(result: Extract<ReadableArticleExtractResult, { kind: 'article' }>): string {
  return result.sections
    .flatMap((section) => [section.heading, ...section.paragraphs.map((paragraph) => paragraph.text)])
    .join('\n');
}

function paragraphTexts(result: Extract<ReadableArticleExtractResult, { kind: 'article' }>): string[] {
  return result.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text));
}

function expectedWordCount(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) ?? []).length;
  const latin = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

function assertPlainTextParagraphs(result: Extract<ReadableArticleExtractResult, { kind: 'article' }>): void {
  for (const section of result.sections) {
    assert.match(section.id, /^s\d+$/u);
    for (const paragraph of section.paragraphs) {
      assert.match(paragraph.id, /^s\d+-p\d+$/u);
      assert.equal(paragraph.id.startsWith(`${section.id}-p`), true);
      assert.equal(/<[a-zA-Z][^>]*>/.test(paragraph.text), false);
    }
  }
}

function assertWithinClipLimits(result: Extract<ReadableArticleExtractResult, { kind: 'article' }>): void {
  assert.ok(result.sections.length <= 80);
  for (const section of result.sections) {
    assert.ok(section.heading.length <= 200);
    assert.ok(section.paragraphs.length <= 60);
    for (const paragraph of section.paragraphs) {
      assert.ok(paragraph.text.length <= 10000);
    }
  }
}

test('blog article yields plain-text sections, list items, link text without href, and an h1 boundary', () => {
  const result = asArticle(run('blog-article.html'));
  const text = allText(result);
  assertPlainTextParagraphs(result);
  assert.equal(text.includes('<'), false);
  assert.equal(text.includes('href-must-not-survive.test'), false);
  assert.equal(text.includes('secret-path'), false);
  assert.equal(text.includes('hotlink.test'), false);
  assert.equal(text.includes('keep this text'), true);
  assert.equal(text.includes('First list item about granite corestones'), true);
  assert.equal(text.includes('Second list item about basalt xenoliths'), true);
  assert.equal(
    result.sections.some((section) => section.heading === 'In-article H1 boundary'),
    true,
  );
  const listSection = result.sections.find((section) => (
    section.paragraphs.some((paragraph) => paragraph.text.includes('granite corestones'))
  ));
  assert.ok(listSection);
  const graniteIndex = listSection.paragraphs.findIndex((paragraph) => paragraph.text.includes('granite corestones'));
  const basaltIndex = listSection.paragraphs.findIndex((paragraph) => paragraph.text.includes('basalt xenoliths'));
  assert.equal(graniteIndex >= 0 && basaltIndex === graniteIndex + 1, true);
  const concatenated = paragraphTexts(result).join('\n');
  assert.equal(result.wordCount, expectedWordCount(concatenated));
  assert.ok(result.wordCount > 0);
});

test('noisy nav and footer titles do not appear in extracted sections', () => {
  const result = asArticle(run('noisy-nav-footer.html'));
  const text = allText(result);
  assert.equal(text.includes('NAV_TITLE_MUST_NOT_APPEAR'), false);
  assert.equal(text.includes('FOOTER_COPYRIGHT_MUST_NOT_APPEAR'), false);
  assert.equal(text.includes('SIDEBAR_WIDGET_MUST_NOT_APPEAR'), false);
  assert.equal(text.includes('HYDROLOGY_ARTICLE_SENTENCE'), true);
});

test('inline script is dropped and leftover markup is absent', () => {
  const result = asArticle(run('inline-script.html'));
  const blob = JSON.stringify(result);
  assert.equal(blob.includes('alert(1)'), false);
  assert.equal(blob.includes('<script'), false);
  assert.equal(blob.includes('javascript:'), false);
  assert.equal(allText(result).includes('varved sediments'), true);
});

test('empty body yields empty', () => {
  assert.deepEqual(run('empty-body.html'), { kind: 'empty' });
});

test('video-embed-only page yields empty', () => {
  assert.deepEqual(run('video-embed-only.html'), { kind: 'empty' });
});

test('javascript href is stripped, link text remains, and iframe inner text does not leak', () => {
  const result = asArticle(run('javascript-href-iframe.html'));
  const blob = JSON.stringify(result);
  const text = allText(result);
  assert.equal(text.includes('click me surviving text'), true);
  assert.equal(blob.includes('javascript:'), false);
  assert.equal(text.includes('frame text'), false);
  assert.equal(blob.includes('frames.test'), false);
});

test('clip limits truncate headings, paragraphs, and counts without turning the article empty', () => {
  const clipped = extractReadableArticle({
    title: 'Over',
    byline: '',
    sections: Array.from({ length: 81 }, (_, sectionIndex) => ({
      id: `s${sectionIndex}`,
      heading: sectionIndex === 0 ? 'H'.repeat(250) : `Section ${sectionIndex}`,
      paragraphs: Array.from({ length: sectionIndex === 1 ? 61 : 1 }, (_, paragraphIndex) => ({
        id: `s${sectionIndex}-p${paragraphIndex}`,
        text: sectionIndex === 2 && paragraphIndex === 0 ? 'P'.repeat(10001) : `p${paragraphIndex}`,
      })),
    })),
  });
  const article = asArticle(clipped);
  assert.equal(article.sections.length, 80);
  assert.equal(article.sections[0]?.heading, 'H'.repeat(200));
  assert.equal(article.sections[1]?.paragraphs.length, 60);
  assert.equal(article.sections[2]?.paragraphs[0]?.text, 'P'.repeat(10000));
  assert.equal(article.title, 'Over');
  assert.equal(article.byline, null);
  assertWithinClipLimits(article);

  const fromHtml = asArticle(run('over-limit.html'));
  assertWithinClipLimits(fromHtml);
  const htmlText = allText(fromHtml);
  assert.equal(htmlText.includes('HEADING_TAIL_GONE'), false);
  assert.equal(htmlText.includes('PARAGRAPH_TAIL_GONE'), false);
  if (htmlText.includes('UNIQUE_HEADING_PREFIX')) {
    const heading = fromHtml.sections.find((section) => section.heading.includes('UNIQUE_HEADING_PREFIX'));
    assert.ok(heading);
    assert.equal(heading.heading.length, 200);
  }
  if (htmlText.includes('UNIQUE_PARAGRAPH_PREFIX')) {
    const paragraph = paragraphTexts(fromHtml).find((text) => text.includes('UNIQUE_PARAGRAPH_PREFIX'));
    assert.ok(paragraph);
    assert.equal(paragraph.length, 10000);
  }
});

test('wordCount counts CJK per character so 34 han characters are not two latin tokens', () => {
  const clipped = extractReadableArticle({
    title: '中文',
    byline: null,
    sections: [{
      id: 's0',
      heading: '',
      paragraphs: [{ id: 's0-p0', text: CJK_34 }],
    }],
  });
  const direct = asArticle(clipped);
  assert.equal(CJK_34.length, 34);
  assert.equal((CJK_34.match(CJK_RE) ?? []).length, 34);
  assert.equal(direct.wordCount, 34);
  assert.notEqual(CJK_34.split(/\s+/).filter(Boolean).length, 34);

  const fromHtml = asArticle(run('chinese-body.html'));
  const concatenated = paragraphTexts(fromHtml).join('\n');
  const cjk = (concatenated.match(CJK_RE) ?? []).length;
  assert.ok(cjk >= 34);
  assert.equal(concatenated.includes(CJK_34), true);
  assert.equal(fromHtml.wordCount, expectedWordCount(concatenated));
  const naive = concatenated.split(/\s+/).filter(Boolean).length;
  assert.notEqual(fromHtml.wordCount, naive);
});

test('wordCount separates adjacent latin paragraphs so HelloWorld is two words', () => {
  const clipped = extractReadableArticle({
    title: 'T',
    byline: null,
    sections: [{
      id: 's0',
      heading: '',
      paragraphs: [
        { id: 's0-p0', text: 'Hello' },
        { id: 's0-p1', text: 'World' },
      ],
    }],
  });
  assert.equal(asArticle(clipped).wordCount, 2);
});

test('application readable-article source does not import the three DOM packages', () => {
  const source = readFileSync(applicationSourcePath, 'utf8');
  assert.equal(source.includes('linkedom'), false);
  assert.equal(source.includes('@mozilla/readability'), false);
  assert.equal(source.includes('sanitize-html'), false);
});

const FALLBACK_NOTICE = 'Notice: This page displays a fallback because interactive scripts did not run. '
  + 'Possible causes include disabled JavaScript or failure to load scripts or stylesheets.';

function filler(count: number, marker: string): string {
  return Array.from({ length: count }, (_, index) => (
    `${marker} sentence ${index} carries enough ordinary prose about readable replicas to satisfy the scorer.`
  )).join(' ');
}

function extractHtml(html: string): ReadableArticleExtractResult {
  return extract({ html, url: PAGE_URL });
}

function articleBody(body: string, title = 'Structured Probe'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>`
    + `<main><article>${body}</article></main></body></html>`;
}

test('structured no-JS fallback page keeps every content block and drops all chrome and notices', () => {
  const result = asArticle(run('js-fallback-structured.html'));
  const text = allText(result);
  const paragraphs = paragraphTexts(result);
  assertPlainTextParagraphs(result);
  assertWithinClipLimits(result);

  // Junk removal: noscript + role=alert notice, cookie banner, banner/nav/footer, hidden variants.
  assert.equal(text.includes('interactive scripts did not run'), false);
  assert.equal(text.includes('displays a fallback'), false);
  for (const marker of [
    'COOKIE_BANNER_MUST_NOT_APPEAR', 'SIDEBAR_LINK_MUST_NOT_APPEAR', 'DISPLAY_NONE_MUST_NOT_APPEAR',
    'HIDDEN_ATTR_MUST_NOT_APPEAR', 'TEMPLATE_MUST_NOT_APPEAR', 'FOOTER_MUST_NOT_APPEAR', 'DocsBrand',
  ]) {
    assert.equal(text.includes(marker), false, `${marker} leaked`);
  }

  // Title dedupe: the h1 and the repeated <p> both match the title and are gone.
  assert.equal(result.title, 'Tool use with the Messages API');
  assert.equal(paragraphs.includes('Tool use with the Messages API'), false);
  assert.equal(result.sections.some((section) => section.heading === 'Tool use with the Messages API'), false);

  // Content in bare <div>s survives, consecutive duplicates collapse to one.
  assert.equal(paragraphs.filter((paragraph) => paragraph.startsWith('INTRO_DIV_SENTENCE')).length, 1);
  assert.equal(paragraphs.some((paragraph) => paragraph.startsWith('FLOW_DIV_SENTENCE')), true);

  // Adjacent headings fold into one section heading; nested headings still cut sections.
  assert.equal(result.sections.some((section) => section.heading === 'How tool use works · Request flow'), true);
  assert.equal(result.sections.some((section) => section.heading === 'Example request'), true);

  // Table: caption + one paragraph per row, cells joined with ' · '.
  assert.equal(paragraphs.includes('Parameter reference'), true);
  assert.equal(paragraphs.includes('Field · Type · Description'), true);
  assert.equal(paragraphs.includes('name · string · TABLE_ROW_ONE Tool name, unique within the request.'), true);
  assert.equal(paragraphs.includes('input_schema · object · TABLE_ROW_TWO JSON schema for the tool input.'), true);

  // Definition list, figcaption, blockquote.
  assert.equal(paragraphs.includes('tool_choice: DL_DEFINITION_ONE Controls whether the model must call a tool.'), true);
  assert.equal(paragraphs.includes('disable_parallel_tool_use: DL_DEFINITION_TWO Forces at most one tool call per turn.'), true);
  assert.equal(paragraphs.includes('FIGCAPTION_SENTENCE Sequence of a single tool round trip.'), true);
  assert.equal(paragraphs.includes('QUOTE_SENTENCE Treat tool results as untrusted input.'), true);

  // Preformatted block keeps its line breaks as a single paragraph.
  const pre = paragraphs.find((paragraph) => paragraph.startsWith('curl https://api.example.test'));
  assert.ok(pre);
  assert.equal(pre.split('\n').length, 3);
  assert.equal(pre.includes('  -H "content-type: application/json"'), true);

  // <br> splits, list items get markers and stay in order.
  const lineOne = paragraphs.indexOf('Line one of a paragraph');
  assert.equal(lineOne >= 0, true);
  assert.equal(paragraphs[lineOne + 1], 'Line two after a break');
  const bulletOne = paragraphs.indexOf('• BULLET_ONE define the tool');
  assert.equal(bulletOne >= 0, true);
  assert.equal(paragraphs[bulletOne + 1], '• BULLET_TWO run it locally');
  assert.equal(paragraphs[bulletOne + 2], '1. STEP_ONE send the definitions');
  assert.equal(paragraphs[bulletOne + 3], '2. STEP_TWO return the result');

  // No empty sections: the trailing heading is dropped, every section has paragraphs.
  assert.equal(result.sections.some((section) => section.heading === 'Trailing heading without content'), false);
  for (const section of result.sections) assert.ok(section.paragraphs.length > 0);
  assert.equal(result.wordCount, expectedWordCount(paragraphs.join('\n')));
});

test('fallback notice inside <noscript> and a visible role=alert div never reaches paragraphs', () => {
  const html = `<!doctype html><html><head><title>Notice Probe</title></head><body>
    <noscript><div class="banner">${FALLBACK_NOTICE}</div></noscript>
    <div role="alert">${FALLBACK_NOTICE}</div>
    <main><article>
      <p>${FALLBACK_NOTICE}</p>
      <p>${filler(4, 'REAL_ONE')}</p>
      <p>${filler(4, 'REAL_TWO')}</p>
    </article></main></body></html>`;
  const result = asArticle(extractHtml(html));
  const text = allText(result);
  assert.equal(text.includes('interactive scripts did not run'), false);
  assert.equal(text.includes('Notice:'), false);
  assert.equal(text.includes('REAL_ONE'), true);
  assert.equal(text.includes('REAL_TWO'), true);
});

test('a page that is only a fallback notice extracts as empty rather than junk', () => {
  const html = `<!doctype html><html><head><title>Shell</title></head><body>
    <div id="root"><div role="alert">${FALLBACK_NOTICE}</div>
    <p>You need to enable JavaScript to run this app.</p></div></body></html>`;
  assert.deepEqual(extractHtml(html), { kind: 'empty' });
});

test('bare text runs between blocks become paragraphs instead of being dropped or fused', () => {
  const html = articleBody(`
    <p>${filler(3, 'LEAD')}</p>
    <div>${filler(3, 'ALPHA')}<br>${filler(3, 'BETA')}</div>
    <span>${filler(3, 'GAMMA')}</span>
    <table><tr><td>${filler(2, 'CELL_A')}</td><td>${filler(2, 'CELL_B')}</td></tr></table>
    <p>${filler(3, 'TAIL')}</p>`);
  const paragraphs = paragraphTexts(asArticle(extractHtml(html)));
  const alpha = paragraphs.find((paragraph) => paragraph.startsWith('ALPHA'));
  const beta = paragraphs.find((paragraph) => paragraph.startsWith('BETA'));
  assert.ok(alpha && beta);
  assert.equal(alpha.includes('BETA'), false);
  assert.equal(paragraphs.some((paragraph) => paragraph.startsWith('GAMMA')), true);
  const row = paragraphs.find((paragraph) => paragraph.startsWith('CELL_A'));
  assert.ok(row);
  assert.equal(row.includes(' · CELL_B'), true);
  assert.equal(/\s{2,}/u.test(paragraphs.filter((paragraph) => !paragraph.includes('\n')).join('')), false);
});

test('nested and multi-paragraph list items carry exactly one marker each', () => {
  const html = articleBody(`
    <p>${filler(3, 'LEAD')}</p>
    <ul>
      <li>outer alpha<ul><li>inner one</li><li>inner two</li></ul></li>
      <li><p>outer beta</p><p>beta continued</p></li>
      <li><ul><li>only nested</li></ul></li>
    </ul>
    <p>${filler(3, 'TAIL')}</p>`);
  const paragraphs = paragraphTexts(asArticle(extractHtml(html)));
  assert.equal(paragraphs.includes('• outer alpha'), true);
  assert.equal(paragraphs.includes('• inner one'), true);
  assert.equal(paragraphs.includes('• inner two'), true);
  assert.equal(paragraphs.includes('• outer beta'), true);
  assert.equal(paragraphs.includes('beta continued'), true);
  assert.equal(paragraphs.includes('• only nested'), true);
  assert.equal(paragraphs.some((paragraph) => paragraph.startsWith('• • ')), false);
});

test('whitespace runs and zero-width characters collapse outside <pre> only', () => {
  const html = articleBody(`
    <p>${filler(3, 'LEAD')}</p>
    <p>Spaced\u00a0\u00a0out\u200b \ufefftext\n\n   with\ttabs</p>
    <pre>keep    inner
    indentation</pre>
    <p>${filler(3, 'TAIL')}</p>`);
  const paragraphs = paragraphTexts(asArticle(extractHtml(html)));
  assert.equal(paragraphs.includes('Spaced out text with tabs'), true);
  assert.equal(paragraphs.includes('keep    inner\n    indentation'), true);
});

test('h5 and h6 headings cut sections and the byline is whitespace-normalized', () => {
  const html = `<!doctype html><html><head><title>Deep Headings</title>
    <meta name="author" content="  Ada   Lovelace "></head><body><main><article>
    <p>${filler(3, 'LEAD')}</p>
    <h5>Fifth level</h5><p>${filler(3, 'FIVE')}</p>
    <h6>Sixth level</h6><p>${filler(3, 'SIX')}</p>
    </article></main></body></html>`;
  const result = asArticle(extractHtml(html));
  assert.equal(result.byline, 'Ada Lovelace');
  assert.equal(result.sections.some((section) => section.heading === 'Fifth level'), true);
  assert.equal(result.sections.some((section) => section.heading === 'Sixth level'), true);
});
