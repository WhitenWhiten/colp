// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, mountTree } from '../../test/render'
import { GetStarted, getStartedHidden } from './GetStarted'
afterEach(() => { cleanup(); localStorage.clear() })
test('offers the extension and an explicit new-folder action', async () => {
  const create = vi.fn()
  await act(async () => { mountTree(<MemoryRouter><GetStarted onNewFolder={create} /></MemoryRouter>) })
  expect(document.querySelector('a')?.getAttribute('href')).toBe('/extension')
  act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'New folder')!.click())
  expect(create).toHaveBeenCalledOnce()
  expect(document.body.textContent).not.toContain('New collection')
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Hide the setup checklist"]')!.click())
  expect(getStartedHidden()).toBe(true)
  expect(document.querySelector('[data-testid="get-started"]')).toBeNull()
})
