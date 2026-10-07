// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { domFinishedLoading, waitForDom } from '../test/render'
import {
  bookmark,
  captureSearch,
  mocks,
  renderCollection,
  rootNode,
  setUpCollectionPage,
  snapshot,
  tearDownCollectionPage,
} from './Collection.test-helper'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks } = await import('./Collection.test-mocks')
  return {
    ...actual,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      recordPublicCollectionInsightEvent: mocks.recordPublicCollectionInsightEvent,
      getPublicProfilePage: mocks.getPublicProfilePage,
      getFollowersPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getFollowingPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
      getCollectionFollowState: mocks.getCollectionFollowState,
      followCollection: mocks.followCollection,
      unfollowCollection: mocks.unfollowCollection,
      abandonCollectionFollowIntent: mocks.abandonCollectionFollowIntent,
    },
  }
})

vi.mock('../components/AppToast', async () => {
  const { mocks } = await import('./Collection.test-mocks')
  return {
    useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

/* The Contents index: a sidebar from 900px, the same tree in a sheet below
   that. Viewport visibility is CSS (e2e/public-collection.responsive.spec.ts);
   this pins what the tree says and does. */
describe('public Collection page Contents', () => {
  beforeEach(setUpCollectionPage)
  afterEach(tearDownCollectionPage)

  it('counts what each Contents row files below it and opens the same tree as a sheet', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      { id: 'folder-classics', parentId: 'folder-papers', kind: 'folder', title: 'Classics', description: null, url: null, position: '0' },
      { id: 'folder-tools', parentId: 'root-1', kind: 'folder', title: 'Tools', description: null, url: null, position: '1' },
      bookmark('Classic survey', 'folder-classics'),
      bookmark('Direct paper', 'folder-papers'),
      bookmark('Loose note'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    // The collection heads the tree with its total; each folder counts every
    // bookmark below it at any depth (Papers includes Classics).
    const counts = (scope: ParentNode) => Object.fromEntries(
      [...scope.querySelectorAll('[data-collection-outline-count]')].map((count) => [
        count.previousElementSibling?.textContent, count.textContent,
      ]),
    )
    const sidebar = document.querySelector('nav[aria-label="Collection folders"]')
    if (!sidebar) throw new Error('Contents sidebar missing')
    expect(counts(sidebar)).toEqual({ 'Research notes': '3', Papers: '2', Tools: '0' })

    // Below 900px the same tree opens as a sheet from the toolbar; picking a
    // row there opens that folder and closes the sheet.
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="collection-toolbar"] button')]
      .find((button) => button.textContent?.trim() === 'Contents')
    if (!trigger) throw new Error('Contents trigger missing')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => trigger.click())
    const sheet = document.querySelector('[role="dialog"]')
    expect(sheet?.getAttribute('aria-label')).toBe('Contents')
    expect(trigger.getAttribute('aria-controls')).toBe(sheet?.id)
    const sheetPapers = [...(sheet?.querySelectorAll<HTMLButtonElement>('[data-collection-folder]') ?? [])]
      .find((button) => button.textContent === 'Papers')
    if (!sheetPapers) throw new Error('Papers row missing from the sheet')
    await act(async () => sheetPapers.click())
    expect(captureSearch).toContain('folder=folder-papers')
    await waitForDom(() => document.querySelector('[role="dialog"]') === null)
    expect(document.body.textContent).toContain('Direct paper')
  })
})
