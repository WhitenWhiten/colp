import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

export type FilterRailOption<T> = {
  value: T
  label: ReactNode
  /** Optional tooltip on the option (layout-mode hints, etc). */
  title?: string
  /** Extra class on the option button — rich-option anatomies like the
      classify suggestion cards keep their host styling. */
  className?: string
  /** Inert but visible — the option stays in the rail with aria-disabled
      instead of disappearing when it does not apply. */
  disabled?: boolean
}

type FilterRailProps<T> = {
  /** Accessible name. When `labelledBy` is set it wins — the visible
      element stays the single source of the group's name. */
  label: string
  /** id of a visible element naming the group (aria-labelledby). */
  labelledBy?: string
  /** data-testid on the radiogroup container. */
  testId?: string
  value: T
  options: Array<FilterRailOption<T>>
  onChange: (value: T) => void
  className?: string
  /** Wraps the option buttons (graph chip row). */
  optionsClassName?: string
  optionsTestId?: string
  /** Chip row (default) or segmented track used by sort/density. */
  variant?: 'chips' | 'segments'
  /** 'follow-focus' (default): arrow keys move focus AND select (APG radio).
      'manual': arrow keys only move focus; Space/Enter/click select. Use it
      whenever onChange triggers a server write. */
  selection?: 'follow-focus' | 'manual'
  children?: ReactNode
}

/* R9-20: every FilterRail is an APG radiogroup — arrow keys (both axes,
   shared-rail convention) roam and, by default, select with focus following
   selection, Home/End jump to the ends, and a roving tabindex keeps exactly
   one option in the Tab order. This is the same contract NodeAnnotationFields'
   VisibilitySwitch implements by hand. selection="manual" keeps the roam but
   leaves onChange to Space, Enter, or click. */
export function FilterRail<T>({
  label,
  labelledBy,
  testId,
  value,
  options,
  onChange,
  className,
  optionsClassName,
  optionsTestId,
  variant = 'chips',
  selection = 'follow-focus',
  children,
}: FilterRailProps<T>) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  optionRefs.current.length = options.length

  const selectedIndex = options.findIndex((option) => option.value === value)
  // When nothing matches (the value lives in a collapsed overflow, or the
  // group is settling), the first option keeps the group keyboard-reachable.
  const tabbable = selectedIndex >= 0 ? selectedIndex : 0

  /* The keydown lives on each radio (like VisibilitySwitch): composite
     radiogroups keep the container unfocused and roam among options, which
     jsx-a11y/interactive-supports-focus enforces. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const items = optionRefs.current.filter(
      (element): element is HTMLButtonElement => element !== null
        && !element.disabled
        && element.getAttribute('aria-disabled') !== 'true',
    )
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const selected = items.indexOf(optionRefs.current[tabbable] as HTMLButtonElement)
    const from = current >= 0 ? current : Math.max(selected, 0)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (from + 1) % items.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (from - 1 + items.length) % items.length
    } else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === null || next === from) return
    event.preventDefault()
    const option = options[optionRefs.current.indexOf(items[next]!)]
    if (selection === 'follow-focus' && option && option.value !== value) onChange(option.value)
    items[next]?.focus({ preventScroll: true })
  }

  const buttons = options.map((option, index) => (
    <button
      key={String(option.value ?? option.label)}
      ref={(element) => {
        optionRefs.current[index] = element
      }}
      type="button"
      className={[
        variant === 'chips' ? 'filter-btn' : '',
        option.className ?? '',
      ].filter(Boolean).join(' ') || undefined}
      role="radio"
      aria-checked={value === option.value}
      aria-disabled={option.disabled || undefined}
      tabIndex={index === tabbable ? 0 : -1}
      title={option.title}
      onClick={() => { if (!option.disabled) onChange(option.value) }}
      onKeyDown={onKeyDown}
    >
      {option.label}
    </button>
  ))

  return (
    <div
      className={[className ?? ''].filter(Boolean).join(' ') || undefined}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      data-testid={testId}
    >
      {optionsClassName || optionsTestId ? (
        <div className={optionsClassName} data-testid={optionsTestId}>{buttons}</div>
      ) : buttons}
      {children}
    </div>
  )
}
