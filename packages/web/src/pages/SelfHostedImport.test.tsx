// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditableNodeView, EditorSnapshot } from '../api'
import { ToastProvider } from '../components/AppToast'
import { SelfHostedImport } from './SelfHostedImport'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false, user: { accountId: 'account-1' } },
  getLibrary: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  createCollection: vi.fn(),
  importBookmarks: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getLibrary: mocks.getLibrary,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      createCollection: mocks.createCollection,
    },
  }
})
vi.mock('../lib/bookmarkImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bookmarkImport')>()
  return { ...actual, importBookmarks: mocks.importBookmarks }
})

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Research</H3><DL><DT><A HREF="https://example.com/a">A</A><DT><A HREF="https://example.com/b">B</A></DL></DL>'
const research = { id: 'folder', kind: 'folder', title: 'Research', parentId: 'root', position: 'a' } as EditableNodeView
const papers = { id: 'nested', kind: 'folder', title: 'Papers', parentId: 'folder', position: 'a' } as EditableNodeView
const snapshot = { collection: { id: 'col-1' }, root: { id: 'root' }, nodes: [research, papers] } as unknown as EditorSnapshot

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function chooseFile(name = 'bookmarks.html') {
  const input = document.querySelector<HTMLInputElement>('#import-file')!
  const file = new File([html], name, { type: 'text/html' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
  await flush()
}

describe('SelfHostedImport', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getLibrary.mockResolvedValue({ id: 'col-1', title: 'Bookmarks' })
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot)
    mocks.importBookmarks.mockResolvedValue({ created: 2, skipped: 1 })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists destination folders as a tree in the folder picker', async () => {
    mountTree(<MemoryRouter><SelfHostedImport /></MemoryRouter>)
    await flush()
    act(() => document.querySelector<HTMLButtonElement>('#import-folder')!.click())
    const options = [...document.querySelectorAll<HTMLButtonElement>('#import-folder-panel [role="option"]')]
    expect(options.map((option) => [option.dataset.folderId, option.style.getPropertyValue('--depth')])).toEqual([['folder', '0'], ['nested', '1']])
    expect(options[1]!.title).toBe('Research › Papers')
  })

  it('previews the chosen file, then clears it after a completed import so Confirm cannot run twice', async () => {
    mountTree(<MemoryRouter><ToastProvider><SelfHostedImport /></ToastProvider></MemoryRouter>)
    await flush()
    const confirm = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(confirm.disabled).toBe(true)

    await chooseFile()
    const preview = document.querySelector('[data-testid="import-preview"]')
    expect(preview?.textContent).toContain('bookmarks.html')
    expect(preview?.textContent).toContain('1 folder, 2 bookmarks')
    expect(confirm.disabled).toBe(true)
    act(() => document.querySelector<HTMLButtonElement>('#import-folder')!.click())
    act(() => document.querySelector<HTMLButtonElement>('#import-folder-panel [data-folder-id="folder"]')!.click())
    expect(confirm.disabled).toBe(false)

    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await flush()

    expect(mocks.importBookmarks).toHaveBeenCalledTimes(1)
    expect(mocks.importBookmarks.mock.calls[0]![0]).toMatchObject({ parentId: 'folder', skipDuplicates: true })
    const done = [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent?.includes('Imported'))
    expect(done?.textContent).toContain('Imported 2 items; skipped 1 duplicate.')
    expect(done?.querySelector('a')?.getAttribute('href')).toBe('/library/col-1?folder=folder')
    expect(document.querySelector('[data-testid="import-progress"]')).toBeNull()
    expect(document.querySelector('[data-testid="import-preview"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  })

  it('requires an explicit destination and never creates a collection', async () => {
    mountTree(<MemoryRouter><SelfHostedImport /></MemoryRouter>); await flush(); await chooseFile()
    expect(document.querySelector<HTMLButtonElement>('#import-folder')!.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(document.querySelector('#import-collection')).toBeNull()
    expect(mocks.createCollection).not.toHaveBeenCalled()
  })

  it('shows a failed file read as an inline error', async () => {
    mountTree(<MemoryRouter><SelfHostedImport /></MemoryRouter>)
    await flush()
    const input = document.querySelector<HTMLInputElement>('#import-file')!
    const big = { name: 'huge.html', size: 9 * 1024 * 1024, text: () => Promise.resolve('') }
    Object.defineProperty(input, 'files', { value: [big], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(document.querySelector('[data-testid="import-error"]')?.textContent).toContain('smaller than 8 MiB')
  })
})
