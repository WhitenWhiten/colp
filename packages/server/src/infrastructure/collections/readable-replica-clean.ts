/**
 * Readable-replica text hygiene: pre-clean the parsed document before
 * Readability, filter no-JS fallback notices, and shape heading/paragraph
 * blocks into wire sections (no empty sections, no duplicate runs).
 * DOM-package free: operates on minimal structural interfaces so the
 * application-facing shape stays testable without linkedom.
 */
import type { ReadableArticleSection } from '../../modules/collections/index.js';

export type ReadableBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string };

export interface CleanableElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  remove(): void;
}

export interface CleanableDocument {
  querySelectorAll(selectors: string): ArrayLike<CleanableElement>;
}

/** Elements whose subtree never carries article prose for a reader replica. */
const REMOVED_SELECTORS = [
  'template', 'noscript', 'nav', 'footer',
  '[hidden]', '[aria-hidden="true"]',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="dialog"]', '[role="alertdialog"]',
].join(', ');
const HIDDEN_INLINE_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/iu;
/** Conservative cookie/consent banner id/class tokens (vendor ids + common compounds). */
const CONSENT_TOKEN = new RegExp(
  '^(?:'
  + 'cookie-?(?:banner|bar|consent|notice|popup|modal|wall|law-info-bar|policy-banner|disclaimer)'
  + '|consent-?(?:banner|bar|modal|manager|popup|notice|wall)'
  + '|gdpr-?(?:banner|bar|consent|modal|notice|wall)'
  + '|cc-(?:banner|window)|onetrust-(?:consent-sdk|banner-sdk)|CybotCookiebotDialog'
  + '|qc-cmp2-container|usercentrics-root|didomi-host|truste-consent-track|sp_message_container'
  + ')$', 'iu',
);
const CONSENT_MAX_TEXT_LENGTH = 2000;
const PROTECTED_TAGS = new Set(['HTML', 'BODY', 'MAIN', 'ARTICLE']);

/** Remove hidden/no-JS/chrome nodes before Readability scores the document. */
export function preCleanReadableDocument(document: CleanableDocument): void {
  for (const element of Array.from(document.querySelectorAll(REMOVED_SELECTORS))) {
    element.remove();
  }
  for (const element of Array.from(document.querySelectorAll('[style]'))) {
    const style = element.getAttribute('style') ?? '';
    if (HIDDEN_INLINE_STYLE.test(style)) element.remove();
  }
  for (const element of Array.from(document.querySelectorAll('[id], [class]'))) {
    if (PROTECTED_TAGS.has(element.tagName.toUpperCase())) continue;
    if (!looksLikeConsentBanner(element)) continue;
    if ((element.textContent ?? '').length > CONSENT_MAX_TEXT_LENGTH) continue;
    element.remove();
  }
}

function looksLikeConsentBanner(element: CleanableElement): boolean {
  const tokens = [
    element.getAttribute('id') ?? '',
    ...(element.getAttribute('class') ?? '').split(/\s+/u),
  ].filter((token) => token.length > 0);
  return tokens.some((token) => CONSENT_TOKEN.test(token));
}

/**
 * Small, conservative no-JS fallback notice list. Only short paragraphs are
 * eligible so legitimate prose that merely mentions JavaScript survives.
 */
const FALLBACK_NOTICE_PATTERNS: readonly RegExp[] = [
  /interactive scripts did not run/iu,
  /this page displays a fallback/iu,
  /\benable javascript\b/iu,
  /javascript is (?:disabled|required|not enabled|turned off|not available)/iu,
  /you need to enable javascript to run this app/iu,
  /please (?:turn on|activate) javascript/iu,
  /javascript (?:must|needs to|has to) be enabled/iu,
  /(?:browser|page) (?:does not|doesn't) support javascript/iu,
];
const FALLBACK_NOTICE_MAX_LENGTH = 400;

export function isFallbackNotice(text: string): boolean {
  if (text.length > FALLBACK_NOTICE_MAX_LENGTH) return false;
  return FALLBACK_NOTICE_PATTERNS.some((pattern) => pattern.test(text));
}

const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/gu;

/** Collapse whitespace runs (including NBSP) and strip zero-width characters. */
export function normalizeInlineText(value: string | null | undefined): string {
  if (value == null) return '';
  return value.replace(ZERO_WIDTH, '').replace(/\s+/gu, ' ').trim();
}

/** Preformatted text keeps line breaks and indentation; only outer blank lines go. */
export function normalizePreformattedText(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/^\n+/u, '')
    .replace(/\s+$/u, '');
}

const HEADING_FOLD_SEPARATOR = ' · ';
const HEADING_MAX_LENGTH = 200;

function sameText(left: string, right: string): boolean {
  return normalizeInlineText(left).toLowerCase() === normalizeInlineText(right).toLowerCase();
}

function foldHeadings(pending: string | null, next: string): string {
  if (pending === null) return next;
  const folded = `${pending}${HEADING_FOLD_SEPARATOR}${next}`;
  return folded.length <= HEADING_MAX_LENGTH ? folded : next;
}

/**
 * Turn an ordered block stream into wire sections:
 * - fallback notices and a leading title duplicate are dropped;
 * - consecutive identical paragraphs collapse to one;
 * - adjacent headings fold into the next section's heading, trailing
 *   headings are dropped, so every emitted section has ≥ 1 paragraph.
 */
export function buildReadableSections(
  blocks: readonly ReadableBlock[],
  options: { readonly title: string | null },
): ReadableArticleSection[] {
  const sections: Array<{ heading: string; paragraphs: string[] }> = [];
  let current: { heading: string; paragraphs: string[] } | null = null;
  let pendingHeading: string | null = null;
  let seenContent = false;
  let lastParagraph: string | null = null;

  for (const block of blocks) {
    const text = block.kind === 'paragraph' ? block.text : normalizeInlineText(block.text);
    if (text.length === 0) continue;
    if (!seenContent && options.title !== null && sameText(text, options.title)) continue;
    if (block.kind === 'heading') {
      seenContent = true;
      if (current !== null && current.paragraphs.length > 0) current = null;
      pendingHeading = foldHeadings(pendingHeading, text);
      lastParagraph = null;
      continue;
    }
    if (isFallbackNotice(text)) continue;
    if (lastParagraph !== null && text === lastParagraph) continue;
    seenContent = true;
    if (current === null) {
      current = { heading: pendingHeading ?? '', paragraphs: [] };
      pendingHeading = null;
      sections.push(current);
    }
    current.paragraphs.push(text);
    lastParagraph = text;
  }

  return sections.map((section, sectionIndex) => ({
    id: `s${sectionIndex}`,
    heading: section.heading,
    paragraphs: section.paragraphs.map((paragraph, paragraphIndex) => ({
      id: `s${sectionIndex}-p${paragraphIndex}`,
      text: paragraph,
    })),
  }));
}
