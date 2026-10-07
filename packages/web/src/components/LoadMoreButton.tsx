import type { ButtonHTMLAttributes, ReactNode } from 'react'

type LoadMoreButtonProps = {
  onClick: () => void
  loading: boolean
  disabled?: boolean
  busyLabel?: string
  children?: ReactNode
  /** Polite status text while loading. Omit to skip the live region. */
  status?: string
  /** When false (default), status uses .visually-hidden. When true, it stays visible. */
  statusVisible?: boolean
  className?: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-busy' | 'children' | 'className' | 'disabled' | 'onClick'>

export function LoadMoreButton({
  onClick,
  loading,
  disabled,
  busyLabel = 'Loading…',
  children = 'Load more',
  status,
  statusVisible = false,
  className = 'btn btn-secondary btn-sm',
  type = 'button',
  ...rest
}: LoadMoreButtonProps) {
  return (
    <>
      <button
        {...rest}
        type={type}
        className={className}
        onClick={onClick}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
      >
        {loading ? busyLabel : children}
      </button>
      {loading && status ? (
        <span role="status" className={statusVisible ? undefined : 'visually-hidden'}>{status}</span>
      ) : null}
    </>
  )
}
