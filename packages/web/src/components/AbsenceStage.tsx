import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../lib/useDocumentTitle'

/** Four corner labels, same cadence as the 404 frame ("404 / Page / Not / Found"). */
export const ABSENCE_CORNERS = {
  collection: ['Collection', 'Page', 'Not', 'Here'],
  path: ['Path', 'Page', 'Not', 'Here'],
  profile: ['Profile', 'Page', 'Not', 'Here'],
  digest: ['Digest', 'Page', 'Not', 'Here'],
  issue: ['Issue', 'Page', 'Not', 'Here'],
  resource: ['Bookmark', 'Page', 'Not', 'Here'],
  comment: ['Comment', 'Page', 'Not', 'Here'],
} as const

export type AbsenceExit =
  | { label: string; to: string }
  | { label: string; onClick: () => void }

const CORNER_PLACEMENT = ['tl', 'tr', 'bl', 'br'] as const

/**
 * Full-page absence poster. Shares the 404 stage — serif italic title in the
 * digit field, mono corners, one sentence and text exits along the bottom —
 * without claiming the route itself is missing.
 */
export function AbsenceStage({
  title,
  description,
  exits = [],
  corners,
  role = 'status',
  testId = 'absence-stage',
}: {
  title: string
  description?: ReactNode
  exits?: readonly AbsenceExit[]
  corners: readonly [string, string, string, string]
  role?: 'status' | 'alert'
  testId?: string
}) {
  useDocumentTitle(title)
  return (
    <div className="not-found-stage" role={role} data-testid={testId}>
      <h1 className="not-found-title not-found-mark">{title}</h1>
      <div className="not-found-foot">
        {description ? <p className="not-found-lede">{description}</p> : null}
        {exits.length > 0 ? (
          <nav className="not-found-exits" aria-label="Start points">
            {exits.flatMap((exit, index) => {
              const control = 'to' in exit
                ? (
                  <Link key={exit.label} className="not-found-exit" to={exit.to} data-testid="not-found-exit">
                    {exit.label}
                  </Link>
                )
                : (
                  <button key={exit.label} type="button" className="not-found-exit" onClick={exit.onClick}>
                    {exit.label}
                  </button>
                )
              if (index === 0) return [control]
              return [
                <span key={`${exit.label}-sep`} className="not-found-exit-sep" aria-hidden="true">·</span>,
                control,
              ]
            })}
          </nav>
        ) : null}
      </div>
      <div aria-hidden="true">
        {corners.map((label, index) => (
          <span
            key={CORNER_PLACEMENT[index]}
            className={`not-found-corner not-found-corner--${CORNER_PLACEMENT[index]}`}
            data-testid="not-found-corner"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
