import type { BrowserContext, Route } from '@playwright/test'
import type { ActivityItem } from '../../src/api/activityTypes'
import type { AutomationBindingSet, AutomationPredicate, AutomationRule, AutomationRuleDefinition, AutomationRun } from '../../src/api/automationTypes'
import type { WriteApprovalView } from '../../src/api/types'

/* README screenshots: one fictional account ("Ada", handle ada, the same
   persona and folder names as the extension's shots) and a fixed clock, so
   every page renders the same populated state on every run. Shapes follow
   the generated Product and Automation contracts; nothing here reaches a
   backend. */

/** The browser clock for every capture (a Wednesday morning, UTC). */
export const NOW = '2026-10-28T10:15:00.000Z'

const CREATED = '2026-10-01T08:00:00.000Z'
const CSRF = 'readme-csrf'
const LIBRARY_ID = 'lib-ada'
const ROOT_ID = 'root-ada'
const BAR_ID = 'bar'
const OTHER_ID = 'other'
export const RESEARCH_ID = 'f-research'
export const SHARE_SLUG = 'folder-5f1c9e2ab7d04c3e8a61f0b2d9c47e15'
export const PLAN_ID = 'plan-3b7e91c4'
const SERVER_UUID = 'server-ada'

const account = { id: 'acc-ada', email: 'ada@example.com' }
const profile = { id: 'prof-ada', handle: 'ada', displayName: 'Ada', avatarUrl: null }
const agent = { clientId: 'claude-research-assistant', name: 'Claude (research assistant)' }

/* ── Library tree ─────────────────────────────────────────────────────── */

type Seed =
  | { kind: 'folder'; id: string; title: string; role?: string; description?: string; shared?: true; children: Seed[] }
  | { kind: 'bookmark'; id: string; title: string; url: string; at: string; tags?: string[]; description?: string }

const folder = (id: string, title: string, children: Seed[], extra: { role?: string; description?: string; shared?: true } = {}): Seed =>
  ({ kind: 'folder', id, title, children, ...extra })
const bookmark = (id: string, title: string, url: string, at: string, extra: { tags?: string[]; description?: string } = {}): Seed =>
  ({ kind: 'bookmark', id, title, url, at, ...extra })

const researchSeeds: Seed[] = [
  bookmark('b-attention', 'Attention Is All You Need', 'https://arxiv.org/abs/1706.03762', '2026-10-06T19:12:00.000Z', {
    tags: ['papers', 'transformers'],
    description: 'The paper that introduced the Transformer: attention only, no recurrence or convolutions.',
  }),
  bookmark('b-scaling', 'Scaling Laws for Neural Language Models', 'https://arxiv.org/abs/2001.08361', '2026-10-09T07:40:00.000Z', {
    tags: ['papers', 'scaling'],
  }),
  bookmark('b-constitutional', 'Constitutional AI: Harmlessness from AI Feedback', 'https://arxiv.org/abs/2212.08073', '2026-10-28T09:52:00.000Z', {
    tags: ['papers', 'alignment'],
  }),
  bookmark('b-agents', 'Building effective agents', 'https://www.anthropic.com/engineering/building-effective-agents', '2026-10-28T09:52:00.000Z', {
    tags: ['agents'],
    description: 'Workflows versus agents, and the simple, composable patterns that work in practice.',
  }),
  bookmark('b-mind', 'Mapping the Mind of a Large Language Model', 'https://www.anthropic.com/research/mapping-mind-language-model', '2026-10-28T09:52:00.000Z', {
    tags: ['interpretability'],
    description: 'Millions of interpretable features found inside a production language model.',
  }),
  bookmark('b-wiki-transformer', 'Transformer (deep learning architecture)', 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)', '2026-10-14T21:05:00.000Z'),
  bookmark('b-nanogpt', 'karpathy/nanoGPT', 'https://github.com/karpathy/nanoGPT', '2026-10-20T18:30:00.000Z', {
    tags: ['code'],
    description: 'The simplest, fastest repository for training and fine-tuning medium-sized GPTs.',
  }),
]

/** Saved to Read later; the pending plan on the Approvals page moves them into Research. */
const plannedPapers = [
  { id: 'b-paper-react', title: 'ReAct: Synergizing Reasoning and Acting in Language Models', url: 'https://arxiv.org/abs/2210.03629', added: '2026-10-26T08:20:00.000Z' },
  { id: 'b-paper-toolformer', title: 'Toolformer: Language Models Can Teach Themselves to Use Tools', url: 'https://arxiv.org/abs/2302.04761', added: '2026-10-26T08:22:00.000Z' },
  { id: 'b-paper-reflexion', title: 'Reflexion: Language Agents with Verbal Reinforcement Learning', url: 'https://arxiv.org/abs/2303.11366', added: '2026-10-26T08:25:00.000Z' },
]

const tree: Seed[] = [
  folder(BAR_ID, 'Bookmarks bar', [
    folder('f-marketing', 'Marketing', [
      folder('f-seo', 'SEO', [
        bookmark('b-seo-guide', 'SEO Starter Guide', 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide', '2026-10-03T10:00:00.000Z', { tags: ['seo'] }),
        bookmark('b-vitals', 'Web Vitals', 'https://web.dev/articles/vitals', '2026-10-03T10:05:00.000Z', { tags: ['performance'] }),
      ]),
      bookmark('b-content', 'Content marketing', 'https://en.wikipedia.org/wiki/Content_marketing', '2026-10-02T16:20:00.000Z'),
    ]),
    folder('f-programming', 'Programming', [
      bookmark('b-container', 'Container queries', 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries', '2026-10-27T15:10:00.000Z', { tags: ['css'] }),
      bookmark('b-view-transitions', 'View Transition API', 'https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API', '2026-10-27T15:11:00.000Z', { tags: ['css'] }),
      bookmark('b-typescript', 'TypeScript Handbook', 'https://www.typescriptlang.org/docs/handbook/intro.html', '2026-10-27T15:12:00.000Z', { tags: ['typescript'] }),
      bookmark('b-react', 'facebook/react: The library for web and native user interfaces', 'https://github.com/facebook/react', '2026-10-25T11:02:00.000Z'),
      bookmark('b-rust', 'The Rust Programming Language', 'https://doc.rust-lang.org/book/', '2026-10-19T20:40:00.000Z', { tags: ['rust'] }),
    ]),
    folder('f-read-later', 'Read later', [
      ...plannedPapers.map((paper) => bookmark(paper.id, paper.title, paper.url, paper.added, { tags: ['papers', 'agents'] })),
      bookmark('b-ddia', 'Designing Data-Intensive Applications', 'https://dataintensive.net/', '2026-10-27T15:14:00.000Z'),
      bookmark('b-learn-css', 'Learn CSS', 'https://web.dev/learn/css', '2026-10-18T09:00:00.000Z', { tags: ['css'] }),
    ]),
    folder(RESEARCH_ID, 'Research', researchSeeds, {
      shared: true,
      description: 'Papers and essays on language models, agents and interpretability.',
    }),
  ], { role: 'bookmarks-bar' }),
  folder(OTHER_ID, 'Other bookmarks', [
    folder('f-personal', 'Personal', [
      bookmark('b-lovelace', 'Ada Lovelace', 'https://en.wikipedia.org/wiki/Ada_Lovelace', '2026-10-04T20:00:00.000Z'),
      bookmark('b-sourdough', 'Sourdough', 'https://en.wikipedia.org/wiki/Sourdough', '2026-10-11T08:30:00.000Z'),
    ]),
  ], { role: 'other-bookmarks' }),
]

const position = (index: number) => String.fromCharCode(97 + index)

function flatten(seeds: Seed[], parentId: string): Record<string, unknown>[] {
  return seeds.flatMap((seed, index) => {
    const common = {
      id: seed.id, collectionId: LIBRARY_ID, parentId, position: position(index), title: seed.title,
      description: seed.description ?? null, tags: seed.kind === 'bookmark' ? seed.tags ?? [] : [], visibility: 'inherit',
      revision: '1', etag: `"${seed.id}:1"`, readOnly: false, readOnlyReason: null,
    }
    if (seed.kind === 'bookmark') {
      return [{ ...common, kind: 'bookmark', url: seed.url, iconUrl: null, previewImage: null, createdAt: seed.at, updatedAt: seed.at }]
    }
    return [
      { ...common, kind: 'folder', folderRole: seed.role ?? null, childrenRevision: '1', childrenEtag: `"${seed.id}:c1"`,
        createdAt: CREATED, updatedAt: '2026-10-28T09:52:00.000Z', ...(seed.shared ? { shared: true } : {}) },
      ...flatten(seed.children, seed.id),
    ]
  })
}

const libraryNodes = flatten(tree, ROOT_ID)

const libraryCollection = {
  id: LIBRARY_ID, library: true, kind: 'bookmarks', title: 'Bookmarks', summary: null, visibility: 'private',
  allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: ROOT_ID,
  revision: '12', etag: '"lib-ada:12"', contentRevision: '48', contentEtag: '"lib-ada:c48"',
  policyRevision: '3', policyEtag: '"lib-ada:p3"', createdAt: CREATED, updatedAt: '2026-10-28T09:52:00.000Z',
}
const capabilities = { updateCollection: true, managePublication: false, createNode: true, updateNode: true, moveNode: true, deleteNode: true }

const editorPage = {
  collection: libraryCollection,
  capabilities,
  root: {
    id: ROOT_ID, collectionId: LIBRARY_ID, kind: 'folder', folderRole: 'root', parentId: null, position: null, title: 'Bookmarks',
    description: null, tags: [], visibility: 'inherit', revision: '1', etag: '"root:1"', readOnly: false, readOnlyReason: null,
    childrenRevision: '1', childrenEtag: '"root:c1"', createdAt: CREATED, updatedAt: CREATED,
  },
  nodes: libraryNodes,
  page: {
    snapshotId: 'snapshot-ada', contentRevision: '48', policyRevision: '3', comparatorVersion: '1',
    expiresAt: '2026-10-31T00:00:00.000Z', returnedCount: libraryNodes.length, hasMore: false, nextCursor: null,
  },
}

/** Private notes on library bookmarks, by node id (the desk's comfort rows show them). */
const notes: Record<string, string> = {
  'b-constitutional': 'Read with the RLHF paper. Section 3 explains the critique-and-revise loop.',
}

function annotationPage(nodeId: string) {
  const text = notes[nodeId]
  const annotations = text ? [{
    id: `note-${nodeId}`, collectionId: LIBRARY_ID, subject: { type: 'node', id: nodeId }, type: 'note', format: 'plain',
    value: text, visibility: 'private', creator: null, provenance: null, revision: '1',
    createdAt: '2026-10-28T09:58:00.000Z', updatedAt: '2026-10-28T09:58:00.000Z', extensions: {},
  }] : []
  return { annotations, page: { returnedCount: annotations.length, hasMore: false, nextCursor: null } }
}

/* ── Shared Research folder (/c/:slug) ────────────────────────────────── */

function sharedFolderSnapshot() {
  const research = libraryNodes.find((node) => node.id === RESEARCH_ID)!
  const inside = libraryNodes.filter((node) => node.parentId === RESEARCH_ID)
  return {
    collection: {
      id: LIBRARY_ID, slug: SHARE_SLUG, folderShare: true, title: 'Research', summary: research.description,
      kind: 'bookmarks', rootNodeId: RESEARCH_ID, updatedAt: '2026-10-28T09:52:00.000Z', access: 'public',
      viewCount: 0, curatorNote: null, faviconCdnAllowed: false,
      owner: { profileId: profile.id, handle: profile.handle, displayName: profile.displayName, avatarUrl: null },
    },
    nodes: [
      { id: RESEARCH_ID, parentId: null, kind: 'root', title: 'Research', description: research.description, url: null, position: null, iconUrl: null },
      ...inside.map((node) => ({
        id: node.id, parentId: RESEARCH_ID, kind: 'bookmark', title: node.title, description: node.description, url: node.url,
        position: node.position, iconUrl: null, previewImage: null, faviconCdnAllowed: false,
      })),
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

/* ── Write approval: the agent moves three arXiv papers from Read later into Research ── */

const approval: WriteApprovalView = {
  planId: PLAN_ID,
  agent,
  reason: 'You asked me to file the agent papers waiting in Read later. These three belong with your other research papers.',
  status: 'pending',
  risk: 'medium',
  requiresApproval: true,
  summary: 'Move 3 arXiv papers from Read later to Research',
  impact: { collections: 1, nodes: 3, annotations: 0, attachments: 0, relations: 0, privateFieldsExcluded: [] },
  requiredScopes: ['nodes:write'],
  target: { kind: 'collection', collectionId: LIBRARY_ID, nodeId: null },
  // The server's planner writes `move <title> from <path> to <path>` from stored paths, never agent text.
  operations: plannedPapers.map((paper) => ({
    type: 'move_node', collectionId: LIBRARY_ID, nodeId: paper.id, visibility: null,
    description: `move ${paper.title} from /Bookmarks bar/Read later to /Bookmarks bar/Research`,
    nodeSummary: { kind: 'bookmark', title: paper.title, url: paper.url, visibility: 'inherit' },
  })),
  createdAt: '2026-10-28T10:04:00.000Z',
  expiresAt: '2026-10-29T10:04:00.000Z',
  decision: 'pending',
  etag: `"${PLAN_ID}:1"`,
}

/* ── Automations ──────────────────────────────────────────────────────── */

const site = (value: string): AutomationPredicate => ({ kind: 'field', field: 'bookmark.url.host', op: 'eq', value })
const siteSuffix = (value: string): AutomationPredicate => ({ kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value })

function definition(name: string, match: AutomationPredicate): AutomationRuleDefinition {
  return {
    apiVersion: 'colp.automation/v1',
    name,
    roles: [{ key: 'destination', kind: 'folder', required: true, description: 'Folder matching bookmarks are moved to' }],
    on: 'bookmark.intake',
    scope: { collectionId: LIBRARY_ID },
    match,
    intake: { folderRole: 'destination', constraint: 'withinSubtree', satisfies: ['classify.root'], onUnusableBinding: 'keepOriginalAndBlock', respectExplicitSelection: true },
    trigger: { mode: 'each' },
    tasks: [],
    route: { mode: 'targets', targetIds: [], execution: 'single' },
    policy: {
      history: 'fromActivation', imports: 'exclude', restores: 'exclude', userEdits: 'preserve', sameStageReentry: 'deny', maxHops: 8,
      conflictingPlacement: 'review', privacy: 'standard', broadcastAllowed: false, maxRunsPerDay: 100, pauseMode: 'stopAdmissionHoldPending', missingInput: 'defer',
    },
    priority: 100,
  }
}

function usage(admittedRuns: number) {
  return {
    periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-10-31T00:00:00.000Z', admittedRuns,
    readyJobs: 0, succeededJobs: 0, heldJobs: 0, externalCosts: 'notApplicable' as const, costDisplay: 'No external costs.',
  }
}

const ruleSeeds = [
  { id: 'rule-arxiv', name: 'Papers from arXiv', match: site('arxiv.org'), folder: RESEARCH_ID, state: 'enabled', runs: 23, at: '2026-10-05T09:00:00.000Z' },
  { id: 'rule-mdn', name: 'Docs from MDN', match: site('developer.mozilla.org'), folder: 'f-programming', state: 'enabled', runs: 14, at: '2026-10-07T12:30:00.000Z' },
  { id: 'rule-github', name: 'GitHub repositories to Programming', match: siteSuffix('github.com'), folder: 'f-programming', state: 'enabled', runs: 9, at: '2026-10-07T12:42:00.000Z' },
  { id: 'rule-videos', name: 'Videos to Read later', match: siteSuffix('youtube.com'), folder: 'f-read-later', state: 'paused', runs: 0, at: '2026-10-21T18:15:00.000Z' },
] as const

const rules: AutomationRule[] = ruleSeeds.map((seed) => ({
  id: seed.id,
  revision: '4',
  desiredState: seed.state,
  effectiveState: seed.state === 'enabled' ? 'active' : 'paused',
  definition: definition(seed.name, seed.match),
  bindingSetId: `bind-${seed.id}`,
  createdAt: seed.at,
  updatedAt: seed.at,
  ...(seed.runs > 0 ? { usage: usage(seed.runs) } : {}),
}))

const bindingSets: AutomationBindingSet[] = ruleSeeds.map((seed) => ({
  id: `bind-${seed.id}`,
  revision: '1',
  name: seed.name,
  updatedAt: seed.at,
  values: { destination: { kind: 'folder', folder: { serverUuid: SERVER_UUID, collectionId: LIBRARY_ID, nodeId: seed.folder },
    followIdentity: true, onUnavailable: 'block', notifyOn: ['delete'] } },
}))

const MOVED = 'Matched the pinned rule and moved from the default root to its verified canonical destination.'
const BROWSER = 'Canonical device placement verified against the pinned rule and binding.'
const ALREADY = 'Already in the verified destination; no canonical mutation required.'

function run(id: string, ruleId: string, at: string, patch: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id, revision: '2', ruleId, ruleRevision: '4', bindingRevision: '1', executionPolicyRevision: null, status: 'completed',
    memberEventIds: [`evt-${id}`], recipientTargetIds: [], createdAt: at, updatedAt: at, jobIds: [], causationRoot: id,
    kind: 'intake', effects: [], unread: false, outputCount: 0, ...patch,
  }
}

const runs: AutomationRun[] = [
  run('run-1048', 'rule-arxiv', '2026-10-28T09:40:00.000Z', { explanation: MOVED }),
  run('run-1047', 'rule-mdn', '2026-10-28T08:05:00.000Z', { explanation: BROWSER }),
  run('run-1046', 'rule-mdn', '2026-10-28T07:20:00.000Z', { kind: 'manual', status: 'partial' }),
  run('run-1045', 'rule-github', '2026-10-27T16:20:00.000Z', { explanation: MOVED }),
  run('run-1044', 'rule-arxiv', '2026-10-27T09:12:00.000Z', { explanation: ALREADY }),
  run('run-1043', 'rule-github', '2026-10-25T11:02:00.000Z', { explanation: MOVED }),
]

/* ── Activity inbox ───────────────────────────────────────────────────── */

const library = { id: LIBRARY_ID, title: 'Bookmarks' }
const activityAgent = { ...agent, kind: 'oauth_client' as const }

function activity(id: string, kind: ActivityItem['kind'], at: string, unread: boolean, patch: Partial<ActivityItem>): ActivityItem {
  return {
    id, kind, state: unread ? 'unread' : 'read', revision: '1', occurredAt: at, updatedAt: at,
    readAt: unread ? null : at, count: 0, agent: null, collection: library, folders: [], items: [], run: null, ...patch,
  }
}

function ruleRun(runId: string, ruleId: string, status: string) {
  return { id: runId, ruleId, ruleName: ruleSeeds.find((seed) => seed.id === ruleId)!.name, status, outputCount: 0, attention: null }
}

const activityItems: ActivityItem[] = [
  activity('act-6', 'agent_bookmarks_added', '2026-10-28T09:52:00.000Z', true, {
    count: 3, agent: activityAgent,
    folders: [{ nodeId: RESEARCH_ID, title: 'Research', count: 3 }],
    items: [
      { nodeId: 'b-agents', title: 'Building effective agents', host: 'www.anthropic.com', occurredAt: '2026-10-28T09:52:00.000Z' },
      { nodeId: 'b-mind', title: 'Mapping the Mind of a Large Language Model', host: 'www.anthropic.com', occurredAt: '2026-10-28T09:52:00.000Z' },
      { nodeId: 'b-constitutional', title: 'Constitutional AI: Harmlessness from AI Feedback', host: 'arxiv.org', occurredAt: '2026-10-28T09:52:00.000Z' },
    ],
  }),
  activity('act-5', 'run_completed', '2026-10-28T09:40:00.000Z', true, { run: ruleRun('run-1048', 'rule-arxiv', 'completed') }),
  activity('act-4', 'run_partial', '2026-10-28T07:20:00.000Z', false, { run: ruleRun('run-1046', 'rule-mdn', 'partial') }),
  activity('act-3', 'agent_bookmarks_added', '2026-10-27T15:14:00.000Z', false, {
    count: 4, agent: activityAgent,
    folders: [{ nodeId: 'f-programming', title: 'Programming', count: 3 }, { nodeId: 'f-read-later', title: 'Read later', count: 1 }],
    items: [
      { nodeId: 'b-container', title: 'Container queries', host: 'developer.mozilla.org', occurredAt: '2026-10-27T15:10:00.000Z' },
      { nodeId: 'b-view-transitions', title: 'View Transition API', host: 'developer.mozilla.org', occurredAt: '2026-10-27T15:11:00.000Z' },
      { nodeId: 'b-typescript', title: 'TypeScript Handbook', host: 'www.typescriptlang.org', occurredAt: '2026-10-27T15:12:00.000Z' },
      { nodeId: 'b-ddia', title: 'Designing Data-Intensive Applications', host: 'dataintensive.net', occurredAt: '2026-10-27T15:14:00.000Z' },
    ],
  }),
  activity('act-2', 'run_completed', '2026-10-25T11:02:00.000Z', false, { run: ruleRun('run-1043', 'rule-github', 'completed') }),
]
const unreadActivity = activityItems.filter((item) => item.state === 'unread').length

/* ── Router ───────────────────────────────────────────────────────────── */

type Json = Record<string, unknown> | unknown[]

function json(route: Route, body: Json, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store', ...headers }, body: JSON.stringify(body) })
}

function notFound(route: Route) {
  return json(route, { error: { code: 'resource_not_found', message: 'Not found', recovery: 'user_action', sameRequestRetrySafe: false } }, 404)
}

const emptyPage = { items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }

/**
 * Answers every request the five captured pages make. `signedIn: false` is a
 * visitor with no session. Requests this router does not know are aborted
 * and listed in the returned array, so a capture can fail instead of
 * screenshotting an error state. Third-party hosts are blocked outright:
 * the shots never hotlink anyone's images.
 */
export async function installReadmeApi(context: BrowserContext, { signedIn }: { signedIn: boolean }): Promise<string[]> {
  const unexpected: string[] = []
  let unread = unreadActivity

  await context.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (route) => {
    unexpected.push(`external ${route.request().method()} ${route.request().url()}`)
    return route.abort('blockedbyclient')
  })
  await context.route(/\/(?:collections|colp)\/|\/(?:health|ready)$/u, (route) => {
    const url = new URL(route.request().url())
    // Only the dev proxy's prefixes, never SPA routes such as /c/:slug.
    if (!/^\/(?:collections|colp)\/|^\/(?:health|ready)$/u.test(url.pathname)) return route.fallback()
    unexpected.push(`${route.request().method()} ${url.pathname}`)
    return route.abort('blockedbyclient')
  })
  /* The server's manifest: its identity (folder bindings carry it) and an
     HTTPS transport, so no plain-HTTP warning toast. */
  await context.route('**/.well-known/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/.well-known/collection-protocol') {
      return json(route, { serverUuid: SERVER_UUID, 'https://know-n.com/colp/extensions/server': { transport: 'https' } })
    }
    unexpected.push(`${route.request().method()} ${url.pathname}`)
    return route.abort('blockedbyclient')
  })

  await context.route(/\/api(?:\/|$)/u, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    if (!path.startsWith('/api/')) return route.fallback()

    if (path === '/api/v1/session' && method === 'GET') {
      return json(route, signedIn
        ? { authenticated: true, csrfToken: CSRF, idleExpiresAt: '2026-10-28T22:15:00.000Z', absoluteExpiresAt: '2026-10-31T10:15:00.000Z' }
        : { authenticated: false })
    }
    if (path === `/api/v1/collections/${SHARE_SLUG}` && method === 'GET') return json(route, sharedFolderSnapshot())
    if (path === '/api/v1/auth/registration-state') return json(route, { open: false, reason: 'closed' })

    if (signedIn && method === 'GET') {
      switch (path) {
        case '/api/v1/me': return json(route, { account, profile })
        case '/api/v1/me/library':
          return json(route, { id: LIBRARY_ID, title: 'Bookmarks', rootNodeId: ROOT_ID, library: true, bookmarksBarId: BAR_ID, otherBookmarksId: OTHER_ID })
        case '/api/v1/collections':
          return json(route, { items: [{ collection: libraryCollection, capabilities, bookmarkCount: researchSeeds.length + 14 }],
            page: { returnedCount: 1, hasMore: false, nextCursor: null } })
        case `/api/v1/collections/${LIBRARY_ID}/editor`:
          return json(route, editorPage, 200, { 'Known-Editor-Revision': 'ada-read-48' })
        case `/api/v1/collections/${LIBRARY_ID}/annotations`:
          return json(route, annotationPage(url.searchParams.get('resourceId') ?? ''))
        case '/api/v1/me/shared-collections':
        case '/api/v1/me/collaboration-invites':
          return json(route, emptyPage)
        case '/api/v1/me/library-order':
          return json(route, { sections: { mine: [], shared: [], following: [] } })
        case '/api/v1/sync/status':
          return json(route, { devices: [], replicas: [] })
        case '/api/v1/me/agents':
          return json(route, { agents: [{ id: agent.clientId, name: agent.name, kind: 'oauth_client',
            scopes: ['collections:read', 'nodes:read', 'nodes:write'], createdAt: '2026-10-02T09:00:00.000Z', lastSeenAt: '2026-10-28T10:04:00.000Z', policy: 'manual' }] })
        case '/api/v1/me/favicon-policy':
          return route.fulfill({ json: { revision: '1', newDefault: 'capture', providerTemplate: 'https://favicone.com/{hostname}', fillMissing: false, forceAllOnline: false },
            headers: { ETag: '"favicon-policy:1"' } })
        case '/api/v1/mcp/approvals':
          return json(route, { items: [approval], nextCursor: null })
        case `/api/v1/mcp/approvals/${PLAN_ID}`:
          return json(route, approval)
        case '/api/v1/me/activity':
          return json(route, { items: url.searchParams.get('state') === 'unread' ? activityItems.filter((item) => item.state === 'unread') : activityItems,
            nextCursor: null, unreadCount: unread })
        case '/api/v1/me/activity/summary':
          return json(route, { unreadCount: unread, latest: activityItems[0]!, revision: '6' })
        case '/api/v1/me/automations/pause':
          return json(route, { paused: false, pausedAt: null, pausedBy: null, revision: '3', heldJobs: 0 })
        case '/api/v1/me/automations/rules':
          return json(route, { items: rules, nextCursor: null })
        case '/api/v1/me/automations/binding-sets':
          return json(route, { items: bindingSets, nextCursor: null })
        case '/api/v1/me/automations/incidents':
          return json(route, { items: [], nextCursor: null })
        case '/api/v1/me/automations/runs':
          return json(route, { items: runs, nextCursor: null })
      }
      if (/^\/api\/v1\/collections\/[^/]+\/nodes\/[^/]+\/favicon-source$/u.test(path)) return notFound(route)
    }
    if (signedIn && method === 'HEAD' && path === `/api/v1/collections/${LIBRARY_ID}/editor`) {
      return route.fulfill({ status: 200, headers: { 'Known-Editor-Revision': 'ada-read-48' }, body: '' })
    }
    // Opening the inbox marks what it shows as read; the New markers stay for this visit.
    if (signedIn && method === 'POST' && path === '/api/v1/me/activity/read') {
      const readCount = unread
      unread = 0
      return json(route, { readCount, unreadCount: 0 })
    }

    unexpected.push(`${method} ${path}${url.search}`)
    return route.abort('blockedbyclient')
  })
  return unexpected
}
