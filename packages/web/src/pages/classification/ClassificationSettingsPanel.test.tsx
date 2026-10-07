// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { ClassificationSettingsPanel } from './ClassificationSettingsPanel'
const mocks = vi.hoisted(() => ({ profiles:vi.fn(),get: vi.fn(), update: vi.fn() }))
vi.mock('../../api', async original => {
  const actual = await original<typeof import('../../api')>()
  return { ...actual, productClient: { ...actual.productClient, listClassificationProfiles:mocks.profiles,getClassificationSettings: mocks.get, updateClassificationSettings: mocks.update } }
})
const current = { settings: { collectionId: 'library', autoTagMode: 'off', maxAutoTags: 3,executionMode:'server_managed',providerProfileId:null }, etag: '"settings-0"' }
function button(label: string) {
  const result = [...document.querySelectorAll('button')].find(node => node.textContent === label)
  if (!result) throw new Error(`Missing ${label}`)
  return result
}
beforeEach(() => { vi.clearAllMocks(); mocks.profiles.mockResolvedValue({profiles:[]});mocks.get.mockResolvedValue(current); mocks.update.mockResolvedValue({ ...current, etag: '"settings-1"' }) })
afterEach(() => cleanup())
it('offers only off/suggest and saves collection-specific settings with the current ETag', async () => {
  mountTree(<ClassificationSettingsPanel collectionId="library" />)
  await waitForDom(() => Boolean(document.querySelector('#classification-tag-mode')))
  const mode = document.querySelector<HTMLSelectElement>('#classification-tag-mode')!
  expect([...mode.options].map(option => option.value)).toEqual(['off', 'suggest'])
  await act(async () => { mode.value = 'suggest'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => button('Save classification settings').click())
  expect(mocks.update).toHaveBeenCalledWith('library', { autoTagMode: 'suggest', maxAutoTags: 3,executionMode:'server_managed',providerProfileId:null }, '"settings-0"', expect.objectContaining({ maxRetries: 0 }))
})
it('a stale settings ETag requires refresh without automatically overwriting another change', async () => {
  mocks.update.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry' }))
  mountTree(<ClassificationSettingsPanel collectionId="library" />)
  await waitForDom(() => Boolean(document.querySelector('#classification-tag-mode')))
  await act(async () => button('Save classification settings').click())
  expect(button('Save classification settings').disabled).toBe(true)
  mocks.get.mockResolvedValue({ ...current, etag: '"settings-new"' })
  await act(async () => button('Refresh classification settings').click())
  expect(mocks.update).toHaveBeenCalledTimes(1)
  await act(async () => button('Save classification settings').click())
  expect(mocks.update.mock.calls[1]?.[2]).toBe('"settings-new"')
})
it('conceals unavailable or non-owned settings', async () => {
  mocks.get.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'unavailable' }))
  mountTree(<ClassificationSettingsPanel collectionId="library" />)
  await waitForDom(() => !document.querySelector('[aria-label="Classification settings"]'))
  expect(mocks.update).not.toHaveBeenCalled()
})

it('does not render provider selector and does not request profiles', async () => {
  mountTree(<ClassificationSettingsPanel collectionId="library" />)
  await waitForDom(() => Boolean(document.querySelector('#classification-tag-mode')))
  expect(document.querySelector('#classification-provider')).toBeNull()
  expect(mocks.profiles).not.toHaveBeenCalled()
})
