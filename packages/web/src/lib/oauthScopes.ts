import type { IconName } from '../components/Icon'

/**
 * OAuth / MCP scope presentation metadata. The consent page and the MCP
 * write-approval card both render requested scopes; the human name,
 * one-line description, and icon live here so the two surfaces cannot
 * drift apart.
 */
export type OAuthScopeMeta = {
  /** Short permission name — the bold headline of a consent row. */
  name: string
  /** Plain-language description shown under the name. */
  label: string
  icon: IconName
}

const OAUTH_SCOPE_META = Object.freeze({
  'mcp:read:public': {
    name: 'Read public libraries',
    label: 'Read published public libraries',
    icon: 'book',
  },
  'mcp:read:own': {
    name: 'Read your libraries',
    label: 'Read libraries you own',
    icon: 'folder',
  },
  'nodes:write': {
    name: 'Create and edit items',
    label: 'Create and edit items in libraries you can write',
    icon: 'bookmark',
  },
  'offline_access': {
    name: 'Stay signed in',
    label: 'Stay signed in until you revoke access',
    icon: 'refresh',
  },
  'access:write': {
    name: 'Change library visibility',
    label: 'Change who can see a library (requires extra approval)',
    icon: 'lock-open',
  },
  'changes:commit': {
    name: 'Apply approved changes',
    label: 'Apply high-risk changes after you approve them',
    icon: 'check',
  },
  'changes:cancel': {
    name: 'Cancel pending plans',
    label: 'Cancel a pending change plan',
    icon: 'cross',
  },
  'product:read': {
    name: 'Read your account over HTTP',
    label: 'Read your libraries, bookmarks, community activity, notifications, and favicons',
    icon: 'file',
  },
  'product:write': {
    name: 'Write your account over HTTP',
    label: 'Create and edit your libraries, bookmarks, community posts and votes, and favicons',
    icon: 'send',
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
