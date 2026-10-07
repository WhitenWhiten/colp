import { expect, test, type BrowserContext } from '@playwright/test'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) {
  throw new Error('MCP-W08 real-stack infrastructure is required')
}

type Fixture = {
  planId: string
  status: string
  risk: string
  requiresApproval: boolean
  summary: string
  approvalUri: string
  mcpSecurityEpoch: string
  mcpAuthoritySecurityEpoch: string
  browserAccountSecurityEpoch: string
  browserSessionSecurityEpoch: string
  accountId: string
  profileId: string
  handle: string
  cookieValue: string
  csrfToken: string
  collectionId: string
  nodeId: string
  baseRevision: string
  targetVisibility: string
  idempotencyKey: string
  commitRequestState: string
  wireRoute: '/collections/-/mcp'
  protocolVersion: '2026-07-28'
}

type CommitOutput = {
  planId: string
  planStatus: string
  operations: Array<{ status: string }>
  nodeVisibility: string | null
  approvalConsumed: boolean
}

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function completeFixtureSignIn(context: BrowserContext, fixture: Fixture): Promise<void> {
  const origin = new URL(webBaseUrl!)
  origin.protocol = 'https:'
  await context.addCookies([{
    name: '__Host-known_session',
    value: fixture.cookieValue,
    url: origin.origin,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
}

test('MCP-W08 real MCP Plan -> browser decision -> new MCP commit request', async ({ browser }) => {
  const fixture = await control<Fixture>('/mcp-w08/fixture')
  expect(fixture.status).toBe('pending')
  expect(fixture.requiresApproval).toBe(true)
  expect(['high', 'medium']).toContain(fixture.risk)
  expect(fixture.targetVisibility).toBe('protected')
  expect(fixture.wireRoute).toBe('/collections/-/mcp')
  expect(fixture.protocolVersion).toBe('2026-07-28')
  expect(fixture.mcpAuthoritySecurityEpoch).not.toBe('')
  expect(fixture.mcpSecurityEpoch).toBe(fixture.mcpAuthoritySecurityEpoch)
  expect(fixture.mcpSecurityEpoch).not.toBe(fixture.browserAccountSecurityEpoch)
  expect(fixture.browserAccountSecurityEpoch).toBe('0')
  expect(fixture.browserSessionSecurityEpoch).toBe('0')
  const expectedApprovalUri = `${new URL(webBaseUrl).origin}/approvals/${fixture.planId}`
  expect(fixture.approvalUri).toBe(expectedApprovalUri)

  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    expect(await context.cookies()).toHaveLength(0)
    await page.goto(fixture.approvalUri)
    const returnTo = `/approvals/${fixture.planId}`
    const loginUri = `${new URL(webBaseUrl).origin}/login?returnTo=${encodeURIComponent(returnTo)}&reason=approval_required`
    await expect(page).toHaveURL(loginUri)
    await expect(page.locator('.toast-message')).toHaveText(
      'Please sign in before authorizing this MCP change.',
    )

    // The per-plan fixture account intentionally has no reusable password.
    // Installing its real signed Better Auth session in this same context
    // models a completed login before the browser resumes the exact returnTo.
    await completeFixtureSignIn(context, fixture)
    await page.goto(fixture.approvalUri)
    await expect(page).toHaveURL(fixture.approvalUri)
    await expect(page.getByRole('heading', { name: 'Write approval', exact: true })).toBeVisible()
    await expect(page.locator('[data-plan-id]')).toHaveCount(1)
    const card = page.locator(`[data-plan-id="${fixture.planId}"]`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-status', 'pending')
    await expect(card).toContainText(fixture.summary)
    await expect(card).toContainText('Change library visibility')
    await expect(card).toContainText('Change visibility')
    await expect(card).toContainText('protected')

    const approve = card.getByRole('button', { name: 'Approve', exact: true })
    await approve.focus()
    await expect(approve).toBeFocused()
    await approve.press('Enter')
    await expect(card).toHaveAttribute('data-status', 'approved')
    await expect(card).toContainText('Approved')

    const commit = await control<CommitOutput>('/mcp-w08/commit', {
      planId: fixture.planId,
      idempotencyKey: fixture.idempotencyKey,
      requestState: fixture.commitRequestState,
    })
    expect(commit.planId).toBe(fixture.planId)
    expect(commit.planStatus).toBe('consumed')
    expect(commit.nodeVisibility).toBe('protected')
    expect(commit.approvalConsumed).toBe(true)
    expect(commit.operations).toHaveLength(1)
    expect(commit.operations[0]?.status).toBe('applied')

    await page.reload()
    await expect(card).toHaveAttribute('data-status', 'consumed')
    await expect(card).toContainText('Consumed')

    await page.setViewportSize({ width: 320, height: 720 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
  } finally {
    await context.close()
  }
})
