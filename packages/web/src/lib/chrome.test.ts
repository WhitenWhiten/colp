import { describe, expect, it } from 'vitest'
import { APP_NAV, canonicalSiteOrigin, isAppNavActive, isAuthPath, loginPath } from './chrome'

describe('chrome helpers', () => {
  it('omits Updates and Dashboard from signed-in primary nav', () => {
    expect(APP_NAV.map((item) => item.to)).toEqual(['/today', '/explore', '/library'])
    expect(APP_NAV.map((item) => item.label)).not.toContain('Updates')
    expect(APP_NAV.map((item) => item.label)).not.toContain('Dashboard')
  })

  it('treats auth routes as auth paths', () => {
    expect(isAuthPath('/login')).toBe(true)
    expect(isAuthPath('/consent')).toBe(true)
    expect(isAuthPath('/register')).toBe(true)
    expect(isAuthPath('/reset-password')).toBe(true)
    expect(isAuthPath('/verify-email')).toBe(true)
    expect(isAuthPath('/auth/recovery')).toBe(true)
    expect(isAuthPath('/explore')).toBe(false)
    expect(isAuthPath('/library')).toBe(false)
  })

  it('does not light a workbench channel on auth routes', () => {
    expect(isAppNavActive('/today', '/login')).toBe(false)
    expect(isAppNavActive('/today', '/register')).toBe(false)
    expect(isAppNavActive('/explore', '/login')).toBe(false)
    expect(isAppNavActive('/library', '/login')).toBe(false)
    expect(isAppNavActive('/dashboard', '/login')).toBe(false)
  })

  it('builds sign-in links that return to the current page', () => {
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/login')).toBe('/login')
    expect(loginPath('/c/browser-research', '?folder=f-1')).toBe('/login?returnTo=%2Fc%2Fbrowser-research%3Ffolder%3Df-1')
  })

  it('matches library nested routes and exact app channels', () => {
    expect(isAppNavActive('/library', '/library')).toBe(true)
    expect(isAppNavActive('/library', '/library/abc/edit')).toBe(true)
    expect(isAppNavActive('/explore', '/explore')).toBe(true)
    expect(isAppNavActive('/explore', '/feed')).toBe(false)
    expect(isAppNavActive('/today', '/today')).toBe(true)
  })

  it('rewrites loopback origins to the public site', () => {
    expect(canonicalSiteOrigin('http://localhost:8080')).toBe('https://know-n.com')
    expect(canonicalSiteOrigin('http://127.0.0.1:8080')).toBe('https://know-n.com')
    expect(canonicalSiteOrigin('https://know-n.com')).toBe('https://know-n.com')
  })
})
