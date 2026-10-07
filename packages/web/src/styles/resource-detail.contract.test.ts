import { describe, expect, it } from 'vitest'
import { collectLayeredRules, readStyle } from './dashboard-stack-cascade.test-helper'

/**
 * Resource detail layout contract.
 *
 * The head is a link card: its copy dissolves into one card grid so the
 * mark sits beside the host line and the actions and vote pill share a
 * hairline footer rail at every width (no masthead action column to
 * squeeze the title at tablet widths).
 *
 * The relation create form's four-column grid needs ~40rem of track; at
 * 900–1099px the reading column is ~33rem beside the aside, so the columns
 * wait for the 1100px measure — declaring them at 900px clipped Visibility
 * under html's overflow-x: clip.
 */

describe('resource detail layout contract', () => {
  const rules = collectLayeredRules(readStyle('resource-detail.css'))

  it('keeps the link card a single grid: copy dissolves, actions ride the footer rail', () => {
    const copy = rules.find((rule) => rule.selector === '.resource-head .page-head-copy' && !rule.media)
    expect(copy, 'the card copy must dissolve into the card grid').toBeTruthy()
    expect(copy!.body).toMatch(/display:\s*contents/)
    for (const selector of ['.resource-head .page-head-actions', '.resource-head .page-head-stats']) {
      const rail = rules.find((rule) => rule.selector === selector && !rule.media && /border-top:\s*1px solid/.test(rule.body))
      expect(rail, `${selector} rides the hairline footer rail`).toBeTruthy()
    }
  })

  it('waits for the 1100px measure before the four-column relation form', () => {
    const fourCol = rules.filter((rule) => (
      rule.selector === '.relation-create' && /grid-template-columns/.test(rule.body)
    ))
    expect(fourCol, '.relation-create must declare its four tracks somewhere').toHaveLength(1)
    expect(fourCol[0]!.media).toEqual({ min: 1100, max: undefined })

    /* Nothing may sneak the wide form back into the 900px desktop block. */
    const premature = rules.filter((rule) => (
      rule.selector === '.relation-create'
      && /grid-template-columns/.test(rule.body)
      && rule.media?.min != null
      && rule.media.min < 1100
    ))
    expect(premature, 'four columns must not return below 1100px').toEqual([])
  })
})
