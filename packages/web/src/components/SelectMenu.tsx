import { useId } from 'react'
import { Icon } from './Icon'

export type SelectMenuOption<T extends string> = { value: T; label: string }

type Props<T extends string> = {
  label: string            // 可访问名，如 "Sort"
  prefix?: string          // 显示在控件里、值前面的文字，如 "Sort:"
  value: T
  options: ReadonlyArray<SelectMenuOption<T>>
  onChange: (value: T) => void
  className?: string
  testId?: string
  disabled?: boolean
}

/* Native <select> in the toolbar-control chrome: the browser owns the
   keyboard model and mobile picker. Where base-select is supported the open
   list takes the shared popover styling (global.css); elsewhere it is native. */
export function SelectMenu<T extends string>({ label, prefix, value, options, onChange, className, testId, disabled }: Props<T>) {
  const id = useId()
  return (
    <label className={['select-menu', className].filter(Boolean).join(' ')} data-testid={testId} htmlFor={id}>
      {prefix ? <span className="select-menu-prefix" aria-hidden>{prefix}</span> : null}
      <select
        id={id}
        className="select-menu-btn"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <Icon name="chevron-down" />
    </label>
  )
}
