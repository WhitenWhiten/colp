// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoverImageControl } from './CoverImageControl'
import { cleanup, renderWithRouter, waitForDom } from '../test/render'
import { ProductApiError } from '../api/errors'

const mocks = vi.hoisted(() => ({ upload: vi.fn(), update: vi.fn(), saved: vi.fn(), success: vi.fn(), nextId: 0 }))
vi.mock('../api', async importOriginal => ({
  ...await importOriginal<typeof import('../api')>(),
  productClient: {
    uploadCollectionImage: mocks.upload, updateNodeCover: mocks.update,
    newCommandId: () => `intent-${++mocks.nextId}`,
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  },
}))
const image = { url: 'https://known.example/api/v1/images/12345678-1234-4234-8234-123456789abc', width: 800, height: 400 }
const base = { collectionId: 'col', nodeId: 'bookmark', kind: 'bookmark' as const, mode: 'auto' as const,
  revision: '0', image: null, disabled: false, onSaved: mocks.saved, onSuccess: mocks.success }

async function pick(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
const file = () => new File(['image bytes'], 'cover.png', { type: 'image/png' })

describe('CoverImageControl', () => {
  beforeEach(() => {
    mocks.nextId = 0
    mocks.upload.mockReset().mockResolvedValue({ assetId: 'asset', image })
    mocks.update.mockReset().mockResolvedValue({ mode: 'custom', revision: '1', image })
    mocks.saved.mockReset().mockResolvedValue(undefined)
    mocks.success.mockReset()
  })
  afterEach(cleanup)

  it('uploads and binds a custom cover immediately, then displays its immutable URL', async () => {
    renderWithRouter(<CoverImageControl {...base} />)
    const upload = file()
    await pick(upload)
    await waitForDom(() => mocks.saved.mock.calls.length === 1)
    expect(mocks.upload).toHaveBeenCalledWith('col', upload, expect.objectContaining({ intentId: expect.any(String) }))
    expect(mocks.update).toHaveBeenCalledWith('col', 'bookmark', { mode: 'custom', assetId: 'asset' }, '0', expect.any(Object))
    expect(document.querySelector('img')?.getAttribute('src')).toBe(image.url)
    expect(document.querySelector<HTMLInputElement>('input[value="custom"]')?.checked).toBe(true)
    expect(mocks.success).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('retries a failed binding with the same command and uploaded asset', async () => {
    mocks.update.mockRejectedValueOnce(new Error('offline'))
    renderWithRouter(<CoverImageControl {...base} />)
    await pick(file())
    await waitForDom(() => document.querySelector('[role="alert"]') !== null)
    const firstCall = mocks.update.mock.calls[0]
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    await waitForDom(() => mocks.saved.mock.calls.length === 1)
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(mocks.update.mock.calls[1]).toEqual(firstCall)
  })

  it('restores automatic mosaics and hides covers without uploading', async () => {
    mocks.update.mockResolvedValue({ mode: 'auto', revision: '5', image: null })
    renderWithRouter(<CoverImageControl {...base} kind="folder" mode="custom" revision="4" image={image} />)
    await act(async () => document.querySelector<HTMLInputElement>('input[value="auto"]')!.click())
    await waitForDom(() => mocks.saved.mock.calls.length === 1)
    expect(mocks.update.mock.calls[0]?.slice(0, 4)).toEqual(['col', 'bookmark', { mode: 'auto', assetId: null }, '4'])
    mocks.update.mockResolvedValue({ mode: 'none', revision: '6', image: null })
    await act(async () => document.querySelector<HTMLInputElement>('input[value="none"]')!.click())
    await waitForDom(() => mocks.saved.mock.calls.length === 2)
    expect(mocks.update.mock.calls[1]?.slice(0, 4)).toEqual(['col', 'bookmark', { mode: 'none', assetId: null }, '5'])
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(document.querySelector('img')).toBeNull()
  })

  it('rejects unsuitable files locally and disables editing for viewers', async () => {
    const view = renderWithRouter(<CoverImageControl {...base} />)
    await pick(new File(['<svg/>'], 'cover.svg', { type: 'image/svg+xml' }))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('PNG, JPEG or WebP')
    expect(mocks.upload).not.toHaveBeenCalled()
    view.rerender(<CoverImageControl {...base} disabled />)
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true)
    expect(document.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true)
  })

  it('refreshes a concurrent edit conflict without replaying a stale revision', async () => {
    mocks.update.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'Stale cover' }))
    renderWithRouter(<CoverImageControl {...base} />)
    await pick(file())
    await waitForDom(() => mocks.saved.mock.calls.length === 1)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('changed elsewhere')
    expect(document.querySelector('button')).toBeNull()
    expect(mocks.update).toHaveBeenCalledTimes(1)
  })
});
