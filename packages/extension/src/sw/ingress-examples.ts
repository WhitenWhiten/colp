/**
 * C-20 / D2: which bookmark is behind a "not included in sync" row.
 *
 * The ledger keeps one row per reason and, on purpose, no bookmark: a field
 * written by this build would make older builds trip `ingress_diagnostic_invalid`
 * (which stops flushes), and a title is page content that should not sit in a
 * store that diagnostics read. So the answer is found when the list is opened:
 * one read of the live bookmark tree and, for each of the three reasons the codec
 * itself gives (`bookmarkRepresentability`), the first item inside the synced
 * range that it still refuses, plus how many more there are.
 *
 * What leaves this module goes to one reader: the options page that asked, over
 * the same runtime message as the rest of the list. It is never stored, and it is
 * never put into the copied details, the Help diagnostic or the health report:
 * those read their own facts and do not import this module (pinned by
 * tests/ingress-examples.test.ts).
 */
import { bookmarkRepresentability, type BookmarkRepresentability } from '../bookmark-event-codec.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../chrome-bookmark-tree.js';
import type { SyncScope, createSyncStateStore } from '../sync-state-store.js';
import type { PublicIngressExample } from '../types.js';

export type RefusedReason = Exclude<BookmarkRepresentability, 'supported'>;
/** The ledger codes a live bookmark can still be refused for; every other row has nothing to point at. */
export const REFUSED_REASONS: readonly RefusedReason[] = ['unsupported_url_scheme', 'invalid_title', 'invalid_url'];
export const EXAMPLE_TEXT_LIMIT = 80;

export interface IngressExampleBoundary {
  readonly selectedNative: ReadonlySet<string>;
  readonly privateNative: ReadonlySet<string>;
}

/** One line a person can search the bookmark manager for: the title, else the host, cut short. */
function exampleText(node: NormalizedBookmarkNode): string {
  const title = node.title.replace(/\s+/gu, ' ').trim();
  if (title) {
    const points = Array.from(title);
    return points.length <= EXAMPLE_TEXT_LIMIT ? title : `${points.slice(0, EXAMPLE_TEXT_LIMIT).join('').trimEnd()}…`;
  }
  if (node.kind !== 'bookmark' || node.url === undefined) return '';
  // The host only: never the address itself, which may carry a user name, a password or a token.
  try { return new URL(node.url).hostname; } catch { return ''; }
}

/**
 * Pure: the first item per reason that ingress would refuse right now. The
 * range is the one ingress itself uses (`resolveIngressBoundary`): inside a
 * synced folder, outside every excluded one, not browser-managed, and never the
 * built-in roots, which are not refused for their names.
 */
export function ingressExamples(roots: readonly NormalizedBookmarkRoot[],
  boundary: IngressExampleBoundary): ReadonlyMap<RefusedReason, PublicIngressExample> {
  const total = new Map<RefusedReason, number>();
  const first = new Map<RefusedReason, string>();
  const visit = (node: NormalizedBookmarkNode, special: boolean, selected: boolean, privateLocal: boolean): void => {
    const inSelected = selected || boundary.selectedNative.has(node.nativeId);
    const inPrivate = privateLocal || boundary.privateNative.has(node.nativeId);
    if (!special && !node.managed && inSelected && !inPrivate) {
      const reason = bookmarkRepresentability({ type: node.kind, title: node.title,
        ...(node.url === undefined ? {} : { url: node.url }) });
      if (reason !== 'supported') {
        total.set(reason, (total.get(reason) ?? 0) + 1);
        const text = first.has(reason) ? '' : exampleText(node);
        if (text) first.set(reason, text);
      }
    }
    for (const child of node.children) visit(child, false, inSelected, inPrivate);
  };
  for (const root of roots) visit(root, root.rootKind !== 'browser_root', false, false);
  const examples = new Map<RefusedReason, PublicIngressExample>();
  for (const [reason, text] of first) examples.set(reason, { text, others: (total.get(reason) ?? 1) - 1 });
  return examples;
}

type Store = ReturnType<typeof createSyncStateStore>;

/** The worker side: the ingress boundary, one tree read, then the pure walk. Throws are the caller's to absorb. */
export async function readIngressExamples(store: Store, scope: SyncScope,
  readTree: () => Promise<{ readonly roots: readonly NormalizedBookmarkRoot[] }>,
): Promise<ReadonlyMap<RefusedReason, PublicIngressExample>> {
  const boundary = await resolveIngressBoundary(store, scope);
  if (boundary.selectedNative.size === 0) return new Map();
  return ingressExamples((await readTree()).roots, boundary);
}
