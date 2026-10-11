/** Hover/focus warms the lazy route chunk so View Transitions don't wait on the network. */
const prefetchers: Record<string, () => void> = {
  '/library': () => { void import('../../pages/Library') },
  '/approvals': () => { void import('../../pages/WriteApprovals') },
  '/extension': () => { void import('../../pages/Extension') },
  '/sync': () => { void import('../../pages/Sync') },
  '/import': () => { void import('../../pages/SelfHostedImport') },
  '/library/health': () => { void import('../../pages/LibraryHealth') },
  '/login': () => { void import('../../pages/SelfHostedLogin') },
  '/register': () => { void import('../../pages/SelfHostedRegister') },
  '/agents': () => { void import('../../pages/Agents') },
}

export function prefetchRoute(to: string) {
  prefetchers[to]?.()
}
