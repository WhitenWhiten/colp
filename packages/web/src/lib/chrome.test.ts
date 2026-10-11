import { describe, expect, it } from 'vitest'
import { APP_NAV, isAppNavActive, isAuthPath, loginPath } from './chrome'

describe('chrome helpers', () => {
  it('lists Library, Agents and Approvals as the signed-in primary nav', () => {
    expect(APP_NAV.map((item) => item.to)).toEqual(['/library', '/agents', '/approvals'])
    expect(APP_NAV.map((item) => item.label)).toEqual(['Library', 'Agents', 'Approvals'])
  })

  it('treats auth routes as auth paths', () => {
    expect(isAuthPath('/login')).toBe(true)
    expect(isAuthPath('/consent')).toBe(true)
    expect(isAuthPath('/register')).toBe(true)
    expect(isAuthPath('/auth/recovery')).toBe(true)
    expect(isAuthPath('/library')).toBe(false)
    expect(isAuthPath('/agents')).toBe(false)
  })

  it('does not light a primary channel on auth routes', () => {
    expect(isAppNavActive('/library', '/login')).toBe(false)
    expect(isAppNavActive('/library', '/register')).toBe(false)
    expect(isAppNavActive('/agents', '/login')).toBe(false)
  })

  it('builds sign-in links that return to the current page', () => {
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/login')).toBe('/login')
    expect(loginPath('/c/browser-research', '?folder=f-1')).toBe('/login?returnTo=%2Fc%2Fbrowser-research%3Ffolder%3Df-1')
  })

  it('matches library nested routes and exact app channels', () => {
    expect(isAppNavActive('/library', '/library')).toBe(true)
    expect(isAppNavActive('/library', '/library/abc/edit')).toBe(true)
    expect(isAppNavActive('/agents', '/agents')).toBe(true)
    expect(isAppNavActive('/agents', '/approvals')).toBe(false)
  })
})
