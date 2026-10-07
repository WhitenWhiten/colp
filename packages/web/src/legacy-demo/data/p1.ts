export type CollaboratorRole = 'Owner' | 'Editor' | 'Commenter' | 'Viewer'

export type Collaborator = {
  id: string
  name: string
  email: string
  initials: string
  role: CollaboratorRole
  status: 'active' | 'pending'
  lastActive: string
}

export const collaboratorsSeed: Collaborator[] = [
  { id: 'co-1', name: 'Alex Chen', email: 'alex@known.dev', initials: 'AC', role: 'Owner', status: 'active', lastActive: 'Now' },
  { id: 'co-2', name: 'Mira Okada', email: 'mira@known.dev', initials: 'MO', role: 'Editor', status: 'active', lastActive: '18 min ago' },
  { id: 'co-3', name: 'Kai Rivers', email: 'kai@known.dev', initials: 'KR', role: 'Commenter', status: 'active', lastActive: 'Yesterday' },
  { id: 'co-4', name: 'Lin Wei', email: 'lin@example.com', initials: 'LW', role: 'Viewer', status: 'pending', lastActive: 'Invite sent Jul 14' },
]

export const collaboratorActivity = [
  { id: 'ca-1', actor: 'Mira Okada', action: 'moved “Spacing as a system” to step 5', time: '18 min ago' },
  { id: 'ca-2', actor: 'Alex Chen', action: 'published Version 18', time: '2h ago' },
  { id: 'ca-3', actor: 'Kai Rivers', action: 'commented on the Systems stage', time: 'Yesterday' },
  { id: 'ca-4', actor: 'Alex Chen', action: 'invited Lin Wei as Viewer', time: 'Yesterday' },
]

export type ExportJob = {
  id: string
  format: 'Markdown' | 'JSON' | 'HTML'
  scope: string
  created: string
  size: string
  status: 'ready' | 'expired'
}

export const exportHistorySeed: ExportJob[] = [
  { id: 'export-1', format: 'Markdown', scope: 'Interface Systems', created: 'Jul 12, 2026', size: '1.8 MB', status: 'ready' },
  { id: 'export-2', format: 'JSON', scope: 'Entire library', created: 'Jun 28, 2026', size: '12.4 MB', status: 'expired' },
  { id: 'export-3', format: 'HTML', scope: 'Public collections', created: 'Jun 14, 2026', size: '4.2 MB', status: 'ready' },
]
