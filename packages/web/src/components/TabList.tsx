import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export type TabListOption<T extends string> = {
  id: T
  label: ReactNode
}

type TabListProps<T extends string> = {
  label: string
  value: T
  options: ReadonlyArray<TabListOption<T>>
  /** `via` is 'keyboard' for arrow/Home/End roaming, 'pointer' for a click
      (including Enter/Space on the tab). R15-36: a roaming arrow key must
      not be followed by the page pulling focus out of the tablist. */
  onChange: (id: T, via: 'keyboard' | 'pointer') => void
  panelIdFor: (id: T) => string
  tabIdFor: (id: T) => string
  disabled?: boolean
  className?: string
  tabClassName?: string
  testId?: string
}

export function TabList<T extends string>({
  label,
  value,
  options,
  onChange,
  panelIdFor,
  tabIdFor,
  disabled = false,
  className,
  tabClassName,
  testId,
}: TabListProps<T>) {
  const tabRefs = useRef(new Map<T, HTMLButtonElement>())

  const activate = (id: T) => {
    onChange(id, 'keyboard')
    tabRefs.current.get(id)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: T) => {
    if (disabled) return
    const ids = options.map((option) => option.id)
    const index = ids.indexOf(id)
    if (index < 0) return
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % ids.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ids.length) % ids.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = ids.length - 1
    else return
    event.preventDefault()
    const next = ids[nextIndex]
    if (next) activate(next)
  }

  return (
    <div className={className} role="tablist" aria-label={label} data-testid={testId}>
      {options.map((option) => {
        const selected = value === option.id
        return (
          <button
            key={option.id}
            id={tabIdFor(option.id)}
            ref={(node) => {
              if (node) tabRefs.current.set(option.id, node)
              else tabRefs.current.delete(option.id)
            }}
            type="button"
            role="tab"
            className={tabClassName}
            aria-selected={selected}
            aria-controls={panelIdFor(option.id)}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.id, 'pointer')}
            onKeyDown={(event) => onKeyDown(event, option.id)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
