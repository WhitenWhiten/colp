import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

export type UseSearchKeyboardOptions = {
  /** Number of navigable options currently rendered. */
  itemCount: number
  /** Stable id of the listbox element. */
  listId: string
  /** Option id prefix — defaults to listId. */
  optionIdPrefix?: string
  /** Reset the cursor when this value changes (e.g. the query). */
  resetKey?: unknown
  /** Enter activates the active option (navigate / choose). */
  onOpen: (index: number) => void
  /** Enter pressed while the option set is empty (e.g. submit the field). */
  onEmptyEnter?: () => void
}

/**
 * Shared combobox/listbox keyboard model for search surfaces (R10-21):
 * the input keeps focus (aria-activedescendant), ArrowUp/Down/Home/End
 * move a virtual cursor, Enter opens the active option, and hovering an
 * option syncs the cursor. Used by SearchPalette and the /search page.
 */
export function useSearchKeyboard({ itemCount, listId, optionIdPrefix, resetKey, onOpen, onEmptyEnter }: UseSearchKeyboardOptions) {
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const optionId = useCallback((index: number) => `${optionIdPrefix ?? listId}-option-${index}`, [listId, optionIdPrefix])

  useEffect(() => { setActive(0) }, [resetKey])

  // Clamp when the option set shrinks under the cursor.
  useEffect(() => {
    if (active >= itemCount) setActive(Math.max(0, itemCount - 1))
  }, [active, itemCount])

  // aria-activedescendant never moves DOM focus — keep the cursor row visible.
  useEffect(() => {
    if (!itemCount || !listRef.current) return
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active, itemCount, optionId])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (itemCount ? Math.min(itemCount - 1, index + 1) : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(Math.max(0, itemCount - 1))
    } else if (event.key === 'Enter') {
      if (itemCount > 0) {
        event.preventDefault()
        onOpen(active)
      } else {
        onEmptyEnter?.()
      }
    }
  }

  const comboboxProps = {
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': true,
    'aria-controls': listId,
    'aria-activedescendant': itemCount > 0 ? optionId(active) : undefined,
    onKeyDown,
  }

  const listboxProps = {
    id: listId,
    ref: listRef as RefObject<HTMLDivElement>,
    // A listbox with non-option children is invalid ARIA — the role only
    // applies while real options render inside.
    role: (itemCount > 0 ? 'listbox' : undefined) as 'listbox' | undefined,
  }

  const optionProps = useCallback((index: number) => ({
    id: optionId(index),
    role: 'option' as const,
    'aria-selected': index === active,
    onMouseEnter: () => setActive(index),
  }), [active, optionId])

  return { active, setActive, listRef, optionId, comboboxProps, listboxProps, optionProps }
}
