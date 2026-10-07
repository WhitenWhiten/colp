import {
  PUBLIC_SHELL_DESCRIPTION_MAX,
  PUBLIC_SHELL_TITLE_MAX,
  sanitizePublicShellText,
} from './sanitize-public-shell-text.js';
import { FALLBACK_CURATOR, fallbackCollectionDescription, resolveSearchIndexable } from './inject-collection-shell.js';
import {
  outlinePublicCollection,
  PUBLIC_SHELL_MARKDOWN_ITEM_CAP,
  type PublicShellMarkdownNode,
} from './public-collection-outline.js';

export {
  comparePublicShellMarkdownSiblings,
  isPublicShellMarkdownUrl,
  PUBLIC_SHELL_MARKDOWN_ITEM_CAP,
  selectPublicShellMarkdownNodes,
  toPublicShellMarkdownNode,
  type PublicShellMarkdownNode,
} from './public-collection-outline.js';

export const PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

const MARKDOWN_BREAKERS = /[[\]()]/gu;

export interface PublicShellMarkdownInput {
  readonly collectionId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly curator: string;
  readonly updatedAt: string;
  readonly visibility: 'public' | 'unlisted';
  /** See `PublicShellCollectionInput.searchIndexable`; `false` adds the `robots: noindex` line. */
  readonly searchIndexable?: boolean;
  readonly nodes: readonly PublicShellMarkdownNode[];
  /**
   * `collections.live_node_count` (same column as T-10). Remaining note is
   * `and N more` where N = max(0, nodeCount - included). `included` is the
   * number of snapshot nodes taken for this page (≤ 500, root included).
   * N counts remaining live nodes, not remaining bookmarks only.
   */
  readonly nodeCount: number;
}

/** Escape user text so titles cannot break link / heading syntax or inject HTML. */
export function escapePublicShellMarkdown(text: string): string {
  return text
    .replace(/\\/gu, '\\\\')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(MARKDOWN_BREAKERS, (character) => `\\${character}`);
}

export function flattenPublicCollectionMarkdown(
  nodes: readonly PublicShellMarkdownNode[],
  cap = PUBLIC_SHELL_MARKDOWN_ITEM_CAP,
): { readonly lines: readonly string[]; readonly included: number } {
  const { entries, included } = outlinePublicCollection(nodes, cap);
  const lines = entries.map((entry) => entry.kind === 'folder'
    ? `${'#'.repeat(Math.min(entry.depth + 2, 6))} ${escapePublicShellMarkdown(entry.title)}`
    : `- [${escapePublicShellMarkdown(entry.title)}](${escapePublicShellMarkdownUrl(entry.url)})`);
  return { lines, included };
}

export function buildPublicCollectionMarkdown(input: PublicShellMarkdownInput): string {
  const curator = sanitizePublicShellText(input.curator, PUBLIC_SHELL_TITLE_MAX) || FALLBACK_CURATOR;
  const title = sanitizePublicShellText(input.title, PUBLIC_SHELL_TITLE_MAX) || 'Untitled';
  const rawSummary = input.summary === null
    ? ''
    : sanitizePublicShellText(input.summary, PUBLIC_SHELL_DESCRIPTION_MAX);
  const summary = rawSummary === '' ? fallbackCollectionDescription(curator) : rawSummary;
  const { lines: tree, included } = flattenPublicCollectionMarkdown(input.nodes);
  const remaining = Math.max(0, input.nodeCount - included);
  const snapshotHref = `/colp/v0.1/collections/${encodeURIComponent(input.collectionId)}/snapshot`;
  const parts = [
    `# ${escapePublicShellMarkdown(title)}`,
    '',
    `Curated by ${escapePublicShellMarkdown(curator)} · updated ${escapePublicShellMarkdown(formatUpdatedDate(input.updatedAt))}`,
    '',
    escapePublicShellMarkdown(summary),
  ];
  if (!resolveSearchIndexable(input)) {
    parts.push('', 'robots: noindex');
  }
  if (tree.length > 0) {
    parts.push('', ...tree);
  }
  if (remaining > 0) {
    parts.push('', `and ${remaining} more`);
  }
  parts.push(
    '',
    `[COLP snapshot](${snapshotHref}) · [llms.txt](/llms.txt)`,
    '',
  );
  return parts.join('\n');
}

export function buildPublicCollectionMarkdownNotFound(): string {
  return [
    '# Collection not found',
    '',
    'This collection is not available.',
    '',
    'See [/sitemap.xml](/sitemap.xml) and [/llms.txt](/llms.txt).',
    '',
  ].join('\n');
}

function escapePublicShellMarkdownUrl(url: string): string {
  return url.replace(/[\\()]/gu, (character) => `\\${character}`);
}

function formatUpdatedDate(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return updatedAt.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}
