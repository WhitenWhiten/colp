import { describe, expect, it } from 'vitest'
import { consentScopeMeta, groupScopes } from './oauthScopes'

describe('groupScopes', () => {
  it('folds requested scopes into ordered groups and drops empty ones', () => {
    const groups = groupScopes(['offline_access', 'nodes:write', 'mcp:read:own', 'nodes:read', 'changes:commit'])
    expect(groups.map((group) => [group.id, group.scopes])).toEqual([
      ['read', ['mcp:read:own', 'nodes:read']],
      ['write', ['nodes:write']],
      ['approval', ['changes:commit']],
      ['session', ['offline_access']],
    ])
  })

  it('keeps unknown scopes visible under Other permissions', () => {
    expect(groupScopes(['mcp:read:own', 'made:up']).map((group) => group.name))
      .toEqual(['Read your library', 'Other permissions'])
  })

  it('describes every scope the server advertises', () => {
    const advertised = ['mcp:read:public', 'mcp:read:own', 'collections:read', 'collections:write', 'nodes:read',
      'nodes:write', 'annotations:read', 'annotations:write', 'access:write', 'changes:commit', 'changes:cancel',
      'product:read', 'product:write', 'offline_access']
    expect(advertised.filter((scope) => consentScopeMeta(scope) === null)).toEqual([])
  })
})
