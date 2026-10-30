import { Link } from 'react-router-dom'
import type { ActivityItem, ActivityKind } from '../../api/activityTypes'
import { Icon, type IconName } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDate, formatDateTime, formatRelative } from '../../lib/formatDate'
import { displayHost } from '../../lib/libraryTree'
import { plural } from '../../lib/plural'
import { runPath } from '../automations/paths'

/* The owner's inbox: one bordered list per day, a glyph, the sentence, its
   details and a New state column. The glyph uses the run page's vocabulary
   and takes tone only for a problem, as the extension's Activity tab does.
   A decision waiting for the owner takes the attention glyph. */

const OUTCOME: Record<Exclude<ActivityKind, 'agent_bookmarks_added' | 'approval_requested'>, string> = {
  agent_nodes_updated: 'updated', agent_nodes_moved: 'moved', agent_nodes_deleted: 'deleted',
  run_completed: 'finished', run_partial: 'partly finished', run_failed: 'failed', run_attention: 'needs your decision',
}
const GLYPH: Record<ActivityKind, [IconName, 'warning' | 'danger' | undefined]> = {
  agent_bookmarks_added: ['bookmark', undefined],
  agent_nodes_updated: ['bookmark', undefined], agent_nodes_moved: ['folder', undefined], agent_nodes_deleted: ['bookmark', undefined],
  run_completed: ['check', undefined],
  run_partial: ['alert', 'warning'],
  run_failed: ['alert', 'danger'],
  run_attention: ['alert', 'warning'],
  approval_requested: ['alert', 'warning'],
}

function folderHref(collectionId: string, folderId?: string): string {
  return `/library/${encodeURIComponent(collectionId)}${folderId ? `?folder=${encodeURIComponent(folderId)}` : ''}`
}

function destination(item: ActivityItem): string | null {
  if (item.plan) return `/approvals/${encodeURIComponent(item.plan.id)}`
  if (item.run) return runPath(item.run.id)
  return item.collection ? folderHref(item.collection.id, item.folders[0]?.nodeId) : null
}

function sentence(item: ActivityItem): string {
  if (item.kind === 'approval_requested') return `${item.agent?.name || 'An agent'} wants your approval`
  if (['agent_nodes_updated', 'agent_nodes_moved', 'agent_nodes_deleted'].includes(item.kind)) return `${item.agent?.name || 'An agent'} ${OUTCOME[item.kind as keyof typeof OUTCOME]} ${plural(item.count, 'item')}`
  if (item.kind !== 'agent_bookmarks_added') return `${item.run?.ruleName || 'A rule'} ${OUTCOME[item.kind]}`
  const folder = item.folders[0]
  const extra = item.folders.length - 1
  return `${item.agent?.name || 'An agent'} added ${plural(item.count, 'bookmark')} to ${folder?.title || item.collection?.title || 'your library'}${extra > 0 ? ` and ${plural(extra, 'more folder')}` : ''}`
}

function day(value: string): string {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return 'Today'
  now.setDate(now.getDate() - 1)
  return date.toDateString() === now.toDateString() ? 'Yesterday' : formatDate(value)
}

function Entry({ item }: { item: ActivityItem }) {
  const href = destination(item)
  const title = sentence(item)
  const unread = item.state === 'unread'
  const [glyph, tone] = GLYPH[item.kind]
  const added = item.kind.startsWith('agent_')
  return (
    <article className="activity-item" data-activity-id={item.id} data-kind={item.kind} data-unread={unread ? 'true' : undefined}>
      <span className="activity-icon" data-tone={tone} aria-hidden><Icon name={glyph} /></span>
      <div className="activity-body">
        <h3 className="activity-title">{href ? <Link to={href}>{title}</Link> : title}</h3>
        <p className="automation-meta">
          {!added && item.count > 0 && <>{plural(item.count, 'new digest')} · </>}
          <time dateTime={item.updatedAt} title={formatDateTime(item.updatedAt)}>{formatRelative(item.updatedAt)}</time>
        </p>
        {item.plan && <p className="activity-plan" title={item.plan.summary}>{item.plan.summary}</p>}
        {added && item.items.length > 0 && (
          <ul className="activity-samples" aria-label="Recent bookmarks">
            {item.items.slice(0, 5).map((member) => (
              <li key={member.nodeId} title={member.title ?? undefined}>
                {member.title || (member.host && displayHost(member.host)) || 'Untitled bookmark'}
                {member.title && member.host && <>{' '}<span className="activity-host">{displayHost(member.host)}</span></>}
              </li>
            ))}
          </ul>
        )}
        {added && item.folders.length > 1 && (
          <div className="activity-folders">
            <Icon name="folder" />
            <ul aria-label="Folders">
              {item.folders.map((folder) => (
                <li key={folder.nodeId}>
                  {item.collection
                    ? <Link to={folderHref(item.collection.id, folder.nodeId)}>{folder.title || 'Untitled folder'}</Link>
                    : folder.title || 'Untitled folder'}
                  {'\u00a0'}<span className="activity-folder-count">{folder.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {unread && <StatusBadge tone="accent" className="activity-state">New</StatusBadge>}
    </article>
  )
}

export function ActivityFeed({ items }: { items: readonly ActivityItem[] }) {
  const groups = new Map<string, ActivityItem[]>()
  for (const item of items) {
    const key = day(item.updatedAt)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return (
    <div className="activity-feed">
      {[...groups].map(([label, entries]) => (
        <section className="activity-group" key={label}>
          <h2 className="activity-day">{label}</h2>
          <ol className="activity-list">
            {entries.map((item) => <li key={item.id}><Entry item={item} /></li>)}
          </ol>
        </section>
      ))}
    </div>
  )
}
