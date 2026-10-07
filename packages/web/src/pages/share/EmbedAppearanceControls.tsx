import { useId } from 'react'
import { Icon } from '../../components/Icon'
import { appearanceChoices, appearanceColors, appearanceNumbers, parseEmbedAppearance, type AppearanceKey, type EmbedAppearance } from './embedAppearance'

const labels: Record<AppearanceKey, string> = { font: 'Body font', metaFont: 'Detail font', density: 'Spacing', divider: 'Dividers', decoration: 'Decoration', bg: 'Background', text: 'Text', muted: 'Secondary text', accent: 'Accent', line: 'Border color', fontSize: 'Font size', padding: 'Inner padding', radius: 'Corner radius' }

/* Display names for the contract's option values; the values themselves
   (and so the embed URL) are unchanged. */
const choiceLabels: Record<string, string> = {
  default: 'Default', sans: 'Sans', serif: 'Serif', mono: 'Mono',
  comfortable: 'Comfortable', tight: 'Tight',
  solid: 'Solid', dotted: 'Dotted', dashed: 'Dashed',
  none: 'None', checker: 'Checker',
}

/* Thirteen flat fields read as a wall; three short labelled groups scan. */
const groups: ReadonlyArray<{ title: string; keys: readonly AppearanceKey[] }> = [
  { title: 'Colors', keys: appearanceColors },
  { title: 'Type', keys: ['font', 'metaFont', 'fontSize'] },
  { title: 'Layout', keys: ['density', 'padding', 'radius', 'divider', 'decoration'] },
]

const HEX = /^#[0-9a-f]{6}$/i

export function EmbedAppearanceControls({ value, onChange }: { value: EmbedAppearance; onChange: (value: EmbedAppearance) => void }) {
  const idPrefix = useId()
  const update = (key: AppearanceKey, next: string) => onChange({ ...value, [key]: next })
  /* Only overrides that survive validation count — a half-typed hex is not
     a change yet. */
  const changed = Object.keys(parseEmbedAppearance(new URLSearchParams(value))).length

  const field = (key: AppearanceKey) => {
    const id = `${idPrefix}-${key}`
    if (key in appearanceChoices) {
      const choices = appearanceChoices[key as keyof typeof appearanceChoices]
      return (
        <div className="field" key={key}>
          <label htmlFor={id}>{labels[key]}</label>
          <select id={id} aria-label={labels[key]} value={value[key] ?? choices[0]} onChange={event => update(key, event.target.value)}>
            {choices.map(choice => <option key={choice} value={choice}>{choiceLabels[choice] ?? choice}</option>)}
          </select>
        </div>
      )
    }
    if (key in appearanceNumbers) {
      const range = appearanceNumbers[key as keyof typeof appearanceNumbers]
      return (
        <div className="field" key={key}>
          <label htmlFor={id}>{labels[key]} (px)</label>
          <input id={id} type="number" min={range.min} max={range.max} step={1} placeholder={String(range.fallback)} value={value[key] ?? ''} onChange={event => update(key, event.target.value)} />
        </div>
      )
    }
    const swatch = HEX.test(value[key] ?? '') ? value[key] : undefined
    return (
      <div className="field" key={key}>
        <label htmlFor={id}>{labels[key]}</label>
        <div className="share-appearance-hex">
          <input id={id} type="text" placeholder="Auto" maxLength={7} pattern="#[0-9a-fA-F]{6}" value={value[key] ?? ''} onChange={event => update(key, event.target.value)} aria-label={`${labels[key]} hex color`} />
          {swatch ? <i className="share-appearance-swatch" style={{ ['--swatch' as string]: swatch }} aria-hidden data-testid="share-appearance-swatch" /> : null}
        </div>
      </div>
    )
  }

  return (
    <details className="share-appearance">
      <summary>
        Customize style
        {changed > 0 ? <span className="chip">{changed} changed</span> : null}
        <Icon name="chevron-down" />
      </summary>
      {groups.map(group => (
        <fieldset className="share-appearance-group" key={group.title}>
          <legend className="section-label">{group.title}</legend>
          <div className="share-appearance-fields">{group.keys.map(field)}</div>
        </fieldset>
      ))}
      <div className="share-appearance-foot">
        <p className="meta">Colors take #RRGGBB; blank follows the theme. The Know-N footer always stays visible.</p>
        {changed > 0 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({})}>Reset appearance</button> : null}
      </div>
    </details>
  )
}
