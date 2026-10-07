import type { BrowserContext } from '@playwright/test'

/** Reader acceptance explicitly opts in while the public release gate stays closed. */
export async function enableReaderAcceptance(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.__KNOWN_FLAGS__ = { ...(window.__KNOWN_FLAGS__ ?? {}), readableReplica: true }
  })
}
