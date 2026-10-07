/**
 * Mozilla Readability adapter: parse with linkedom, pre-clean, run
 * Readability, sanitize to a structural allow-list, walk every child node
 * (text nodes included) into heading/paragraph blocks, then shape and clip
 * via the collections facade. No network; parseHTML takes one argument.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import sanitizeHtml from 'sanitize-html';
import {
  extractReadableArticle,
  type ReadableArticleExtractor,
} from '../../modules/collections/index.js';
import {
  buildReadableSections,
  normalizeInlineText,
  normalizePreformattedText,
  preCleanReadableDocument,
  type ReadableBlock,
} from './readable-replica-clean.js';

/** Structure survives sanitisation (text only, no attributes). */
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol', 'li', 'br', 'hr',
  'em', 'strong', 'b', 'i', 'u', 's', 'code', 'pre', 'a', 'span', 'sup', 'sub', 'mark',
  'small', 'abbr', 'cite', 'q', 'kbd', 'time', 'del', 'ins',
  'div', 'section', 'article', 'main', 'aside', 'header',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'dl', 'dt', 'dd', 'figure', 'figcaption',
];
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'iframe', 'object', 'form', 'svg', 'noscript',
  'video', 'audio', 'canvas', 'template', 'button',
];
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'cite', 'code', 'del', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's',
  'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
]);
const TABLE_CELL_SEPARATOR = ' · ';
const UNORDERED_ITEM_PREFIX = '• ';
const LIST_MARKER = /^(?:• |\d+\. )/u;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

type DomNode = {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
};

function tagOf(node: DomNode): string {
  return node.nodeName.toLowerCase();
}

function children(node: DomNode): DomNode[] {
  return Array.from(node.childNodes);
}

/** Flatten a subtree to one line, spacing block/br boundaries so runs never fuse. */
function flatText(node: DomNode): string {
  const parts: string[] = [];
  const visit = (current: DomNode): void => {
    if (current.nodeType === TEXT_NODE) {
      parts.push(current.textContent ?? '');
      return;
    }
    if (current.nodeType !== ELEMENT_NODE) return;
    const inline = INLINE_TAGS.has(tagOf(current));
    if (!inline) parts.push(' ');
    for (const child of children(current)) visit(child);
    if (!inline) parts.push(' ');
  };
  visit(node);
  return normalizeInlineText(parts.join(''));
}

class BlockCollector {
  readonly blocks: ReadableBlock[] = [];
  private inline: string[] = [];

  text(value: string): void {
    this.inline.push(value);
  }

  /** Close the open inline run as a paragraph (if it has any text). */
  flush(): void {
    const text = normalizeInlineText(this.inline.join(''));
    this.inline = [];
    if (text.length > 0) this.blocks.push({ kind: 'paragraph', text });
  }

  paragraph(text: string): void {
    this.flush();
    if (text.length > 0) this.blocks.push({ kind: 'paragraph', text });
  }

  heading(text: string): void {
    this.flush();
    if (text.length > 0) this.blocks.push({ kind: 'heading', text });
  }

  /** Prefix the first paragraph emitted after `from` (list-item markers). */
  prefixFrom(from: number, prefix: string): void {
    const first = this.blocks[from];
    if (first === undefined || first.kind !== 'paragraph') return;
    if (LIST_MARKER.test(first.text)) return; // nested list item already carries a marker
    this.blocks[from] = { kind: 'paragraph', text: `${prefix}${first.text}` };
  }
}

function walk(node: DomNode, out: BlockCollector): void {
  if (node.nodeType === TEXT_NODE) {
    out.text(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const tag = tagOf(node);
  if (INLINE_TAGS.has(tag)) {
    for (const child of children(node)) walk(child, out);
    return;
  }
  if (HEADING_TAGS.has(tag)) {
    out.heading(flatText(node));
    return;
  }
  switch (tag) {
    case 'br':
    case 'hr':
      out.flush();
      return;
    case 'pre':
      out.paragraph(normalizePreformattedText(node.textContent));
      return;
    case 'ul':
    case 'ol':
      walkList(node, out, tag === 'ol');
      return;
    case 'table':
      out.flush();
      walkTable(node, out);
      return;
    case 'dl':
      out.flush();
      walkDefinitionList(node, out);
      return;
    case 'figcaption':
    case 'caption':
      out.paragraph(flatText(node));
      return;
    default:
      out.flush();
      for (const child of children(node)) walk(child, out);
      out.flush();
  }
}

function walkList(list: DomNode, out: BlockCollector, ordered: boolean): void {
  out.flush();
  let index = 0;
  for (const child of children(list)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (tagOf(child) !== 'li') {
      walk(child, out);
      continue;
    }
    index += 1;
    const from = out.blocks.length;
    for (const grandchild of children(child)) walk(grandchild, out);
    out.flush();
    out.prefixFrom(from, ordered ? `${index}. ` : UNORDERED_ITEM_PREFIX);
  }
}

function walkTable(table: DomNode, out: BlockCollector): void {
  for (const child of children(table)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = tagOf(child);
    if (tag === 'tr') {
      const cells = children(child)
        .filter((cell) => cell.nodeType === ELEMENT_NODE && (tagOf(cell) === 'td' || tagOf(cell) === 'th'))
        .map((cell) => flatText(cell))
        .filter((text) => text.length > 0);
      if (cells.length > 0) out.paragraph(cells.join(TABLE_CELL_SEPARATOR));
      continue;
    }
    if (tag === 'caption') {
      out.paragraph(flatText(child));
      continue;
    }
    walkTable(child, out);
  }
}

function walkDefinitionList(list: DomNode, out: BlockCollector): void {
  let terms: string[] = [];
  let termsUsed = false;
  const visit = (node: DomNode): void => {
    for (const child of children(node)) {
      if (child.nodeType !== ELEMENT_NODE) continue;
      const tag = tagOf(child);
      if (tag === 'dt') {
        if (termsUsed) {
          terms = [];
          termsUsed = false;
        }
        const term = flatText(child);
        if (term.length > 0) terms.push(term);
      } else if (tag === 'dd') {
        const definition = flatText(child);
        if (definition.length === 0) continue;
        out.paragraph(terms.length > 0 ? `${terms.join(', ')}: ${definition}` : definition);
        termsUsed = true;
      } else {
        visit(child);
      }
    }
  };
  visit(list);
  if (terms.length > 0 && !termsUsed) out.paragraph(terms.join(', '));
}

export function collectReadableBlocks(root: DomNode): ReadableBlock[] {
  const out = new BlockCollector();
  for (const child of children(root)) walk(child, out);
  out.flush();
  return out.blocks;
}

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

export function createMozillaReadableArticleExtractor(): ReadableArticleExtractor {
  return ({ html }) => {
    const { document } = parseHTML(html);
    preCleanReadableDocument(document);
    const article = new Readability(document).parse();
    if (article === null) return { kind: 'empty' };
    const clean = sanitizeHtml(article.content ?? '', {
      allowedTags: ALLOWED_TAGS,
      allowedAttributes: {},
      nonTextTags: NON_TEXT_TAGS,
    });
    const wrapped = parseHTML(
      `<!doctype html><html><head></head><body><div id="rr">${clean}</div></body></html>`,
    );
    const root = wrapped.document.getElementById('rr');
    const title = normalizeInlineText(article.title);
    const sections = root === null
      ? []
      : buildReadableSections(collectReadableBlocks(root), { title: emptyToNull(title) });
    return extractReadableArticle({
      title: emptyToNull(title),
      byline: emptyToNull(normalizeInlineText(article.byline)),
      sections,
    });
  };
}
