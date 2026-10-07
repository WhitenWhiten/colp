export type TodayTask = {
  id: string
  title: string
  host: string
  context: string
  minutes: number
  resourceId: string
}

export const todayTasks: TodayTask[] = [
  {
    id: 'today-1',
    title: 'Spacing as a system, not decoration',
    host: 'medium.com',
    context: 'Continue Interface Systems · Stage 2',
    minutes: 8,
    resourceId: 'medium',
  },
  {
    id: 'today-2',
    title: 'Design Consistency at Scale',
    host: 'arxiv.org',
    context: 'Saved yesterday · Reading later',
    minutes: 18,
    resourceId: 'arxiv',
  },
  {
    id: 'today-3',
    title: 'Inventing on Principle',
    host: 'youtube.com',
    context: 'Resume at 21:08 · Interface Systems',
    minutes: 33,
    resourceId: 'youtube',
  },
]

export type CollectionVersion = {
  id: string
  label: string
  publishedAt: string
  author: string
  note: string
  resources: number
  memberOnly: number
  status: 'published' | 'draft'
  changes: Array<{
    type: 'added' | 'removed' | 'moved' | 'edited' | 'access'
    title: string
    detail: string
  }>
}

export const collectionVersions: CollectionVersion[] = [
  {
    id: 'v18',
    label: 'Version 18',
    publishedAt: 'Today · 10:24',
    author: 'Alex Chen',
    note: 'Tightened the systems stage and added a practical token pipeline.',
    resources: 48,
    memberOnly: 8,
    status: 'published',
    changes: [
      { type: 'added', title: 'Design systems at platform scale', detail: 'Added to Systems · step 7' },
      { type: 'moved', title: 'Spacing as a system, not decoration', detail: 'Moved from step 8 to step 5' },
      { type: 'edited', title: 'Stage 2 introduction', detail: 'Clarified the transition from primitives to layout' },
      { type: 'edited', title: 'Interface Systems Starter', detail: 'Updated summary and reading order' },
    ],
  },
  {
    id: 'v17',
    label: 'Version 17',
    publishedAt: 'Jul 12 · 16:40',
    author: 'Mira Okada',
    note: 'Added citation context and repaired two source links.',
    resources: 47,
    memberOnly: 7,
    status: 'published',
    changes: [
      { type: 'added', title: 'Curated paths as navigational interfaces', detail: 'Added to Case studies' },
      { type: 'edited', title: 'Gestalt psychology', detail: 'Updated summary and source metadata' },
      { type: 'removed', title: 'Old layout systems roundup', detail: 'Removed because the source is unavailable' },
    ],
  },
  {
    id: 'draft-19',
    label: 'Draft 19',
    publishedAt: 'Autosaved 12 min ago',
    author: 'Alex Chen',
    note: 'Working draft with a shorter opening stage.',
    resources: 49,
    memberOnly: 8,
    status: 'draft',
    changes: [
      { type: 'added', title: 'Container query bento board', detail: 'Proposed for Layout · step 6' },
      { type: 'moved', title: 'Inventing on Principle', detail: 'Proposed move from step 3 to step 2' },
    ],
  },
  {
    id: 'v16',
    label: 'Version 16',
    publishedAt: 'Jul 3 · 09:15',
    author: 'Mira Okada',
    note: 'Introduced the four-stage reading path.',
    resources: 46,
    memberOnly: 7,
    status: 'published',
    changes: [
      { type: 'edited', title: 'Reading path', detail: 'Reorganized into Primitives, Layout, Systems, Case studies' },
      { type: 'edited', title: 'Curator notes', detail: 'Expanded notes for seven advanced resources' },
    ],
  },
]

export const readerSections = [
  {
    id: 'orientation',
    heading: 'A system is a record of decisions',
    paragraphs: [
      'A design system is often described as a library of reusable components. That definition is convenient, but incomplete. The useful part of a system is the chain of decisions that makes one component behave like the next.',
      'When spacing, type, focus, and state are negotiated separately in every feature, the interface slowly loses its shared language. A system makes those decisions visible enough to reuse and specific enough to challenge.',
    ],
  },
  {
    id: 'primitives',
    heading: 'Start with constraints, then primitives',
    paragraphs: [
      'Primitives work when they preserve the difficult behavior and leave product meaning to the application. Focus management, keyboard order, labeling, and collision handling belong low in the stack because every consumer needs them.',
      'The boundary matters. A primitive that knows too much about publishing or collection ownership becomes difficult to reuse. A product component that knows nothing about accessibility forces every team to solve the same problem again.',
    ],
  },
  {
    id: 'practice',
    heading: 'Treat documentation as an interface',
    paragraphs: [
      'Good documentation helps a contributor decide whether a pattern fits before they copy code. It should show the intended use, the failure modes, the available states, and the reason the pattern exists.',
      'The strongest systems do not remove judgment. They make recurring decisions cheap so teams can spend judgment where the product is genuinely different.',
    ],
  },
]

export type HealthStatus = 'healthy' | 'redirect' | 'broken' | 'duplicate' | 'stale'

export type HealthResource = {
  id: string
  title: string
  host: string
  collection: string
  status: HealthStatus
  detail: string
  checked: string
  suggestedAction: string
}

export const healthResourcesSeed: HealthResource[] = [
  { id: 'health-1', title: 'Old layout systems roundup', host: 'layoutroundup.dev', collection: 'Interface Systems', status: 'broken', detail: 'Source returned 404 on three checks.', checked: '8 min ago', suggestedAction: 'Archive link' },
  { id: 'health-2', title: 'Radix UI documentation', host: 'radix-ui.com', collection: 'Interface Systems', status: 'redirect', detail: 'Permanent redirect to radix-ui.com/primitives.', checked: '12 min ago', suggestedAction: 'Update URL' },
  { id: 'health-3', title: 'Design token pipeline notes', host: 'notion.so', collection: 'Interface Systems', status: 'stale', detail: 'Title and description changed since your snapshot.', checked: 'Today 09:18', suggestedAction: 'Refresh metadata' },
  { id: 'health-4', title: 'Inventing on Principle', host: 'youtube.com', collection: 'Interface Systems', status: 'healthy', detail: 'Source and metadata are current.', checked: 'Today 09:14', suggestedAction: 'No action' },
  { id: 'health-5', title: 'Spacing as a system', host: 'medium.com', collection: 'Interface Systems', status: 'duplicate', detail: 'Same canonical URL appears twice in this collection.', checked: 'Yesterday', suggestedAction: 'Merge notes' },
  { id: 'health-6', title: 'OpenTelemetry batch job SLOs', host: 'github.com', collection: 'ML Ops Field Notes', status: 'healthy', detail: 'Source and metadata are current.', checked: 'Yesterday', suggestedAction: 'No action' },
  { id: 'health-7', title: 'Database Internals course notes', host: 'course.example', collection: 'Database Internals Path', status: 'broken', detail: 'DNS lookup failed on two consecutive checks.', checked: 'Jul 13', suggestedAction: 'Find replacement' },
]
