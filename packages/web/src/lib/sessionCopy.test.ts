import { describe, expect, it } from 'vitest'
import { busyRetryWhen } from './sessionCopy'

describe('busyRetryWhen', () => {
  it.each([
    [1, 'in a few seconds'],
    [5, 'in a few seconds'],
    [6, 'in under a minute'],
    [59, 'in under a minute'],
    [60, 'in about a minute'],
    [61, 'in about 2 minutes'],
    [3_600, 'in about 60 minutes'],
  ])('%i s reads %s', (seconds, text) => {
    expect(busyRetryWhen(seconds)).toBe(text)
  })
})
