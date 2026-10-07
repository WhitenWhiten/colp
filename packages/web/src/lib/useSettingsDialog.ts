import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { isLive } from '../api'

export const SETTINGS_PARAM = 'settings'
export const SETTINGS_SECTIONS = ['profile', 'bookmarks', 'privacy', 'favicon', 'notifications', 'security'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'profile'
export const SECURITY_SETTINGS_URL = '/library?settings=security'
export const SECURITY_SETTINGS_ERROR_CALLBACK_URL =
  `/auth/recovery?returnTo=${encodeURIComponent(SECURITY_SETTINGS_URL)}`

/** Flag-gated sections are hidden (nav + deep-links) while their capability
    is off — the Favicon section would otherwise degrade to a dead
    "managed for you" entry. */
export function isSettingsSectionAvailable(id: SettingsSection): boolean {
  if (id === 'favicon') return isLive('faviconPolicy')
  return true
}

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** Missing param → closed. Illegal/unavailable value → profile. */
export function parseSettingsSection(value: string | null): SettingsSection | null {
  if (value === null) return null
  if (!isSettingsSection(value)) return DEFAULT_SETTINGS_SECTION
  return isSettingsSectionAvailable(value) ? value : DEFAULT_SETTINGS_SECTION
}

export function settingsRedirectTo(hash: string): string {
  const id = hash.startsWith('#') ? hash.slice(1) : hash
  const section = isSettingsSection(id) && isSettingsSectionAvailable(id)
    ? id
    : DEFAULT_SETTINGS_SECTION
  return `/library?${SETTINGS_PARAM}=${section}`
}

export function useSettingsDialog() {
  const [searchParams, setSearchParams] = useSearchParams()
  const section = parseSettingsSection(searchParams.get(SETTINGS_PARAM))
  const isOpen = section !== null
  /* Live flag state (window.__KNOWN_FLAGS__) can change between renders. */
  const sections = SETTINGS_SECTIONS.filter(isSettingsSectionAvailable)

  const assign = useCallback((next: SettingsSection | null) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next === null) params.delete(SETTINGS_PARAM)
      else params.set(SETTINGS_PARAM, next)
      return params
    }, { replace: true })
  }, [setSearchParams])

  const open = useCallback((next: SettingsSection = DEFAULT_SETTINGS_SECTION) => {
    assign(next)
  }, [assign])

  const close = useCallback(() => {
    assign(null)
  }, [assign])

  return {
    isOpen,
    section: section ?? DEFAULT_SETTINGS_SECTION,
    sections,
    open,
    close,
  }
}
