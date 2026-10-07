import type { HTMLAttributes, ReactNode } from 'react'

/** One column: the columnheader label plus an optional class on the header
    cell (e.g. aligning a numeric or actions column). */
export type DataTableColumn = {
  key: string
  label: ReactNode
  className?: string
}

type DataTableProps = Omit<HTMLAttributes<HTMLDivElement>, 'role'> & {
  /** Accessible name — every ops table announces what it lists. */
  label: string
  columns: ReadonlyArray<DataTableColumn>
  children: ReactNode
}

/**
 * Shared ops table (R10-18): a div-grid with explicit table roles. The roles
 * carry the semantics — the ≤899px collapse in data-table.css switches rows
 * to display:block, which would strip a real <table>'s semantics but leaves
 * role="table"/"row"/"cell" intact.
 *
 * The surface owns its column template: set --data-table-cols on the host
 * class (e.g. .health-table { --data-table-cols: … }) — head and body rows
 * share it, so labels sit on the same grid as the cells they describe.
 */
export function DataTable({ label, columns, className, children, ...rest }: DataTableProps) {
  return (
    <div
      {...rest}
      className={className ? `data-table ${className}` : 'data-table'}
      role="table"
      aria-label={label}
    >
      <div className="data-table-head" role="rowgroup">
        <div className="data-table-row" role="row">
          {columns.map((column) => (
            <div
              key={column.key}
              role="columnheader"
              className={column.className ? `data-table-cell ${column.className}` : 'data-table-cell'}
            >
              {column.label}
            </div>
          ))}
        </div>
      </div>
      <div className="data-table-body" role="rowgroup">
        {children}
      </div>
    </div>
  )
}

type DataTableRowProps = Omit<HTMLAttributes<HTMLDivElement>, 'role'>

export function DataTableRow({ className, children, ...rest }: DataTableRowProps) {
  return (
    <div {...rest} className={className ? `data-table-row ${className}` : 'data-table-row'} role="row">
      {children}
    </div>
  )
}

type DataTableCellProps = Omit<HTMLAttributes<HTMLDivElement>, 'role'> & {
  /** Span all columns — URL reveals and intent messages under a row. */
  full?: boolean
}

export function DataTableCell({ className, full, children, ...rest }: DataTableCellProps) {
  const classes = ['data-table-cell', full ? 'data-table-cell--full' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <div {...rest} className={classes} role="cell">
      {children}
    </div>
  )
}
