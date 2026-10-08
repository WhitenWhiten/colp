import type { HTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'

type InboxItemProps = {
  /** Leading rail: an avatar mark, or a kind chip via `kind`. */
  mark?: ReactNode
  /** Kind label rendered as a .chip--kind pill in the leading rail. */
  kind?: string
  /** Primary line — the linked subject/title. */
  subject: ReactNode
  /** Secondary line under the subject — actor attribution or state text. */
  actor?: ReactNode
  /** Optional excerpt block. */
  body?: ReactNode
  /** Trailing meta column content — a <time> on timeline rows. */
  time?: ReactNode
  /** Paints the shared is-unread wash (Notifications). */
  unread?: boolean
  /** Action row at the end of the copy column. */
  actions?: ReactNode
  /** Whole-row link target (Today preview); omit for an article row. */
  to?: string
  className?: string
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>

/**
 * One timeline row for Feed, Notifications, and the Today preview — the
 * .result-row anatomy (mark rail, copy column, meta strip) shared with
 * Search rows. Hosts keep their containers (borderless feed stream,
 * bordered .notif-list, bare today rows) and pass host modifier classes;
 * day separators and unread state come in as props, not new anatomies.
 */
export function InboxItem({
  mark,
  kind,
  subject,
  actor,
  body,
  time,
  unread = false,
  actions,
  to,
  className,
  ...rest
}: InboxItemProps) {
  const leading = mark ?? (kind ? <span className="chip chip--kind">{kind}</span> : null)
  const classes = ['result-row']
  if (unread) classes.push('is-unread')
  if (className) classes.push(className)
  const content = (
    <>
      {leading}
      <div className="result-row-copy">
        <strong className="result-row-title">{subject}</strong>
        {actor}
        {body}
        {actions}
      </div>
      <div className="result-row-meta">{time}</div>
    </>
  )
  return to ? (
    <Link className={classes.join(' ')} to={to} {...rest}>
      {content}
    </Link>
  ) : (
    <article className={classes.join(' ')} {...rest}>
      {content}
    </article>
  )
}
