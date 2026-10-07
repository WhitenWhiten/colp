import { StrictMode, createElement, type ComponentType, type ReactNode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ConfirmProvider } from '../components/ConfirmModal'

export type RenderOptions = {
  route?: string
  initialEntries?: string[]
  wrapper?: ComponentType<{ children: ReactNode }>
  /**
   * Mount under `StrictMode`, as `main.tsx` does in production.
   *
   * Defaults to true: mounting outside it hides a whole class of defect
   * (double-invoked effects, reducers and render bodies) and the production
   * entry always mounts inside it. A test that genuinely needs the non-strict
   * behaviour — a deliberate single-invocation probe — must opt out explicitly.
   */
  strict?: boolean
}

export type RenderResult = {
  container: HTMLElement
  unmount: () => void
  rerender: (ui: ReactNode) => void
}

const mounted = new Set<RenderResult>()
let active: RenderResult | undefined
// Capture the native timer before individual suites install fake timers. The
// polling helper must wait for real I/O/macrotask progress without secretly
// advancing the application's mocked clock.
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

function waitForRealPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { realSetTimeout(resolve, milliseconds) })
}

function markActEnvironment(): void {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
}

function wrapUi(ui: ReactNode, options: RenderOptions | undefined): ReactNode {
  let tree = ui
  /* Every mounted tree gets the shared confirm host — production mounts it in
     Layout (R9-19), and without it useConfirm resolves false (auto-cancel),
     which would silently change what a test is actually exercising. */
  tree = createElement(ConfirmProvider, null, tree)
  if (options?.wrapper) {
    tree = createElement(options.wrapper, null, tree)
  }
  const entries = options?.initialEntries ?? (options?.route !== undefined ? [options.route] : undefined)
  if (entries) {
    tree = createElement(MemoryRouter, { initialEntries: entries }, tree)
  }
  /* StrictMode goes OUTERMOST, matching `main.tsx`. React's double-invocation
     walk stops at the first non-strict fiber carrying pending effects, so a
     StrictMode nested inside the providers leaves the initial-mount effects of
     everything below it single-invoked — the very class of bug that mounting
     under StrictMode exists to catch. */
  if (options?.strict !== false) {
    tree = createElement(StrictMode, null, tree)
  }
  return tree
}

function hostForMount(): { host: HTMLElement; created: boolean } {
  const existing =
    document.getElementById('test-root') ??
    document.getElementById('root')
  if (existing instanceof HTMLElement) {
    return { host: existing, created: false }
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  return { host, created: true }
}

export function renderWithRouter(ui: ReactNode, options?: RenderOptions): RenderResult {
  markActEnvironment()
  const { host, created } = hostForMount()
  const root = createRoot(host)
  let alive = true

  const renderTree = (node: ReactNode) => {
    act(() => {
      root.render(wrapUi(node, options))
    })
  }

  renderTree(ui)

  const result: RenderResult = {
    container: host,
    unmount() {
      if (!alive) return
      alive = false
      act(() => {
        root.unmount()
      })
      if (created) host.remove()
      mounted.delete(result)
      if (active === result) active = undefined
    },
    rerender(next: ReactNode) {
      if (!alive) {
        throw new Error('rerender called after unmount')
      }
      renderTree(next)
    },
  }
  mounted.add(result)
  active = result
  return result
}

/** First call mounts; later calls rerender the same root (Settings dirty-field, Notifications). */
export function mountTree(ui: ReactNode, options?: RenderOptions): RenderResult {
  if (active) {
    active.rerender(ui)
    return active
  }
  return renderWithRouter(ui, options)
}

export function cleanup(): void {
  for (const view of [...mounted]) {
    view.unmount()
  }
  active = undefined
}

function buttonLabel(button: HTMLButtonElement): string {
  const followLabel = button.querySelector('.follow-btn-label')?.textContent
  const text = (followLabel ?? button.textContent)?.replace(/\s+/g, ' ').trim() ?? ''
  const aria = button.getAttribute('aria-label')?.trim() ?? ''
  return text || aria
}

export function findButtonByName(name: string | RegExp): HTMLButtonElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
  const labeled = buttons.map((button) => {
    const follow = button.querySelector('.follow-btn-label')
    const text = (follow?.textContent ?? button.textContent)?.replace(/\s+/g, ' ').trim() ?? ''
    const aria = button.getAttribute('aria-label')?.trim() ?? ''
    return { button, text, aria }
  })
  const match = name instanceof RegExp
    ? labeled.find((item) => name.test(item.text) || name.test(item.aria))
    : labeled.find((item) => item.text === name || item.aria === name)
      ?? labeled.find((item) => item.text.includes(name))
  if (!match) {
    const candidates = labeled.map((item) => item.text || item.aria || '(empty)')
    const wanted = name instanceof RegExp ? String(name) : name
    throw new Error(
      `button not found: ${wanted}. Candidates: ${candidates.join(', ') || '(none)'}`,
    )
  }
  return match.button
}

export async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

export async function waitForDom(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  markActEnvironment()
  const startedAt = Date.now()
  const pollIntervalMs = Math.min(5, timeoutMs)
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs) + 1)
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let passed = false
    await act(async () => {
      if (attempt > 0) await waitForRealPoll(pollIntervalMs)
      await Promise.resolve()
      try {
        passed = Boolean(predicate())
        lastError = undefined
      } catch (error) {
        lastError = error
        passed = false
      }
    })
    if (passed) return

    const elapsed = Date.now() - startedAt
    if (Number.isFinite(elapsed) && elapsed >= timeoutMs) {
      break
    }
  }

  const extra = lastError instanceof Error ? ` Last error: ${lastError.message}` : ''
  throw new Error(`waitForDom timed out after ${timeoutMs}ms.${extra}`)
}

/** True once the document is past a first-paint Loading / data-*-state=loading skeleton. */
export function domFinishedLoading(): boolean {
  if (document.querySelector('[data-feed-state="loading"]')) return false
  if (document.querySelector('[data-search-state="loading"], [data-search-state="loading-more"]')) {
    return false
  }
  if (document.querySelector('[data-profile-state="loading-activity"]')) return false
  for (const node of document.querySelectorAll('[role="status"]')) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (/^Loading\b/i.test(text) || /^Checking Follow/i.test(text)) return false
  }
  const hookState = document.querySelector('[data-state]')?.getAttribute('data-state')
  if (hookState === 'loading' || hookState === 'loading-more') return false
  return true
}
