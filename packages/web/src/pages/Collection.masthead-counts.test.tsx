// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { collectLayeredRules, readStyle } from '../styles/layered-css.test-helper'
import { domFinishedLoading, waitForDom } from '../test/render'

import { mocks } from './Collection.masthead.test-mocks'
import { installMastheadHarness, renderCollection, snapshot } from './Collection.masthead.test-helper'

installMastheadHarness()

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

describe('public Collection masthead', () => {
  it('renders views, not followers, when viewCount is 12', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, viewCount: 12 },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-collection-field="views"]')?.textContent).toBe('12')
    expect(document.body.textContent).toContain('views')
    expect(document.body.textContent).not.toContain('followers')
    expect(document.querySelector('[data-collection-field="followers"]')).toBeNull()
  })

  it('clamps a long masthead title to three lines at ≤639, not a single-line ellipsis', async () => {
    const title = 'A maintained map of primary sources and practical references for systems research'
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, title },
    })

    const mobile = collectLayeredRules(readStyle('collection.css')).find(
      (rule) => rule.selector === '.collection-masthead .display' && rule.media?.max === 639,
    )
    expect(mobile, 'mobile masthead title rule must exist').toBeTruthy()
    expect(mobile!.body).toMatch(/-webkit-line-clamp:\s*3/)
    expect(mobile!.body).not.toMatch(/white-space:\s*nowrap/)

    const style = document.createElement('style')
    style.id = 'masthead-clamp-test'
    style.textContent = `.collection-masthead .display { ${mobile!.body} }`
    document.head.appendChild(style)

    renderCollection()
    await waitForDom(domFinishedLoading)

    const heading = document.querySelector('header h1')
    expect(heading?.textContent).toBe(title)
    const computed = getComputedStyle(heading!)
    expect(computed.whiteSpace).not.toBe('nowrap')
    const clamp =
      computed.getPropertyValue('line-clamp') || computed.getPropertyValue('-webkit-line-clamp')
    expect(clamp.trim()).toBe('3')
    expect(computed.overflow).toBe('hidden')
    document.getElementById('masthead-clamp-test')?.remove()
  })

  it('does not render views when viewCount is 0', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, viewCount: 0 },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-collection-field="views"]')).toBeNull()
    expect(document.body.textContent).not.toContain('0 views')
    expect(document.body.textContent).not.toContain('followers')
  })
})
