import { createIcon } from '../icons.js';
import { el, emptyBlock } from '../library-dom.js';
import { t, tn } from '../i18n.js';
import { when } from '../subscriptions-ui/dom.js';
import type { ActivityItem } from './activity-types.js';
import type { AutomationServerView } from './messages.js';
import { serverFreshness } from './status-ui.js';

/** The same plain sentences as the web inbox. Names are server-resolved owner metadata. */
export function activityTitle(item: ActivityItem): string {
  if (item.kind === 'agent_bookmarks_added') {
    const agent = item.agent?.name || t('automation_activityAgent', 'An agent');
    const folder = item.folders[0]?.title || item.collection?.title || t('automation_activityLibrary', 'your library');
    const added = tn('automation_activityAdded', item.count, '$2 added $1 bookmark to $3', '$2 added $1 bookmarks to $3', agent, folder);
    return item.folders.length > 1 ? t('automation_activityMoreFolders', '$1 and $2 more folders', added, item.folders.length - 1) : added;
  }
  const name = item.run?.ruleName || t('automation_activityRule', 'A rule');
  switch (item.kind) {
    case 'run_completed': return t('automation_activityFinished', '$1 finished', name);
    case 'run_partial': return t('automation_activityPartial', '$1 partly finished', name);
    case 'run_failed': return t('automation_activityFailed', '$1 failed', name);
    case 'run_attention': return t('automation_activityAttention', '$1 needs your decision', name);
  }
}

/** A preview only: read state changes on the web inbox. */
export function activityPanel(server: AutomationServerView, webUrl: string | null): HTMLElement {
  const panel = el('div', undefined, 'automation-panel');
  panel.append(el('p', t('automation_activityLede', 'New bookmarks from your agents and updates on their work.'), 'automation-panel-lede'));
  const activity = server.activity!;
  const latest = activity.latest;
  if (latest) {
    const list = el('ul', undefined, 'automation-rules');
    const row = el('li', undefined, 'list-row automation-run');
    const tile = el('span', undefined, 'favicon-tile automation-run-glyph');
    tile.append(createIcon(latest.kind === 'agent_bookmarks_added' ? 'bookmark' : latest.kind === 'run_completed' ? 'check' : 'alert', 16));
    if (latest.kind === 'run_failed') tile.dataset.tone = 'danger';
    if (latest.kind === 'run_partial' || latest.kind === 'run_attention') tile.dataset.tone = 'warning';
    const main = el('div', undefined, 'list-row-main');
    main.append(el('p', activityTitle(latest), 'list-row-title'));
    const meta = el('p', undefined, 'list-row-meta');
    if (latest.run && latest.count) meta.append(el('span', tn('automation_activityDigests', latest.count, '$1 new digest', '$1 new digests')), el('span', undefined, 'sep'));
    meta.append(when(Date.parse(latest.updatedAt)));
    main.append(meta);
    if (latest.items.length) main.append(el('p', latest.items.map((item) => item.title || item.host).filter(Boolean).join(' · '), 'list-row-meta'));
    row.append(tile, main);
    if (latest.state === 'unread') {
      const tail = el('div', undefined, 'list-row-tail');
      const badge = el('span', t('automation_runNew', 'New'), 'badge'); badge.dataset.tone = 'accent';
      tail.append(badge); row.append(tail);
    }
    list.append(row); panel.append(list);
  } else panel.append(emptyBlock({ icon: 'check', title: t('automation_activityEmptyTitle', 'No activity yet'),
    hint: t('automation_activityEmptyHint', 'Updates appear here when an agent adds bookmarks or finishes work.') }));
  if (webUrl) {
    const link = el('a', undefined, 'btn btn-secondary btn-sm');
    link.href = new URL('/activity', webUrl).href; link.target = '_blank'; link.rel = 'noreferrer';
    link.append(el('span', t('automation_activityOpenWeb', 'Open on the web')), createIcon('arrow-up-right', 14));
    const foot = el('div', undefined, 'automation-panel-lede'); foot.append(link); panel.append(foot);
  }
  panel.append(serverFreshness({ ...server, fetchedAt: activity.fetchedAt, problem: server.activityProblem ?? null }));
  return panel;
}
