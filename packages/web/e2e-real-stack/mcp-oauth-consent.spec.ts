import { createHash, randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { signInShared } from './auth-bootstrap'

const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
if (!webBaseUrl || !controlUrl) throw new Error('MCP OAuth consent real-stack infrastructure is required')

async function beginConsent(page: Page, label: string): Promise<void> {
  const redirectUri = `${controlUrl}/oauth/callback`
  const registration = await page.request.post(`${webBaseUrl}/api/v1/auth/oauth2/register`, {
    data: {
      client_name: `Known consent ${label}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'native',
    },
  })
  expect([200, 201]).toContain(registration.status())
  const registered = await registration.json() as { client_id?: string }
  expect(registered.client_id).toBeTruthy()
  await signInShared(page, '/library')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URL('/api/v1/auth/oauth2/authorize', webBaseUrl)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', registered.client_id!)
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('scope', 'mcp:read:public')
  authorize.searchParams.set('resource', `${webBaseUrl}/collections/-/mcp`)
  authorize.searchParams.set('state', `consent-${label}`)
  await page.goto(authorize.href)
  await expect(page).toHaveURL(/\/consent\?/u)
  await expect(page.getByRole('heading', { name: `Allow Known consent ${label}?` })).toBeVisible()
  await expect(page.getByText(new URL(redirectUri).host, { exact: true })).toBeVisible()
}

test('MCP OAuth consent approve returns an authorization code to the registered client', async ({ page }) => {
  await beginConsent(page, 'approve')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page).toHaveURL(/[?&]code=[^&]+/u)
  await expect(page).toHaveURL(/[?&]state=consent-approve(?:&|$)/u)
})

test('MCP OAuth consent deny returns access_denied to the registered client', async ({ page }) => {
  await beginConsent(page, 'deny')
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page).toHaveURL(/[?&]error=access_denied(?:&|$)/u)
  await expect(page).toHaveURL(/[?&]state=consent-deny(?:&|$)/u)
})
