import type {
  Phase4bMcpDeleteSubtreeFacts, Phase4bMcpMovePlacement, Phase4bMcpPlanOperation,
} from './change-plan-planner.js';

/*
 * The sentences an owner reads on the Approvals page and an agent gets back
 * with its plan. They are built from the titles a plan writes and the stored
 * folder paths, never from the agent's reason.
 */

export function phase4bMcpMoveImpactText(
  placement: Readonly<Pick<Phase4bMcpMovePlacement, 'title' | 'fromPath' | 'toPath'>>,
): string {
  return `move ${placement.title} from ${placement.fromPath} to ${placement.toPath}`;
}

export function phase4bMcpCreateImpactText(
  node: Readonly<{ kind: string; title?: string | null; url?: string | null }>,
  parentPath?: string,
): string {
  const name = node.title || node.url || 'an untitled item';
  if (node.kind === 'folder') return `create folder ${name}${parentPath ? ` in ${parentPath}` : ''}`;
  return `add ${name}${parentPath ? ` to ${parentPath}` : ''}`;
}

export function phase4bMcpDeleteSubtreeImpactText(
  facts: Readonly<Pick<Phase4bMcpDeleteSubtreeFacts, 'title' | 'subtreeCount' | 'parentPath'>>,
): string {
  const from = facts.parentPath ? ` from ${facts.parentPath}` : '';
  return `delete ${facts.title}${from} (${facts.subtreeCount} ${facts.subtreeCount === 1 ? 'item' : 'items'})`;
}

/** A collection's visibility change, worded as the Approvals page labels it. */
export function phase4bMcpVisibilityImpactText(collectionName: string, visibility: string): string {
  return visibility === 'public' ? `publish ${collectionName}` : `make ${collectionName} ${visibility}`;
}

/** A stored folder path as the state resolvers write it: absolute, single-line, bounded. */
export function isPlanFolderPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 1_024 && !/[\u0000-\u001F\u007F]/u.test(value);
}

const PLAN_SUMMARY_MAX = 512;

/**
 * A plan's headline when every operation carries a sentence: one change is
 * its sentence; several are counted, and each keeps its sentence in the
 * plan's operations, which the approval rows show. Undefined otherwise.
 */
export function describedPlanSummary(operations: readonly Phase4bMcpPlanOperation[]): string | undefined {
  const described = operations.map((operation) => (operation as { readonly impact?: unknown }).impact);
  if (!described.every((text): text is string => typeof text === 'string' && text.length > 0)) return undefined;
  return planHeadline(operations.length === 1 ? described[0]! : countedPlanSummary(operations));
}

/** A sentence as a plan summary: capitalized and cut to the summary limit. */
export function planHeadline(sentence: string): string {
  const capitalized = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return capitalized.length <= PLAN_SUMMARY_MAX ? capitalized : `${capitalized.slice(0, PLAN_SUMMARY_MAX - 1)}…`;
}

/** "create a folder, add 3 bookmarks and move 2 items", in the plan's order. A delete counts what it removes. */
function countedPlanSummary(operations: readonly Phase4bMcpPlanOperation[]): string {
  const counts = new Map<string, { readonly verb: string; readonly noun: string; count: number }>();
  for (const operation of operations) {
    const kind = operation.type === 'create_node' ? operation.payload.node.kind : null;
    const [verb, noun] = operation.type === 'move_node' ? ['move', 'item']
      : operation.type === 'delete_subtree' ? ['delete', 'item']
        : kind === 'folder' ? ['create', 'folder'] : kind === 'bookmark' ? ['add', 'bookmark'] : ['add', 'item'];
    const added = operation.type === 'delete_subtree' && 'subtreeCount' in operation ? operation.subtreeCount : 1;
    const entry = counts.get(`${verb} ${noun}`);
    if (entry) entry.count += added;
    else counts.set(`${verb} ${noun}`, { verb, noun, count: added });
  }
  const phrases = [...counts.values()].map(({ verb, noun, count }) =>
    `${verb} ${count === 1 ? `${noun === 'item' ? 'an' : 'a'} ${noun}` : `${count} ${noun}s`}`);
  return phrases.length === 1 ? phrases[0]! : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}
