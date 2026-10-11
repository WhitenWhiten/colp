import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export const SETTINGS_PARAM = 'settings'
export const SETTINGS_SECTIONS = ['profile', 'bookmarks', 'security'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'profile'
export const SECURITY_SETTINGS_URL = '/library?settings=security'

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** Missing param → closed. Illegal/unavailable value → profile. */
export function parseSettingsSection(value: string | null): SettingsSection | null {
  if (value === null) return null
  return isSettingsSection(value) ? value : DEFAULT_SETTINGS_SECTION
}

export function settingsRedirectTo(hash: string): string {
  const id = hash.startsWith('#') ? hash.slice(1) : hash
  const section = isSettingsSection(id) ? id : DEFAULT_SETTINGS_SECTION
  return `/library?${SETTINGS_PARAM}=${section}`
}

export function useSettingsDialog() {
  const [searchParams, setSearchParams] = useSearchParams()
  const section = parseSettingsSection(searchParams.get(SETTINGS_PARAM))
  const isOpen = section !== null
  const sections = SETTINGS_SECTIONS

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
