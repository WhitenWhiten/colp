// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopNav } from './TopNav'
import { cleanup, mountTree } from '../test/render'

const AVATAR_URL = 'https://cdn.example.test/avatar.png'
const AVATAR_URL_2 = 'https://cdn.example.test/avatar-2.png'

type MockUser = {
  name: string
  handle: string
  email: string
  initials: string
  accountId: string
  profileId: string
  avatarUrl?: string | null
}

const mocks = vi.hoisted(() => ({
  auth: {
    user: {
      name: 'Dev User',
      handle: 'dev',
      email: 'dev@example.test',
      initials: 'DU',
      accountId: 'account-1',
      profileId: 'profile-1',
      avatarUrl: 'https://cdn.example.test/avatar.png',
    } as MockUser,
    isLoggedIn: true,
    logout: vi.fn().mockResolvedValue('signed-out'),
  },
  toast: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  isWriteApprovalsExposureEnabled: () => false,
  isNotificationExposureEnabled: () => false,
}))
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))
vi.mock('../lib/useNotificationCenter', () => ({
  useNotificationCenter: () => ({ unreadCount: 0 }),
}))
vi.mock('../lib/useCommunityNotificationCenter', () => ({
  useCommunityNotificationCenter: () => ({ unreadCount: 0 }),
}))
vi.mock('./SearchPalette', () => ({
  SearchPalette: () => null,
}))

function makeUser(avatarUrl: string | null): MockUser {
  return {
    name: 'Dev User',
    handle: 'dev',
    email: 'dev@example.test',
    initials: 'DU',
    accountId: 'account-1',
    profileId: 'profile-1',
    avatarUrl,
  }
}

describe('TopNav avatar', () => {

  function render() {
    mountTree(<MemoryRouter><TopNav /></MemoryRouter>)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.user = makeUser(AVATAR_URL)
    mocks.auth.isLoggedIn = true
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the avatar image for both the nav trigger and the account menu when the user has an avatarUrl', () => {
    render()

    const navImg = document.querySelector<HTMLImageElement>('[data-testid="avatar-nav"] img')
    expect(navImg).not.toBeNull()
    expect(navImg?.src).toBe(AVATAR_URL)
    expect(navImg?.getAttribute('alt')).toBe('')
    // The initials fallback span must not be rendered while the image is shown.
    expect(document.querySelector('[data-testid="avatar-nav"]')?.textContent).toBe('')

    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())

    // Both avatar slots (.avatar-nav and .avatar-md) must be <img> with the same src.
    // BrandMark also renders an <img>; do not count document-wide images.
    const imgs = document.querySelectorAll<HTMLImageElement>('[data-testid="avatar-nav"] img, [data-testid="avatar-md"] img')
    expect(imgs.length).toBe(2)
    for (const img of imgs) {
      expect(img.src).toBe(AVATAR_URL)
      expect(img.getAttribute('alt')).toBe('')
    }
    expect(document.querySelector('[data-testid="avatar-md"]')?.textContent).toBe('')
  })

  it('falls back to the initials when the avatar image fails to load', () => {
    render()

    const navImg = document.querySelector<HTMLImageElement>('[data-testid="avatar-nav"] img')
    expect(navImg).not.toBeNull()

    act(() => {
      navImg!.dispatchEvent(new Event('error', { bubbles: false }))
    })

    expect(document.querySelector('[data-testid="avatar-nav"] img')).toBeNull()
    expect(document.querySelector('[data-testid="avatar-nav"]')?.textContent).toBe('DU')
  })

  it('renders the initials directly when the user has no avatarUrl', () => {
    mocks.auth.user = makeUser(null)
    render()

    expect(document.querySelectorAll('[data-testid="avatar-nav"] img, [data-testid="avatar-md"] img').length).toBe(0)
    expect(document.querySelector('[data-testid="avatar-nav"]')?.textContent).toBe('DU')
  })

  it('resets the failed state when avatarUrl changes within the same mount', () => {
    render()
    expect(document.querySelector('[data-testid="avatar-nav"] img')).not.toBeNull()

    act(() => {
      document.querySelector<HTMLImageElement>('[data-testid="avatar-nav"] img')!.dispatchEvent(new Event('error', { bubbles: false }))
    })
    expect(document.querySelector('[data-testid="avatar-nav"]')?.textContent).toBe('DU')

    // Re-rendering with the same URL keeps the fallback: the reset is url-driven.
    mountTree(<MemoryRouter><TopNav /></MemoryRouter>)
    expect(document.querySelector('[data-testid="avatar-nav"] img')).toBeNull()
    expect(document.querySelector('[data-testid="avatar-nav"]')?.textContent).toBe('DU')

    act(() => {
      mocks.auth.user = makeUser(AVATAR_URL_2)
      mountTree(<MemoryRouter><TopNav /></MemoryRouter>)
    })
    const restoredImg = document.querySelector<HTMLImageElement>('[data-testid="avatar-nav"] img')
    expect(restoredImg).not.toBeNull()
    expect(restoredImg?.src).toBe(AVATAR_URL_2)
    expect(document.querySelector('[data-testid="avatar-nav"]')?.textContent).toBe('')
  })
})

describe('TopNav scroll chrome', () => {

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    document.body.innerHTML = ''
  })

  it('adds is-scrolled after the page moves past the hairline threshold', () => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    mountTree(<MemoryRouter><TopNav /></MemoryRouter>)
    expect(document.querySelector('header')?.classList.contains('is-scrolled')).toBe(false)

    Object.defineProperty(window, 'scrollY', { value: 16, configurable: true })
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(document.querySelector('header')?.classList.contains('is-scrolled')).toBe(true)
  })
})
