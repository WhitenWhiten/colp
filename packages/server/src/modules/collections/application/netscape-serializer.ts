import type { Snapshot, SnapshotNode } from '@know-n/colp/types';

/**
 * Netscape Bookmark HTML for a COLP snapshot.
 *
 * `<DD>` descriptions, `TAGS`, and `<HR>` separators are written for browsers.
 * `parseNetscapeBookmarkHtml` keeps only folder and bookmark titles, URLs, and
 * order, so a round-trip compares that tree and not the extra fields.
 */
export function serializeNetscapeBookmarkHtml(
  snapshot: Pick<Snapshot, 'collection' | 'nodes'>,
): string {
  const tree = buildTree(snapshot.nodes);
  const title = escapeHtml(snapshot.collection.title);
  const body = renderItem(tree, 1, new Set());
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${title}</TITLE>`,
    `<H1>${title}</H1>`,
    '<DL><p>',
    body.endsWith('\n') ? body.slice(0, -1) : body,
    '</DL><p>',
    '',
  ].join('\n');
}

interface TreeNode {
  readonly node: SnapshotNode;
  readonly children: TreeNode[];
}

function buildTree(nodes: readonly SnapshotNode[]): TreeNode {
  const entries = new Map<string, TreeNode>();
  for (const node of nodes) entries.set(node.id, { node, children: [] });
  let root: TreeNode | undefined;
  for (const node of nodes) {
    if (node.kind !== 'root') continue;
    root = entries.get(node.id);
    break;
  }
  if (root === undefined) throw new TypeError('Netscape export requires a root node.');
  for (const node of nodes) {
    if (node.id === root.node.id) continue;
    const current = entries.get(node.id);
    if (current === undefined) continue;
    const parent = typeof node.parentId === 'string' ? entries.get(node.parentId) : undefined;
    const target = parent !== undefined && parent.node.id !== node.id ? parent : root;
    target.children.push(current);
  }
  sortTree(root, new Set());
  return root;
}

function sortTree(node: TreeNode, seen: Set<string>): void {
  if (seen.has(node.node.id)) return;
  seen.add(node.node.id);
  node.children.sort((left, right) => compareNodes(left.node, right.node));
  for (const child of node.children) sortTree(child, seen);
}

function compareNodes(left: SnapshotNode, right: SnapshotNode): number {
  const leftPosition = left.position ?? '';
  const rightPosition = right.position ?? '';
  if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function renderItem(node: TreeNode, depth: number, seen: ReadonlySet<string>): string {
  if (seen.has(node.node.id)) return '';
  const next = new Set(seen);
  next.add(node.node.id);
  if (node.node.kind === 'root') {
    return node.children.map((child) => renderItem(child, depth, next)).join('');
  }
  const pad = '    '.repeat(depth);
  if (node.node.kind === 'folder') {
    const children = node.children.map((child) => renderItem(child, depth + 1, next)).join('');
    return `${pad}<DT><H3${dateAttrs(node.node)}${tagAttr(node.node.tags)}>${escapeHtml(node.node.title)}</H3>\n${descriptionBlock(node.node.description, depth)}${pad}<DL><p>\n${children}${pad}</DL><p>\n`;
  }
  if (node.node.kind === 'separator') {
    return `${pad}<DT><HR>\n${descriptionBlock(node.node.description, depth)}`;
  }
  if (node.node.kind === 'bookmark' && node.node.redacted !== true && typeof node.node.url === 'string') {
    return `${pad}<DT><A HREF="${escapeHtml(node.node.url)}"${dateAttrs(node.node)}${tagAttr(node.node.tags)}>${escapeHtml(node.node.title)}</A>\n${descriptionBlock(node.node.description, depth)}`;
  }
  return '';
}

function dateAttrs(node: SnapshotNode): string {
  const created = unixSeconds(node.createdAt);
  const updated = unixSeconds(node.updatedAt);
  return `${created === undefined ? '' : ` ADD_DATE="${created}"`}${updated === undefined ? '' : ` LAST_MODIFIED="${updated}"`}`;
}

function tagAttr(tags: readonly string[] | undefined): string {
  if (tags === undefined || tags.length === 0) return '';
  return ` TAGS="${escapeHtml(tags.join(','))}"`;
}

function descriptionBlock(description: string | undefined, depth: number): string {
  if (description === undefined || description.length === 0) return '';
  return `${'    '.repeat(depth)}<DD>${escapeHtml(description)}</DD>\n`;
}

function unixSeconds(value: string): string | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return String(Math.floor(parsed / 1000));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
