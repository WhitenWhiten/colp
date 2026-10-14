import { createIcon } from '../icons.js';
import { el } from '../library-dom.js';
import { t, tn } from '../i18n.js';
import { when } from '../subscriptions-ui/dom.js';
import type { AutomationPlacementView, AutomationRunView, AutomationServerRuleView, AutomationServerView } from './messages.js';

/**
 * Words for automation state on extension pages, in the web's vocabulary.
 *
 * Two things are kept apart. A placement is what this browser did: it filed a
 * bookmark, and the server later confirms it. A run is what the server did
 * with it afterwards. A failed summary never makes a placement look failed, and
 * a filed bookmark never makes a run look done. Every state shown is the one
 * the server or the receipt reports; nothing here decides what happens next,
 * and nothing claims that spending, delivery or an approval happened here.
 */
type Tone = 'warning' | 'danger' | 'accent' | undefined;

function badge(label: string, tone: Tone): HTMLElement {
  const node = el('span', label, 'badge');
  if (tone) node.dataset.tone = tone;
  return node;
}

/** One badge per row, and only while a placement is pending or wrong; a confirmed one needs none. */
export function placementBadge(state: AutomationPlacementView['state']): HTMLElement | null {
  switch (state) {
    case 'waitingForSync': return badge(t('automation_placementWaiting', 'Waiting for sync'), undefined);
    case 'review': return badge(t('automation_placementReview', 'Needs review'), 'warning');
    case 'rejected': return badge(t('automation_placementRejected', 'Not accepted'), 'danger');
    case 'attention': return badge(t('automation_placementAttention', 'Couldn’t confirm'), 'warning');
    case 'confirmed': return null;
  }
}

const RUN_STATUS: Record<AutomationRunView['status'], () => [string, Tone]> = {
  waiting: () => [t('automation_runWaiting', 'Waiting'), undefined],
  running: () => [t('automation_runRunning', 'Running'), undefined],
  review: () => [t('automation_runReview', 'Needs a decision'), 'warning'],
  completed: () => [t('automation_runDone', 'Done'), undefined],
  partial: () => [t('automation_runPartial', 'Partly done'), 'warning'],
  blocked: () => [t('automation_runBlocked', 'Blocked'), 'danger'],
  cancelled: () => [t('automation_runCancelled', 'Cancelled'), undefined],
  failed: () => [t('automation_runFailed', 'Failed'), 'danger'],
};

/**
 * The run's own state. A result the server reports unread says New (AW-60); an
 * explicit hold says so instead, since nothing moves until the Owner decides.
 */
export function runBadge(run: Pick<AutomationRunView, 'status' | 'held'> & Partial<Pick<AutomationRunView, 'unread' | 'outputCount'>>): HTMLElement {
  if (run.unread && run.outputCount) return badge(t('automation_runNew', 'New'), 'accent');
  if (run.held && run.status !== 'completed' && run.status !== 'cancelled' && run.status !== 'failed') {
    return badge(t('automation_runHeld', 'On hold'), 'warning');
  }
  const [label, tone] = RUN_STATUS[run.status]();
  return badge(label, tone);
}

const RUN_KIND: Record<AutomationRunView['kind'], () => string> = {
  intake: () => t('automation_runKindIntake', 'New bookmark'),
  batch: () => t('automation_runKindBatch', 'Batch'),
  manual: () => t('automation_runKindManual', 'Run once'),
};

/* The server's fixed sentences, in the Owner's words (the web's wording). Anything else is shown as sent. */
const EXPLANATIONS: Record<string, () => string> = {
  'Matched the pinned rule and moved from the default root to its verified canonical destination.': () => t('automation_explainMoved', 'Moved into the rule’s folder.'),
  'Already in the verified destination; no canonical mutation required.': () => t('automation_explainAlreadyThere', 'Already in the rule’s folder, so nothing moved.'),
  'A compatible rule already committed this placement.': () => t('automation_explainOtherRule', 'Another rule already put it there.'),
  'Collection exceeds the existing version-history capacity; no placement was committed.': () => t('automation_explainOverHistory', 'Not moved: the collection is over the version-history limit.'),
  'Destination unavailable.': () => t('automation_explainDestinationUnavailable', 'Not moved: the rule’s folder is unavailable.'),
  'Current Owner authority is unavailable.': () => t('automation_explainOwnerOnly', 'Not moved: only the collection’s owner can run this rule.'),
  'Cancelled by the Owner; recorded effects are retained.': () => t('automation_explainCancelled', 'Cancelled by you. Anything already done stays.'),
  'Explicit hold: awaiting an Owner decision to continue the original pinned work.': () => t('automation_explainOnHold', 'On hold until you decide to continue.'),
  'Canonical device placement verified against the pinned rule and binding.': () => t('automation_explainDevicePlacement', 'Placed by your browser, and confirmed by the server.'),
  'The pinned rule matched; no placement effect was required.': () => t('automation_explainNothingToMove', 'Matched, and nothing needed to move.'),
  'Equal-priority rules selected incompatible destinations; the original location was preserved.': () => t('automation_explainRulesDisagree', 'Rules with the same priority chose different folders, so the bookmark stayed where you saved it.'),
  'No retained execution explanation is available.': () => t('automation_explainNoDetails', 'No details were kept for this run.'),
  'Required binding unavailable; keep original parent.': () => t('automation_explainBindingUnavailable', 'The rule’s folder is unavailable, so the bookmark stayed where you saved it.'),
  'Intake destination unavailable.': () => t('automation_explainIntakeUnavailable', 'The rule’s folder is unavailable.'),
  'Outside rule scope, source policy, trigger or hop bound.': () => t('automation_explainOutsideScope', 'Outside what this rule looks at.'),
  'Deferred: the immutable source lacks usable input. The original rule, binding and event remain pinned; a newer live bookmark is never substituted. No effect is authorized. The Owner may cancel this deferred run.':
    () => t('automation_explainDeferred', 'Waiting: the bookmark was missing details this rule needs. Nothing was changed; you can cancel it.'),
  'Review required: the immutable source lacks usable input. No effect was authorized; a later bookmark edit does not replace this source.':
    () => t('automation_explainMissingInput', 'The bookmark was missing details this rule needs, so nothing was changed.'),
};

/** What the run did, in the Owner's words; the run's kind when the server gave no explanation. */
export function runTitle(run: Pick<AutomationRunView, 'explanation' | 'kind'>): string {
  const text = run.explanation;
  if (!text) return RUN_KIND[run.kind]();
  const known = EXPLANATIONS[text];
  if (known) return known();
  if (text.startsWith('Waiting to place in canonical folder ')) return t('automation_explainWaitingToPlace', 'Waiting to move it into the rule’s folder.');
  if (text.startsWith('A higher-priority rule selected canonical folder ')) return t('automation_explainHigherPriority', 'A higher-priority rule chose another folder, so this one did not run.');
  return text;
}

/** A run as one row: what it did, which rule and when, its state; the row opens the run on the web. */
export function runRow(run: AutomationRunView): HTMLElement {
  const item = el('li');
  const link = el('a', undefined, 'list-row automation-run');
  link.href = run.url; link.target = '_blank'; link.rel = 'noreferrer';
  link.dataset.runId = run.id; link.dataset.status = run.status;
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('play', 16));
  const main = el('div', undefined, 'list-row-main');
  const title = el('p', runTitle(run), 'list-row-title'); title.title = run.explanation ?? title.textContent ?? '';
  const meta = el('p', undefined, 'list-row-meta');
  meta.append(el('span', run.ruleName ? t('automation_placementRule', 'Rule “$1”', run.ruleName) : t('automation_runSomeRule', 'A rule'), 'grow'),
    el('span', undefined, 'sep'), when(run.at));
  if (run.kind !== 'intake') meta.append(el('span', undefined, 'sep'), el('span', RUN_KIND[run.kind]()));
  main.append(title, meta);
  const tail = el('div', undefined, 'list-row-tail');
  tail.append(runBadge(run), createIcon('arrow-up-right', 14));
  link.append(tile, main, tail);
  item.append(link);
  return item;
}

/** A rule's state on the server, only when it is not simply on. */
export function ruleServerBadge(state: AutomationServerRuleView['state']): HTMLElement | null {
  switch (state) {
    case 'degraded': return badge(t('automation_ruleDegraded', 'On, with problems'), 'warning');
    case 'blocked': return badge(t('automation_ruleBlocked', 'Blocked'), 'danger');
    case 'paused': return badge(t('automation_rulePaused', 'Paused'), 'warning');
    case 'draft': return badge(t('automation_ruleDraft', 'Draft'), undefined);
    case 'archived': return badge(t('automation_ruleArchived', 'Archived'), undefined);
    case 'active': return null;
  }
}

/** The server's counts of work waiting on this rule, and its words for the cost; null when there is nothing to say. */
export function ruleServerMeta(rule: AutomationServerRuleView): HTMLElement | null {
  const parts: string[] = [];
  if (rule.waiting) parts.push(tn('automation_ruleJobsWaiting', rule.waiting, '$1 job waiting for an agent', '$1 jobs waiting for an agent'));
  if (rule.held) parts.push(tn('automation_ruleJobsHeld', rule.held, '$1 held by a limit', '$1 held by a limit'));
  if (rule.approvals) parts.push(tn('automation_ruleJobsApproval', rule.approvals, '$1 needs your approval', '$1 need your approval'));
  if (rule.cost) parts.push(rule.cost);
  if (!parts.length) return null;
  const meta = el('p', undefined, 'list-row-meta');
  meta.append(createIcon('server', 12));
  parts.forEach((part, index) => { if (index) meta.append(el('span', undefined, 'sep')); meta.append(el('span', part, index === parts.length - 1 ? 'grow' : undefined)); });
  return meta;
}

/** How fresh the server's status is, said plainly; a failed read keeps showing what was last seen, with its age. */
export function serverFreshness(server: AutomationServerView): HTMLElement {
  const line = el('p', undefined, 'automation-freshness'), words = el('span');
  const at = (copy: string) => { const [before = '', after = ''] = copy.split('\u0000'); words.append(before, when(server.fetchedAt), after); };
  if (!server.problem) {
    if (server.fetchedAt) at(t('automation_serverUpdatedAt', 'Updated $1.', '\u0000'));
    else words.append(t('automation_serverChecking', 'Checking your server…'));
    line.append(words);
    return line;
  }
  line.dataset.tone = 'warning';
  if (server.problem === 'signedOut') {
    if (server.fetchedAt) at(t('automation_serverSignedOutAt', 'Sign in on the web in this browser to update this. Showing what your server said $1.', '\u0000'));
    else words.append(t('automation_serverSignedOut', 'Sign in on the web in this browser to see what your server is doing.'));
  } else if (server.problem === 'invalid') {
    if (server.fetchedAt) at(t('automation_serverInvalidAt', 'Your server sent something this browser couldn’t read. Showing what it said $1.', '\u0000'));
    else words.append(t('automation_serverInvalid', 'Your server sent something this browser couldn’t read.'));
  } else if (server.fetchedAt) at(t('automation_serverUnreachableAt', 'Couldn’t reach your server. Showing what it said $1.', '\u0000'));
  else words.append(t('automation_serverUnreachable', 'Couldn’t reach your server. Saving and filing here don’t need it.'));
  line.append(createIcon('alert', 12), words);
  return line;
}
