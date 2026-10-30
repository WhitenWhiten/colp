import { displayHost } from '../bookmark-manager-dom.js';
import { createIcon, type IconName } from '../icons.js';
import { el, emptyBlock } from '../library-dom.js';
import { t, tn } from '../i18n.js';
import { when } from '../subscriptions-ui/dom.js';
import type { ActivityItem, ActivityKind } from './activity-types.js';
import type { AutomationServerView } from './messages.js';
import { serverFreshness } from './status-ui.js';

/** The web inbox's glyphs: tone only for a problem, as on the run rows. */
const GLYPH: Record<ActivityKind, [IconName, 'warning' | 'danger' | undefined]> = {
  agent_bookmarks_added: ['bookmark', undefined],
  agent_nodes_updated: ['bookmark', undefined], agent_nodes_moved: ['folder', undefined], agent_nodes_deleted: ['bookmark', undefined],
  run_completed: ['check', undefined],
  run_partial: ['alert', 'warning'],
  run_failed: ['alert', 'danger'],
  run_attention: ['alert', 'warning'],
  approval_requested: ['alert', 'warning'],
};

/** The same plain sentences as the web inbox. Names are server-resolved owner metadata. */
export function activityTitle(item: ActivityItem): string {
  if (item.kind === 'approval_requested') {
    return t('automation_activityApproval', '$1 wants your approval', item.agent?.name || t('automation_activityAgent', 'An agent'));
  }
  if (item.kind === 'agent_nodes_updated') return tn('automation_activityAgentUpdated', item.count, '$1 updated $2 item', '$1 updated $2 items', item.agent?.name || t('automation_unknownAgent', 'An agent'), item.count);
  if (item.kind === 'agent_nodes_moved') return tn('automation_activityAgentMoved', item.count, '$1 moved $2 item', '$1 moved $2 items', item.agent?.name || t('automation_unknownAgent', 'An agent'), item.count);
  if (item.kind === 'agent_nodes_deleted') return tn('automation_activityAgentDeleted', item.count, '$1 deleted $2 item', '$1 deleted $2 items', item.agent?.name || t('automation_unknownAgent', 'An agent'), item.count);
  if (item.kind === 'agent_bookmarks_added') {
    const agent = item.agent?.name || t('automation_activityAgent', 'An agent');
    const folder = item.folders[0]?.title || item.collection?.title || t('automation_activityLibrary', 'your library');
    const added = tn('automation_activityAdded', item.count, '$2 added $1 bookmark to $3', '$2 added $1 bookmarks to $3', agent, folder);
    const more = item.folders.length - 1;
    return more > 0 ? tn('automation_activityMoreFolders', more, '$2 and $1 more folder', '$2 and $1 more folders', added) : added;
  }
  const name = item.run?.ruleName || t('automation_activityRule', 'A rule');
  switch (item.kind) {
    case 'run_completed': return t('automation_activityFinished', '$1 finished', name);
    case 'run_partial': return t('automation_activityPartial', '$1 partly finished', name);
    case 'run_failed': return t('automation_activityFailed', '$1 failed', name);
    case 'run_attention': return item.run?.status === 'uncertain'
      ? t('automation_activityUncertain', '$1 has an unknown result. Review before retrying.', name)
      : t('automation_activityAttention', '$1 needs your decision', name);
  }
}

/**
 * A preview only: the newest item, as a row that opens the web inbox, where
 * reading happens (as the toolbar count and the popup's Open do). Nothing
 * here marks anything read.
 */
export function activityPanel(server: AutomationServerView, webUrl: string | null): HTMLElement {
  const panel = el('div', undefined, 'automation-panel');
  panel.append(el('p', t('automation_activityLede', 'New bookmarks from your agents, finished work, and decisions waiting for you.'), 'automation-panel-lede'));
  const activity = server.activity!;
  const latest = activity.latest;
  if (latest) {
    const list = el('ul', undefined, 'automation-rules automation-inbox');
    const item = el('li');
    const row = webUrl ? el('a', undefined, 'list-row automation-inbox-item') : el('div', undefined, 'list-row automation-inbox-item');
    if (row instanceof HTMLAnchorElement) { row.href = new URL('/activity', webUrl!).href; row.target = '_blank'; row.rel = 'noreferrer'; }
    const [glyph, tone] = GLYPH[latest.kind];
    const tile = el('span', undefined, 'favicon-tile automation-run-glyph'); tile.append(createIcon(glyph, 16));
    if (tone) tile.dataset.tone = tone;
    const main = el('div', undefined, 'list-row-main');
    const title = el('p', activityTitle(latest), 'list-row-title'); title.title = title.textContent ?? '';
    const meta = el('p', undefined, 'list-row-meta');
    if (latest.run && latest.count) meta.append(el('span', tn('automation_activityDigests', latest.count, '$1 new digest', '$1 new digests')), el('span', undefined, 'sep'));
    meta.append(when(Date.parse(latest.updatedAt)));
    main.append(title, meta);
    // A waiting plan reads as its own summary, never the agent's note.
    const samples = latest.plan?.summary
      || latest.items.map((member) => member.title || (member.host && displayHost(member.host))).filter(Boolean).join(' · ');
    if (samples) { const line = el('p', undefined, 'list-row-meta'); line.append(el('span', samples, 'grow')); main.append(line); }
    const tail = el('div', undefined, 'list-row-tail');
    if (latest.state === 'unread') { const badge = el('span', t('automation_runNew', 'New'), 'badge'); badge.dataset.tone = 'accent'; tail.append(badge); }
    if (webUrl) tail.append(createIcon('arrow-up-right', 14));
    row.append(tile, main, tail);
    item.append(row); list.append(item); panel.append(list);
  } else panel.append(emptyBlock({ icon: 'bell', title: t('automation_activityEmptyTitle', 'No activity yet'),
    hint: t('automation_activityEmptyHint', 'When an agent adds bookmarks or a rule finishes work, you’ll see it here.') }));
  panel.append(serverFreshness({ ...server, fetchedAt: activity.fetchedAt, problem: server.activityProblem ?? null }));
  return panel;
}
