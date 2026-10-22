import type { Page, Request, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/* AW-12 editor flow against a mocked Product API (no backend): a library
   folder's Automate… opens a pre-filled rule, Preview is required before
   Turn on, and Pause all shows on every page. Synthetic data only. */

const CSRF = 'automation-csrf'
const T = '2026-10-12T09:30:00.000Z'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const A = '/api/v1/me/automations'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) })
}

const collection = {
  id: 'col-personal', kind: 'bookmarks', title: 'Personal', summary: null, visibility: 'private', publicationSlug: null, publishedAt: null,
  rootNodeId: 'root-p', revision: '1', etag: '"c-1"', contentRevision: '1', contentEtag: '"cc-1"',
  policyRevision: '1', policyEtag: '"p-1"', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: T,
}
const capabilities = { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true }
const node = (id: string, parentId: string, kind: 'folder' | 'bookmark', title: string, position: string, url?: string) => ({
  id, parentId, kind, title, position, url, description: null, tags: [], visibility: 'inherit', revision: 'n', etag: '"n"', readOnly: false, readOnlyReason: null,
})
const nodes = [
  node('f-academic', 'root-p', 'folder', 'Academic', 'a'),
  node('f-reading', 'root-p', 'folder', 'Reading', 'b'),
  node('b-1', 'root-p', 'bookmark', 'Grid layout notes', 'c', 'https://css.example/grid'),
]

type Write = { method: string; path: string; csrf?: string; commandId?: string; ifMatch?: string; body: Record<string, unknown> }

function record(request: Request, path: string): Write {
  const headers = request.headers()
  return {
    method: request.method(),
    path,
    csrf: headers['x-csrf-token'],
    commandId: headers['known-command-id'],
    ifMatch: headers['if-match'],
    body: JSON.parse(request.postData() ?? '{}') as Record<string, unknown>,
  }
}

async function mockOwnerWithAutomations(page: Page, withAgent = false) {
  const writes: Write[] = []
  const state = { paused: false, pauseRevision: 1, rule: null as Record<string, unknown> | null, binding: null as Record<string, unknown> | null }
  let paired = false, testCompleted = false, agentTarget: Record<string, unknown> | null = null
  const currentTarget = () => agentTarget ? { ...agentTarget, status: paired ? 'active' : 'unpaired',
    wakeReadiness: paired ? 'active' : 'waitingForPairing' } : null
  const pause = () => ({ paused: state.paused, pausedAt: state.paused ? T : null, pausedBy: state.paused ? 'owner' : null, revision: String(state.pauseRevision), heldJobs: 0 })

  await installPassiveFeatureMocks(page)
  await page.route('**/.well-known/collection-protocol', (route) => json(route, { serverUuid: 'server-e2e' }))
  await page.route('**/api/v1/session', (route) => json(route, {
    authenticated: true, csrfToken: CSRF, idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-02T00:00:00.000Z',
  }))
  await page.route('**/api/v1/me', (route) => json(route, {
    account: { id: 'acc-automations', email: 'owner@colp.test' },
    profile: { id: 'prof-1', handle: 'owner', displayName: 'Owner', avatarUrl: null },
  }))
  if (withAgent) await page.route('**/api/v1/me/agents', route => json(route, { agents: [{ id: 'https://chatgpt.com/oauth/client.json', name: 'ChatGPT', kind: 'oauth_client',
    scopes: ['automation:work'], createdAt: T, lastSeenAt: T, policy: 'manual' }] }))
  await page.route((url) => url.pathname === '/api/v1/me/library', (route) => json(route, { ...collection, library: true }))
  await page.route((url) => url.pathname === '/api/v1/collections', (route) => json(route, {
    items: [{ collection, capabilities, bookmarkCount: 1 }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
  }))
  await page.route('**/api/v1/collections/col-personal/editor*', (route) => json(route, {
    collection,
    root: { id: 'root-p', kind: 'folder', folderRole: 'root', title: 'Personal', description: null, tags: [], revision: 'r', etag: '"r"' },
    nodes,
    capabilities,
    page: { snapshotId: 's', contentRevision: '1', policyRevision: '1', comparatorVersion: 'v1', expiresAt: '2099-01-01T00:00:00.000Z', returnedCount: nodes.length, hasMore: false, nextCursor: null },
  }))
  await page.route(`**${A}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const sub = path.slice(A.length)
    const method = request.method()
    if (method !== 'GET') writes.push(record(request, path))
    if (withAgent) {
      if (sub === '/connection-profiles') return json(route, { items: agentTarget ? [{ id: 'profile-e2e', revision: '1', configuration: {
        name: 'ChatGPT', authorizedClientId: 'https://chatgpt.com/oauth/client.json', credentialBindingId: 'pending-e2e', automationEnabled: true, catalogs: ['standard', 'automationWorker'],
      }, eventsSupport: 'unknown' }] : [], nextCursor: null })
      if (sub === '/targets') return json(route, { items: agentTarget ? [currentTarget()] : [], nextCursor: null })
      if (sub === '/targets/target-e2e') return json(route, currentTarget())
      if (sub === '/agent-setup') {
        const input = writes.at(-1)!.body
        agentTarget = { id: 'target-e2e', revision: '2', configuration: { name: 'ChatGPT', providerLabel: '', connectionProfileId: 'profile-e2e',
          privacy: 'standard', broadcastOptIn: false, wakeMode: 'poll', pollIntervalMinutes: 1 }, wakeMode: 'poll', wakeReason: 'Pair this AI.', isolation: 'sharedCredential', subscriptionCount: 0 }
        state.binding = { ...input.bindings as object, id: 'bind-ai', revision: '1', updatedAt: T }
        state.rule = { id: 'rule-ai', revision: '1', desiredState: 'draft', effectiveState: 'draft', definition: { ...input.definition as object,
          route: { mode: 'targets', execution: 'single', targetIds: ['target-e2e'] } }, bindingSetId: 'bind-ai', executionPolicyId: 'policy-ai', createdAt: T, updatedAt: T }
        return json(route, { rule: state.rule, binding: state.binding, target: currentTarget(), pairing: { pairingId: 'pair-e2e', targetId: 'target-e2e', code: 'once-fixture-code', expiresAt: new Date(Date.now() + 300_000).toISOString() } }, 201)
      }
      if (sub === '/rules/rule-ai') return json(route, state.rule)
      if (sub === '/binding-sets/bind-ai') return json(route, state.binding)
      if (sub === '/rules/rule-ai/run-once/preview') return json(route, { id: 'preview-test', matchedCount: 1, blockedCount: 0, explicitChoiceCount: 1, maxMembers: 1000,
        sample: [{ nodeId: 'b-1', title: 'Grid layout notes', decision: 'explicitChoice' }], expiresAt: new Date(Date.now() + 300_000).toISOString(), sideEffects: false, previewDigest: 'a'.repeat(64), canStart: paired })
      if (sub === '/rules/rule-ai/run-once' || sub === '/runs/test-ai' || sub === '/runs/test-ai-child') return json(route, {
        id: sub.endsWith('child') ? 'test-ai-child' : 'test-ai', revision: '1', ruleId: 'rule-ai', ruleRevision: '1', bindingRevision: '1',
        kind: 'manual', status: testCompleted ? 'completed' : 'running', jobIds: sub.endsWith('child') ? ['job-ai'] : [],
        childRunIds: sub.endsWith('child') ? [] : ['test-ai-child'], recipientTargetIds: ['target-e2e'], memberEventIds: ['event-test'], createdAt: T, updatedAt: T, causationRoot: 'test-ai', effects: [], unread: false, outputCount: 0,
      }, sub.endsWith('/run-once') ? 201 : 200)
      if (sub === '/jobs/job-ai') return json(route, { id: 'job-ai', revision: '1', runId: 'test-ai-child', task: (state.rule?.definition as { tasks: unknown[] }).tasks[0],
        status: testCompleted ? 'succeeded' : 'ready', inputDigest: 'a'.repeat(64), allowedFolders: [], inputsPaged: false, attemptGeneration: 1, createdAt: T })
    }
    if (sub === '/pause') {
      if (method === 'POST') {
        state.paused = Boolean(writes.at(-1)?.body.paused)
        state.pauseRevision += 1
      }
      return json(route, pause())
    }
    if (sub === '/capabilities') {
      return json(route, { contractVersion: '0.2.1-design', ruleApiVersions: ['colp.automation/v1'], runtimeProfiles: [], triggerModes: ['each'], taskTypes: withAgent ? ['summary.generate', 'tags.generate'] : [], eventsEnabled: false, limits: { maxRules: 100, maxExpressionBytes: 4096, maxTasksPerRule: 8 } })
    }
    if (sub === '/rules' && method === 'GET') return json(route, { items: state.rule ? [state.rule] : [], nextCursor: null })
    if (sub === '/binding-sets' && method === 'GET') return json(route, { items: state.binding ? [state.binding] : [], nextCursor: null })
    if (sub === '/binding-sets' && method === 'POST') {
      state.binding = { ...writes.at(-1)?.body, id: 'bind-academic', revision: '1', updatedAt: T }
      return json(route, state.binding, 201)
    }
    if (sub === '/rules/preview') {
      return json(route, {
        previewId: 'preview-e2e', sideEffects: false, plannedRunCount: 1, remainderCount: 0, completeHistory: false, truncated: false, diagnostics: [],
        decisions: [
          { eventId: 'e1', outcome: 'matched', satisfiedTasks: [], pendingTasks: [], explanation: 'Would place in canonical folder f-academic; preview only; no effect.' },
          { eventId: 'e2', outcome: 'notMatched', satisfiedTasks: [], pendingTasks: [], explanation: 'notMatched' },
        ],
      })
    }
    if (sub === '/rules' && method === 'POST') {
      const input = writes.at(-1)?.body ?? {}
      state.rule = { id: 'rule-e2e', revision: '1', desiredState: 'draft', effectiveState: 'draft', definition: input.definition, bindingSetId: input.bindingSetId, createdAt: T, updatedAt: T }
      return json(route, state.rule, 201)
    }
    if (sub === '/rules/rule-e2e/lifecycle' && state.rule) {
      state.rule = { ...state.rule, revision: '2', desiredState: 'enabled', effectiveState: 'active' }
      return json(route, state.rule)
    }
    if (sub === '/incidents' || sub === '/runs') return json(route, { items: [], nextCursor: null })
    return json(route, { error: { code: 'resource_not_found', message: 'Not found', recovery: 'user_action' } }, 404)
  })
  return { writes, connectAgent: () => { paired = true }, completeTest: () => { testCompleted = true } }
}

test.describe('automations with mocked Product API', () => {
  test('connects an AI in the rule editor, resumes its saved draft and waits for task success', async ({ page }, testInfo) => {
    const setup = await mockOwnerWithAutomations(page, true)
    await page.goto('/automations/new?collectionId=col-personal&folderId=f-academic&condition=siteIs:css.example')
    await page.getByLabel('Generate a summary').check()
    await expect(page.getByLabel('AI to use')).toHaveValue('agent:https://chatgpt.com/oauth/client.json')
    await expect(page.getByLabel('Prepared binding set ID')).toBeHidden()
    await page.getByRole('button', { name: 'Connect and test', exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/rules\/rule-ai\/edit$/u)
    await expect(page.getByRole('button', { name: 'Copy connection request', exact: true })).toBeVisible()
    await expect(page.getByLabel('AI to use')).toHaveValue('target:target-e2e')
    await expect(page.getByRole('button', { name: 'Folder Academic' })).toHaveAttribute('value', 'f-academic')
    await expect(page.getByRole('button', { name: 'Copy connection request', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Test on this bookmark' })).toBeHidden()
    await expect(page.getByLabel('Rule definition JSON')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('agent-connection.png'), fullPage: true })
    // A reload restores the saved draft and target, never the one-use code.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Make a new connection request' })).toBeVisible()
    expect(await page.locator('body').innerText()).not.toContain('once-fixture-code')
    setup.connectAgent()
    await expect(page.getByRole('button', { name: 'Test on this bookmark' })).toBeEnabled()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByTestId('automation-turn-on')).toBeDisabled()
    await page.getByRole('button', { name: 'Test on this bookmark' }).click()
    await expect(page).toHaveURL(/agentTest=test-ai/u)
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()
    await expect(page.getByTestId('automation-turn-on')).toBeDisabled()
    // In-flight test identity survives a reload without creating another model job.
    await page.reload()
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()
    setup.completeTest()
    await expect(page.getByText('Test completed. Review the result before turning on this rule.')).toBeVisible()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByTestId('automation-turn-on')).toBeEnabled()
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('agent-test-mobile.png'), fullPage: true })
    const starts = setup.writes.filter(write => write.path.endsWith('/run-once'))
    expect(starts).toHaveLength(1)
    expect(setup.writes.find(write => write.path.endsWith('/run-once/preview'))?.body).toMatchObject({ nodeId: 'b-1', tasksOnly: true, tasks: 'all', moveFolderedBookmarks: false })
    expect(setup.writes.find(write => write.path.endsWith('/agent-setup'))?.body).toMatchObject({ agent: { name: 'ChatGPT', clientId: 'https://chatgpt.com/oauth/client.json' } })
  })

  test('AC-41: Automate… on a folder to an enabled rule, without JSON, previewed first', async ({ page }) => {
    const { writes } = await mockOwnerWithAutomations(page)
    await page.goto('/library', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Automations' })).toBeVisible()

    await page.getByRole('button', { name: 'Actions for Academic' }).click()
    await page.getByRole('menuitem', { name: 'Automate…' }).click()
    await expect(page).toHaveURL(/\/automations\/new\?collectionId=col-personal&folderId=f-academic$/u)
    await expect(page.getByRole('button', { name: 'Folder Academic' })).toHaveAttribute('value', 'f-academic')
    await expect(page.getByText('Advanced: edit as JSON')).toBeVisible()
    await expect(page.getByLabel('Rule definition JSON')).toBeHidden()

    const turnOn = page.getByTestId('automation-turn-on')
    await page.getByLabel('Site is').fill('arxiv.org')
    await expect(page.getByTestId('automation-sentence')).toHaveText('When a bookmark saved to your library is from arxiv.org, move it to Academic.')
    await expect(turnOn).toBeDisabled()

    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByText('Would move to Academic.')).toBeVisible()
    await expect(turnOn).toBeEnabled()

    // An edit after the preview makes it stale; undoing the edit makes it current again.
    await page.getByLabel('Site is').fill('arxiv.org/abs')
    await expect(turnOn).toBeDisabled()
    await expect(page.getByText('You changed the rule after this preview.')).toBeVisible()
    await page.getByLabel('Site is').fill('arxiv.org')
    await expect(turnOn).toBeEnabled()

    await turnOn.click()
    await expect(page).toHaveURL(/\/automations$/u)
    await expect(page.getByTestId('automation-sentence')).toHaveText('When a bookmark saved to your library is from arxiv.org, move it to Academic.')

    const byPath = (suffix: string) => writes.find((write) => write.path === `${A}${suffix}`)
    const binding = byPath('/binding-sets')
    expect(binding?.body).toMatchObject({ values: { destination: { kind: 'folder', folder: { serverUuid: 'server-e2e', collectionId: 'col-personal', nodeId: 'f-academic' } } } })
    const created = byPath('/rules')
    expect(created?.body).toMatchObject({ bindingSetId: 'bind-academic', definition: { name: 'arxiv.org → Academic', tasks: [] } })
    const enabled = byPath('/rules/rule-e2e/lifecycle')
    expect(enabled?.body).toMatchObject({ state: 'enabled', activationPreviewId: 'preview-e2e' })
    expect(enabled?.ifMatch).toBe('"1"')
    for (const write of [binding, created, enabled]) {
      expect(write?.csrf).toBe(CSRF)
      expect(write?.commandId).toMatch(UUID_V4)
    }
  })

  test('AC-44: Pause all shows Paused in the nav on every page until resumed', async ({ page }) => {
    const { writes } = await mockOwnerWithAutomations(page)
    await page.goto('/automations', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('automations-pause-all').click()
    await expect(page.getByTestId('automations-paused')).toContainText('Bookmarks saved while paused are not processed later.')
    expect(writes.find((write) => write.path === `${A}/pause`)).toMatchObject({ ifMatch: '"1"', body: { paused: true } })

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Library' }).click()
    await expect(page).toHaveURL(/\/library$/u)
    await expect(page.getByTestId('automations-paused-flag')).toHaveText('Paused')

    // A fresh page load reads the pause state from the server again.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('automations-paused-flag')).toHaveText('Paused')

    await page.goto('/automations', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('automations-pause-all').click()
    await expect(page.getByTestId('automations-pause-all')).toHaveText('Pause all')
    await expect(page.getByTestId('automations-paused-flag')).toHaveCount(0)
  })
})
