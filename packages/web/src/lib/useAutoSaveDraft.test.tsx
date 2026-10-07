// @vitest-environment happy-dom
import { act, useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAutoSaveDraft, useAutoSaveDraft } from './useAutoSaveDraft'
import { cleanup, mountTree } from '../test/render'

function Probe() {
  const [partition, setPartition] = useState('account-a')
  const [title, setTitle] = useState('seed')
  const values = useMemo(() => ({ title }), [title])
  useAutoSaveDraft('note', values, partition, 800)
  return (
    <>
      <button type="button" onClick={() => setTitle('late')}>Edit</button>
      <button type="button" onClick={() => setPartition('account-b')}>Switch</button>
    </>
  )
}

describe('useAutoSaveDraft partitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('a late debounce does not write into the other partition', async () => {
    mountTree(<Probe />)
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Edit')?.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(799) })
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Switch')?.click() })

    expect(readAutoSaveDraft('note', 'account-b')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(readAutoSaveDraft('note', 'account-a')).toEqual({ title: 'late' })
    expect(readAutoSaveDraft('note', 'account-b')).toBeNull()
  })
})
