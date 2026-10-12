import type { IconName } from '../components/Icon'

/**
 * OAuth / MCP scope presentation metadata. The consent page, the agent
 * cards and the MCP write-approval card all render requested scopes; the
 * human name, one-line description, group, and icon live here so the
 * surfaces cannot drift apart.
 */
export type OAuthScopeGroup = 'read' | 'write' | 'approval' | 'session'

export type OAuthScopeMeta = {
  /** Short permission name — the bold headline of a consent row. */
  name: string
  /** Plain-language description shown under the name. */
  label: string
  icon: IconName
  group: OAuthScopeGroup
}

const OAUTH_SCOPE_META = Object.freeze({
  'mcp:read:public': {
    name: 'Read public collections',
    label: 'Read collections published on this server',
    icon: 'book',
    group: 'read',
  },
  'mcp:read:own': {
    name: 'Read your collections',
    label: 'Read collections you own',
    icon: 'folder',
    group: 'read',
  },
  'collections:read': {
    name: 'Read collection details',
    label: 'See the titles, descriptions, and settings of your collections',
    icon: 'collection',
    group: 'read',
  },
  'nodes:read': {
    name: 'Read bookmarks and folders',
    label: 'See the bookmarks and folders in your collections',
    icon: 'bookmark',
    group: 'read',
  },
  'annotations:read': {
    name: 'Read notes',
    label: 'See the notes on your bookmarks',
    icon: 'file',
    group: 'read',
  },
  'product:read': {
    name: 'Read your account over HTTP',
    label: 'Read your collections, bookmarks, notes, and relations',
    icon: 'file',
    group: 'read',
  },
  'collections:write': {
    name: 'Edit collection details',
    label: 'Create collections and change their titles and descriptions',
    icon: 'collection',
    group: 'write',
  },
  'nodes:write': {
    name: 'Create and edit items',
    label: 'Create and edit bookmarks and folders in collections you can write',
    icon: 'bookmark',
    group: 'write',
  },
  'annotations:write': {
    name: 'Write notes',
    label: 'Add and edit the notes on your bookmarks',
    icon: 'file',
    group: 'write',
  },
  'product:write': {
    name: 'Write your account over HTTP',
    label: 'Create and edit your collections, bookmarks, notes, and relations',
    icon: 'send',
    group: 'write',
  },
  'nodes:delete': {
    name: 'Delete bookmarks and folders',
    label: 'Delete bookmarks and folders with everything inside, after you approve it',
    icon: 'trash',
    group: 'approval',
  },
  'access:write': {
    name: 'Change collection visibility',
    label: 'Change who can see a collection (requires extra approval)',
    icon: 'lock-open',
    group: 'approval',
  },
  'changes:commit': {
    name: 'Apply approved changes',
    label: 'Apply high-risk changes after you approve them',
    icon: 'check',
    group: 'approval',
  },
  'changes:cancel': {
    name: 'Cancel pending plans',
    label: 'Cancel a pending change plan',
    icon: 'cross',
    group: 'approval',
  },
  'offline_access': {
    name: 'Stay signed in',
    label: 'Stay signed in until you revoke access',
    icon: 'refresh',
    group: 'session',
  },
} satisfies Record<string, OAuthScopeMeta>)

export function consentScopeMeta(scope: string): OAuthScopeMeta | null {
  return Object.hasOwn(OAUTH_SCOPE_META, scope)
    ? OAUTH_SCOPE_META[scope as keyof typeof OAUTH_SCOPE_META]
    : null
}

export function consentScopeLabel(scope: string): string | null {
  return consentScopeMeta(scope)?.label ?? null
}

/** One plain-language line per group; the raw scopes stay one click away. */
export const OAUTH_SCOPE_GROUPS: ReadonlyArray<{
  id: OAuthScopeGroup | 'other'
  name: string
  label: string
  icon: IconName
}> = [
  {
    id: 'read',
    name: 'Read your library',
    label: 'Collections, folders, bookmarks, and notes, plus anything published on this server.',
    icon: 'eye',
  },
  {
    id: 'write',
    name: 'Organize your library',
    label: 'Create, edit, and move collections, folders, bookmarks, and notes.',
    icon: 'move',
  },
  {
    id: 'approval',
    name: 'Act on plans you approve',
    label: 'Publish or change who can see a collection, and apply or cancel change plans after you approve them.',
    icon: 'lock',
  },
  {
    id: 'session',
    name: 'Stay connected',
    label: 'Keeps access until you revoke it on the Agents page.',
    icon: 'refresh',
  },
  {
    id: 'other',
    name: 'Other permissions',
    label: 'Permissions this server has no description for.',
    icon: 'info',
  },
]

export type GroupedScopes = Array<(typeof OAUTH_SCOPE_GROUPS)[number] & { scopes: string[] }>

/** Requested scopes by group, in group order, without empty groups. */
export function groupScopes(scopes: readonly string[]): GroupedScopes {
  return OAUTH_SCOPE_GROUPS
    .map((group) => ({
      ...group,
      scopes: scopes.filter((scope) => (consentScopeMeta(scope)?.group ?? 'other') === group.id),
    }))
    .filter((group) => group.scopes.length > 0)
}
