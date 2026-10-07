/** Extra mock data for deepened UI demos (sync, path, inbox, notifications, …). */

export const syncFolders = [
  {
    id: 'sf-bar',
    name: 'Bookmarks Bar',
    count: 42,
    selected: true,
    privateLocal: false,
  },
  {
    id: 'sf-design',
    name: 'Design systems',
    count: 64,
    selected: true,
    privateLocal: false,
  },
  {
    id: 'sf-later',
    name: 'Reading later',
    count: 128,
    selected: true,
    privateLocal: false,
  },
  {
    id: 'sf-tools',
    name: 'Tools',
    count: 91,
    selected: false,
    privateLocal: false,
  },
  {
    id: 'sf-personal',
    name: 'Personal / banking',
    count: 18,
    selected: false,
    privateLocal: true,
  },
  {
    id: 'sf-archive',
    name: 'Archive 2024',
    count: 240,
    selected: false,
    privateLocal: false,
  },
]

export type SyncConflict = {
  id: string
  title: string
  url: string
  folder: string
  local: { title: string; note: string; updated: string }
  cloud: { title: string; note: string; updated: string }
  resolution: 'pending' | 'local' | 'cloud' | 'both'
}

export const syncConflictsSeed: SyncConflict[] = [
  {
    id: 'cf1',
    title: 'Every Layout',
    url: 'https://every-layout.dev',
    folder: 'Design systems',
    local: {
      title: 'Every Layout — primitives',
      note: 'Sidebar stack first',
      updated: 'Today 09:12',
    },
    cloud: {
      title: 'Every Layout',
      note: 'Use for density experiments',
      updated: 'Today 08:40',
    },
    resolution: 'pending',
  },
  {
    id: 'cf2',
    title: 'vercel/satori',
    url: 'https://github.com/vercel/satori',
    folder: 'Tools',
    local: {
      title: 'satori (OG)',
      note: 'Pinned for share cards',
      updated: 'Yesterday',
    },
    cloud: {
      title: 'vercel/satori',
      note: '',
      updated: '2d ago',
    },
    resolution: 'pending',
  },
  {
    id: 'cf3',
    title: '知乎 · 分布式系统入门书单',
    url: 'https://zhihu.com',
    folder: 'Reading later',
    local: {
      title: '分布式系统入门书单',
      note: '先读两本',
      updated: 'Today 07:55',
    },
    cloud: {
      title: '知乎 · 分布式系统入门书单',
      note: '入门书单：网络 → 一致性',
      updated: 'Today 09:41',
    },
    resolution: 'pending',
  },
]

export type ClassifyInboxItem = {
  id: string
  title: string
  host: string
  summary: string
  tags: string[]
  suggestions: Array<{
    id: string
    folder: string
    reason: string
    confidence: number
    isNew?: boolean
  }>
}

export const classifyInbox: ClassifyInboxItem[] = [
  {
    id: 'in1',
    title: 'Spacing as a system, not decoration',
    host: 'example.com',
    summary:
      'Essay on modular spacing scales for product UI — vertical rhythm, density modes, editorial grids.',
    tags: ['article', 'design', 'layout'],
    suggestions: [
      {
        id: 's1',
        folder: 'Design systems',
        reason: 'Layout primitives and density language.',
        confidence: 92,
      },
      {
        id: 's2',
        folder: 'Reading later',
        reason: 'Long-form; weak project match.',
        confidence: 61,
      },
      {
        id: 's3',
        folder: 'Create: Editorial layout',
        reason: 'New cluster around magazine grids.',
        confidence: 74,
        isNew: true,
      },
    ],
  },
  {
    id: 'in2',
    title: 'OpenTelemetry batch job SLOs',
    host: 'github.com',
    summary: 'Checklist repo for tracing workers and defining error budgets.',
    tags: ['github', 'ops'],
    suggestions: [
      {
        id: 's1',
        folder: 'Tools',
        reason: 'Repo + ops tooling signal.',
        confidence: 88,
      },
      {
        id: 's2',
        folder: 'Create: Observability',
        reason: 'Strong cluster with your ML Ops follows.',
        confidence: 81,
        isNew: true,
      },
      {
        id: 's3',
        folder: 'Unsorted',
        reason: 'Keep private until you decide.',
        confidence: 40,
      },
    ],
  },
  {
    id: 'in3',
    title: 'Citation graphs for personal libraries',
    host: 'arxiv.org',
    summary: 'Preprint on ranking saved papers by local co-citation.',
    tags: ['arxiv', 'ml'],
    suggestions: [
      {
        id: 's1',
        folder: 'Reading later',
        reason: 'Academic long-read pattern.',
        confidence: 79,
      },
      {
        id: 's2',
        folder: 'Create: Retrieval paths',
        reason: 'Matches Database Internals + your AI chat topics.',
        confidence: 71,
        isNew: true,
      },
    ],
  },
  {
    id: 'in4',
    title: 'How experts teach themselves online',
    host: 'nytimes.com',
    summary: 'Feature on public curricula and followable paths.',
    tags: ['article', 'culture'],
    suggestions: [
      {
        id: 's1',
        folder: 'Reading later',
        reason: 'General interest long-form.',
        confidence: 70,
      },
      {
        id: 's2',
        folder: 'Design systems',
        reason: 'Weak — only tangential to craft.',
        confidence: 28,
      },
    ],
  },
]

export const readingPathSteps = [
  {
    id: 'ps1',
    resourceId: 'path',
    title: 'Suggested reading path',
    host: 'known',
    type: 'path' as const,
    summary: 'Orientation: why systems thinking beats component shopping.',
    minutes: 4,
  },
  {
    id: 'ps2',
    resourceId: 'github',
    title: 'radix-ui / primitives',
    host: 'github.com',
    type: 'github' as const,
    summary: 'Build vocabulary with accessible primitives.',
    minutes: 18,
  },
  {
    id: 'ps3',
    resourceId: 'youtube',
    title: 'Bret Victor — Inventing on Principle',
    host: 'youtube.com',
    type: 'youtube' as const,
    summary: 'Case study: interfaces that reveal intermediate state.',
    minutes: 54,
  },
  {
    id: 'ps4',
    resourceId: 'medium',
    title: 'Design engineering as a practice',
    host: 'medium.com',
    type: 'medium' as const,
    summary: 'Bridge craft and production constraints.',
    minutes: 12,
  },
  {
    id: 'ps5',
    resourceId: 'figma',
    title: 'Variable modes for density',
    host: 'figma.com',
    type: 'figma' as const,
    summary: 'Apply tokens to comfortable / compact desks.',
    minutes: 15,
  },
  {
    id: 'ps6',
    resourceId: 'codepen',
    title: 'Container query bento board',
    host: 'codepen.io',
    type: 'codepen' as const,
    summary: 'Hands-on: rewrite card content by size.',
    minutes: 20,
  },
  {
    id: 'ps7',
    resourceId: 'acm',
    title: 'Curated paths as navigational interfaces',
    host: 'dl.acm.org',
    type: 'acm' as const,
    summary: 'Research close: sequence, provenance, trust.',
    minutes: 25,
  },
]

export type AppNotification = {
  id: string
  kind: 'follow' | 'sync' | 'path' | 'system'
  title: string
  body: string
  time: string
  href: string
  unread: boolean
}

export const notificationsSeed: AppNotification[] = [
  {
    id: 'n1',
    kind: 'follow',
    title: 'Alex Rivera followed Interface Systems',
    body: 'Your latest public path now appears in Alex Rivera’s updates.',
    time: '12m',
    href: '/creator',
    unread: true,
  },
  {
    id: 'n2',
    kind: 'follow',
    title: 'Mira Okada followed you',
    body: 'You appear in her Following list — consider pinning a public path.',
    time: '1h',
    href: '/u/mira',
    unread: true,
  },
  {
    id: 'n3',
    kind: 'sync',
    title: 'Sync finished · 3 conflicts',
    body: 'Chrome bridge needs a decision on Design systems titles.',
    time: '2h',
    href: '/sync',
    unread: true,
  },
  {
    id: 'n4',
    kind: 'path',
    title: 'Path update from Kai Rivers',
    body: 'ML Ops Field Notes · stage checklist revised.',
    time: '5h',
    href: '/c/ml-ops-field-notes',
    unread: false,
  },
  {
    id: 'n5',
    kind: 'system',
    title: 'Weekly digest ready',
    body: 'See which public collections and resources people opened this week.',
    time: '1d',
    href: '/creator',
    unread: false,
  },
  {
    id: 'n6',
    kind: 'path',
    title: 'You completed step 2 of Interface Systems',
    body: 'Continue with the Bret Victor talk.',
    time: '1d',
    href: '/path/interface-systems',
    unread: false,
  },
]

export const deskModuleCatalog = [
  {
    id: 'mod-pomodoro',
    title: 'Pomodoro',
    body: '25 / 5 / 15 focus cycles with session count.',
    kind: 'pomodoro',
    installed: true,
  },
  {
    id: 'mod-clock',
    title: 'Clock',
    body: 'Local time, date, and timezone on the board.',
    kind: 'clock',
    installed: true,
  },
  {
    id: 'mod-quicklinks',
    title: 'Quick links',
    body: 'Editable shortcuts to Know-N pages or URLs.',
    kind: 'quicklinks',
    installed: true,
  },
  {
    id: 'mod-habits',
    title: 'Habits',
    body: 'Daily checklist that resets each calendar day.',
    kind: 'habits',
    installed: true,
  },
  {
    id: 'mod-reading',
    title: 'Reading queue',
    body: 'Open library items — mark read without leaving.',
    kind: 'reading',
    installed: true,
  },
  {
    id: 'mod-weather',
    title: 'Weather',
    body: 'Local conditions for your start page.',
    kind: 'weather',
    installed: true,
  },
  {
    id: 'mod-todo',
    title: 'Todo list',
    body: 'Checklists that persist in local storage.',
    kind: 'todo',
    installed: true,
  },
  {
    id: 'mod-note',
    title: 'Sticky note',
    body: 'Scratch pad for the day.',
    kind: 'sticky',
    installed: true,
  },
  {
    id: 'mod-ssh',
    title: 'SSH terminal',
    body: 'Demo shell — type commands, fake remote host.',
    kind: 'ssh',
    installed: true,
  },
  {
    id: 'mod-heatmap',
    title: 'GitHub heatmap',
    body: 'Contribution graph for the last 12 months (seeded demo).',
    kind: 'ghheatmap',
    installed: true,
  },
  {
    id: 'mod-ai-chat',
    title: 'AI chat',
    body: 'Ask your collections and switch between AI models.',
    kind: 'aichat',
    installed: true,
  },
  {
    id: 'mod-wordbook',
    title: 'Word book',
    body: 'Capture vocabulary, reveal meanings, and track mastery.',
    kind: 'wordbook',
    installed: true,
  },
  {
    id: 'mod-search',
    title: 'Start-page search',
    body: 'Search Know-N or the open web from the start page.',
    kind: 'search',
    installed: true,
  },
  {
    id: 'mod-col',
    title: 'Pinned collection',
    body: 'Embed any public path as a scrollable list.',
    kind: 'collection',
    installed: true,
  },
]

export const creatorAnalytics = {
  funnel: [
    { label: 'Collection views', value: 18420 },
    { label: 'Preview opens', value: 6120 },
  ],
  weekly: [
    { w: 'W1', views: 2100 },
    { w: 'W2', views: 2450 },
    { w: 'W3', views: 2680 },
    { w: 'W4', views: 3010 },
  ],
  topResources: [
    { id: 'github', title: 'radix-ui / primitives', opens: 1840 },
    { id: 'path', title: 'Suggested reading path', opens: 1620 },
    { id: 'youtube', title: 'Inventing on Principle', opens: 980 },
  ],
}

export const profileActivity = [
  {
    id: 'pa1',
    text: 'Updated Interface Systems · stage 2 path',
    time: '3h',
    href: '/c/interface-systems',
  },
  {
    id: 'pa2',
    text: 'Published note on container-query boards',
    time: '1d',
    href: '/r/codepen',
  },
  {
    id: 'pa3',
    text: 'Followed Kai Rivers',
    time: '2d',
    href: '/u/kai',
  },
]

export const profileFollowing = [
  { handle: 'kai', name: 'Kai Rivers', focus: 'ML ops' },
  { handle: 'lin', name: 'Lin Wei', focus: 'Product culture' },
]

export type EditableResource = {
  id: string
  title: string
  host: string
  type: string
  locked: boolean
  inPath: boolean
  pathOrder: number | null
}

export const editableResourcesSeed: EditableResource[] = [
  {
    id: 'path',
    title: 'Suggested reading path',
    host: 'known',
    type: 'Path',
    locked: false,
    inPath: true,
    pathOrder: 1,
  },
  {
    id: 'github',
    title: 'radix-ui / primitives',
    host: 'github.com',
    type: 'GitHub',
    locked: false,
    inPath: true,
    pathOrder: 2,
  },
  {
    id: 'youtube',
    title: 'Inventing on Principle',
    host: 'youtube.com',
    type: 'YouTube',
    locked: false,
    inPath: true,
    pathOrder: 3,
  },
  {
    id: 'medium',
    title: 'Design engineering as a practice',
    host: 'medium.com',
    type: 'Medium',
    locked: true,
    inPath: true,
    pathOrder: 4,
  },
  {
    id: 'figma',
    title: 'Variable modes for density',
    host: 'figma.com',
    type: 'Figma',
    locked: true,
    inPath: false,
    pathOrder: null,
  },
  {
    id: 'arxiv',
    title: 'Learning to organize web knowledge',
    host: 'arxiv.org',
    type: 'arXiv',
    locked: true,
    inPath: false,
    pathOrder: null,
  },
  {
    id: 'notion',
    title: 'Internal design system wiki',
    host: 'notion.so',
    type: 'Notion',
    locked: false,
    inPath: false,
    pathOrder: null,
  },
]
