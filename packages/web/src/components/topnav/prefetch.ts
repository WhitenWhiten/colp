/** Hover/focus warms the lazy route chunk so View Transitions don't wait on the network. */
const prefetchers: Record<string, () => void> = {
  '/today': () => { void import('../../pages/Today') },
  '/explore': () => { void import('../../pages/Explore') },
  '/library': () => { void import('../../pages/Library') },
  '/notifications': () => { void import('../../pages/Notifications') },
  '/approvals': () => { void import('../../pages/WriteApprovals') },
  '/extension': () => { void import('../../pages/Extension') },
  '/sync': () => { void import('../../pages/Sync') },
  '/classify': () => { void import('../../pages/Classify') },
  '/import': () => { void import('../../pages/Import') },
  '/library/health': () => { void import('../../pages/LibraryHealth') },
  '/ai/organize': () => { void import('../../pages/AiOrganize') },
  '/login': () => { void import('../../pages/Login') },
  '/register': () => { void import('../../pages/Register') },
  '/creator': () => { void import('../../pages/Creator') },
}

export function prefetchRoute(to: string) {
  prefetchers[to]?.()
}
