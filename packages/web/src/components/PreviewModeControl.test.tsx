// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { PreviewModeControl } from './PreviewModeControl'

const mocks = vi.hoisted(() => ({
  getBookmarkPreviewMode: vi.fn(),
  setBookmarkPreviewMode: vi.fn(),
}))

vi.mock('../api', () => ({
  productClient: {
    getBookmarkPreviewMode: mocks.getBookmarkPreviewMode,
    setBookmarkPreviewMode: mocks.setBookmarkPreviewMode,
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
    newCommandId: () => 'cmd',
  },
  isProductApiError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
}))

const IMAGE = { url: 'https://known.example/api/v1/link-preview/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', width: 800, height: 400 }
const view = (mode: 'auto' | 'none', etag: string, previewImage: typeof IMAGE | null = IMAGE) =>
  ({ nodeId: 'n1', mode, previewImage, etag })

const radio = (value: string) => document.querySelector<HTMLInputElement>(`[data-testid="preview-mode-control"] input[value="${value}"]`)!

describe('PreviewModeControl', () => {
  beforeEach(() => {
    mocks.getBookmarkPreviewMode.mockReset()
    mocks.setBookmarkPreviewMode.mockReset()
  })
  afterEach(cleanup)

  it('shows the current mode and thumbnail, and hides with the GET ETag as If-Match', async () => {
    mocks.getBookmarkPreviewMode.mockResolvedValue(view('auto', '"preview-mode:1"'))
    mocks.setBookmarkPreviewMode.mockResolvedValue(view('none', '"preview-mode:2"', null))
    mountTree(<PreviewModeControl collectionId="c1" nodeId="n1" disabled={false} />)
    await waitForDom(() => document.querySelector('[data-testid="preview-mode-control"]') !== null)
    expect(radio('auto').checked).toBe(true)
    expect(document.body.textContent).toContain('Hide for this bookmark')
    expect(document.body.textContent).toContain('existing image links and cached copies remain accessible.')
    expect(document.querySelector('[data-testid="preview-mode-thumb"]')?.getAttribute('src')).toBe(IMAGE.url)
    await act(async () => radio('none').click())
    expect(mocks.setBookmarkPreviewMode).toHaveBeenCalledWith('c1', 'n1', 'none', '"preview-mode:1"', expect.anything())
    expect(radio('none').checked).toBe(true)
    expect(document.querySelector('[data-testid="preview-mode-thumb"]')).toBeNull()
  })

  it('a stale ETag reloads the latest setting and explains why', async () => {
    mocks.getBookmarkPreviewMode
      .mockResolvedValueOnce(view('auto', '"preview-mode:1"'))
      .mockResolvedValueOnce(view('auto', '"preview-mode:1"'))
      .mockResolvedValue(view('none', '"preview-mode:3"', null))
    mocks.setBookmarkPreviewMode.mockRejectedValue({ status: 412, recoveryHint: 'refresh' })
    mountTree(<PreviewModeControl collectionId="c1" nodeId="n1" disabled={false} />)
    await waitForDom(() => document.querySelector('[data-testid="preview-mode-control"]') !== null)
    await act(async () => radio('none').click())
    await waitForDom(() => radio('none')?.checked === true)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('changed elsewhere')
  })

  it('renders nothing when link previews are off or the viewer may not change them', async () => {
    mocks.getBookmarkPreviewMode.mockRejectedValue({ status: 404 })
    mountTree(<PreviewModeControl collectionId="c1" nodeId="n1" disabled={false} />)
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="preview-mode-control"]')).toBeNull()
  })
})
