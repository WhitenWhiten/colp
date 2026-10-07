import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DataTable, DataTableCell, DataTableRow, type DataTableColumn } from './DataTable'
import { FilterRail } from './FilterRail'

/* Moderation lists (my reports / my appeals / admin cases / admin appeals)
   share the Link health row anatomy: subject + meta, reason, status chip
   with its outcome note, and an optional decision column. Styles live in
   styles/moderation.css, imported by each moderation page. */

const COLUMNS: DataTableColumn[] = [
  { key: 'subject', label: 'Target' },
  { key: 'reason', label: 'Reason' },
  { key: 'status', label: 'Status' },
]

export function ModerationTable({ label, testId, subjectLabel = 'Target', actionsLabel, children }: {
  label: string
  testId: string
  subjectLabel?: string
  /** Adds a fourth, labelled column for row decisions. */
  actionsLabel?: string
  children: ReactNode
}) {
  const columns = [{ ...COLUMNS[0]!, label: subjectLabel }, ...COLUMNS.slice(1)]
  if (actionsLabel) columns.push({ key: 'actions', label: actionsLabel })
  return (
    <DataTable
      className={actionsLabel ? 'moderation-table moderation-table--actions' : 'moderation-table'}
      label={label}
      columns={columns}
      data-testid={testId}
    >
      {children}
    </DataTable>
  )
}

export function ModerationRow({ title, href, meta, reason, detail, status, note, actions }: {
  title: string
  href?: string | null
  meta?: ReactNode
  reason?: ReactNode
  detail?: ReactNode
  status: ReactNode
  note?: ReactNode
  actions?: ReactNode
}) {
  return (
    <DataTableRow className="moderation-row">
      <DataTableCell className="moderation-subject">
        <strong>{href ? <Link to={href}>{title}</Link> : title}</strong>
        {meta ? <span>{meta}</span> : null}
      </DataTableCell>
      <DataTableCell className="moderation-reason">
        {reason ? <strong>{reason}</strong> : null}
        {detail ? <p>{detail}</p> : null}
      </DataTableCell>
      <DataTableCell className="moderation-status">
        {status}
        {note ? <p>{note}</p> : null}
      </DataTableCell>
      {actions !== undefined ? <DataTableCell className="moderation-actions">{actions}</DataTableCell> : null}
    </DataTableRow>
  )
}

export function ModerationStatusFilter<T extends string>({ value, options, onChange }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="moderation-toolbar">
      <FilterRail className="moderation-filters" label="Filter by status" value={value} options={options} onChange={onChange} />
    </div>
  )
}
