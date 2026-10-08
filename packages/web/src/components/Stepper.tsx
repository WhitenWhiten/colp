import type { ReactNode } from 'react'

/** One numbered step. `index` overrides the rendered numeral (the extension
    page shows zero-padded '01'); the list position is the default. */
export type StepperItem = {
  key?: string
  index?: ReactNode
  title?: ReactNode
  body: ReactNode
}

type StepperProps = {
  items: ReadonlyArray<StepperItem>
  /** Accessible name on the <ol> — e.g. "Setup steps". */
  label?: string
  className?: string
}

/**
 * Shared numbered-step list (R10-18): serif index + title/body cells — the
 * anatomy Extension's setup steps already had, now shared so Import's
 * hand-off steps get the same structure instead of a bare <ol>.
 */
export function Stepper({ items, label, className }: StepperProps) {
  return (
    <ol
      className={className ? `stepper ${className}` : 'stepper'}
      {...(label ? { 'aria-label': label } : {})}
    >
      {items.map((item, position) => (
        <li key={item.key ?? position} className="stepper-step">
          <span className="stepper-index" aria-hidden>{item.index ?? position + 1}</span>
          <div className="stepper-body">
            {item.title != null ? <h3 className="stepper-title">{item.title}</h3> : null}
            {typeof item.body === 'string' ? <p className="stepper-text">{item.body}</p> : item.body}
          </div>
        </li>
      ))}
    </ol>
  )
}
