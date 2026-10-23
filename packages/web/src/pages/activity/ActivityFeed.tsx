import { Link } from 'react-router-dom'
import type { ActivityItem, ActivityKind } from '../../api/activityTypes'
import { Icon, type IconName } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDate, formatDateTime, formatRelative } from '../../lib/formatDate'
import { plural } from '../../lib/plural'

const OUTCOME: Record<Exclude<ActivityKind, 'agent_bookmarks_added'>, string> = {
  run_completed: 'finished', run_partial: 'partly finished', run_failed: 'failed', run_attention: 'needs your decision',
}
const ICON: Record<ActivityKind, IconName> = {
  agent_bookmarks_added: 'bookmark', run_completed: 'check', run_partial: 'alert', run_failed: 'alert', run_attention: 'pause',
}

function destination(item: ActivityItem): string | null {
  if (item.run) return `/automations/runs/${encodeURIComponent(item.run.id)}`
  if (!item.collection) return null
  const folder = item.folders[0]
  return `/library/${encodeURIComponent(item.collection.id)}${folder ? `?folder=${encodeURIComponent(folder.nodeId)}` : ''}`
}

function sentence(item: ActivityItem): string {
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

export function ActivityFeed({ items }: { items: readonly ActivityItem[] }) {
  const groups = new Map<string, ActivityItem[]>()
  for (const item of items) {
    const key = day(item.updatedAt)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return (
    <div className="activity-feed">
      {[...groups].map(([label, entries]) => (
        <section className="automations-section" aria-label={label} key={label}>
          <h2 className="activity-day">{label}</h2>
          <ol className="activity-list">
            {entries.map((item) => {
              const href = destination(item)
              const title = sentence(item)
              return (
                <li key={item.id}>
                  <article className="activity-item" data-activity-id={item.id} data-kind={item.kind} data-unread={item.state === 'unread' ? 'true' : undefined}>
                    <span className="activity-icon" data-kind={item.kind} aria-hidden><Icon name={ICON[item.kind]} /></span>
                    <div className="activity-body">
                      <header className="activity-item-head">
                        <h3>{href ? <Link className="activity-title" to={href}>{title}</Link> : title}</h3>
                        {item.state === 'unread' && <StatusBadge tone="accent">New</StatusBadge>}
                      </header>
                      <p className="automation-meta">
                        {item.kind !== 'agent_bookmarks_added' && item.count > 0 && <>{plural(item.count, 'new digest')} · </>}
                        <time dateTime={item.updatedAt} title={formatDateTime(item.updatedAt)}>{formatRelative(item.updatedAt)}</time>
                      </p>
                      {item.kind === 'agent_bookmarks_added' && item.items.length > 0 && (
                        <ul className="activity-samples" aria-label="Recent bookmarks">
                          {item.items.slice(0, 5).map((member) => (
                            <li key={member.nodeId}>
                              <span>{member.title || member.host || 'Untitled bookmark'}</span>
                              {member.title && member.host && <span className="activity-host">{member.host}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {item.kind === 'agent_bookmarks_added' && item.folders.length > 1 && (
                        <p className="activity-folders">
                          {item.folders.map((folder) => (
                            <span key={folder.nodeId}>
                              <Icon name="folder" />
                              {item.collection ? <Link to={`/library/${encodeURIComponent(item.collection.id)}?folder=${encodeURIComponent(folder.nodeId)}`}>{folder.title || 'Untitled folder'}</Link> : folder.title || 'Untitled folder'}
                              <span className="activity-folder-count">{folder.count}</span>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  </article>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
