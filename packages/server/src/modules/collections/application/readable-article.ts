export type ReadableArticleParagraph = {
  readonly id: string;
  readonly text: string;
};

export type ReadableArticleSection = {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly ReadableArticleParagraph[];
};

export type ReadableArticleExtractResult =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'article';
      readonly title: string | null;
      readonly byline: string | null;
      readonly wordCount: number;
      readonly sections: readonly ReadableArticleSection[];
    };

export type ReadableArticleExtractorInput = {
  readonly html: string;
  readonly url: string;
};

export type ReadableArticleExtractor = (
  input: ReadableArticleExtractorInput,
) => ReadableArticleExtractResult;

export type ReadableArticleClipInput = {
  readonly title: string | null;
  readonly byline: string | null;
  readonly sections: readonly ReadableArticleSection[];
};

const HEADING_MAX_LENGTH = 200;
const PARAGRAPH_MAX_LENGTH = 10000;
const MAX_SECTIONS = 80;
const MAX_PARAGRAPHS_PER_SECTION = 60;

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return value;
}

function countWords(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) ?? []).length;
  const latin = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, ' ')
    .split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}

/**
 * Clip already-cut sections to OpenAPI replica limits. Truncation stays
 * `article`; empty sections after clip become `empty`.
 */
export function extractReadableArticle(
  input: ReadableArticleClipInput,
): ReadableArticleExtractResult {
  const sections = input.sections.slice(0, MAX_SECTIONS).map((section) => ({
    id: section.id,
    heading: section.heading.slice(0, HEADING_MAX_LENGTH),
    paragraphs: section.paragraphs.slice(0, MAX_PARAGRAPHS_PER_SECTION).map((paragraph) => ({
      id: paragraph.id,
      text: paragraph.text.slice(0, PARAGRAPH_MAX_LENGTH),
    })),
  }));
  if (!sections.some((section) => section.paragraphs.length > 0)) {
    return { kind: 'empty' };
  }
  const text = sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text)).join('\n');
  return {
    kind: 'article',
    title: emptyToNull(input.title),
    byline: emptyToNull(input.byline),
    wordCount: countWords(text),
    sections,
  };
}
