import { expect, test as base } from '@playwright/test'

type StrictApiFixtures = {
  rejectUnexpectedApiRequests: void
}

/**
 * Mocked browser tests must never fall through Vite's development proxy.
 * Page routes and later context routes take precedence over this guard; any
 * request that reaches it was not declared by the test or a shared mock.
 */
export const test = base.extend<StrictApiFixtures>({
  rejectUnexpectedApiRequests: [async ({ context }, use) => {
    const unexpected: string[] = []
    await context.route(/\/api(?:\/|$)/u, async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
        await route.fallback()
        return
      }
      unexpected.push(`${request.method()} ${url.pathname}${url.search}`)
      await route.abort('blockedbyclient')
    })

    await use()

    expect(unexpected, 'mocked E2E issued undeclared Product API requests').toEqual([])
  }, { auto: true }],
})

export { expect }
