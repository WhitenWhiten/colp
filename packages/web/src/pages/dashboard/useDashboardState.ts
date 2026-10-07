import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../components/AppToast'
import { dashboardModules } from '../../api/mock-data'
import {
  defaultThemeForType,
  isDeskThemeId,
  loadThemeMap,
  persistThemeMap,
  tileSkinLabel,
  type DeskThemeId,
  type ThemeMap,
} from '../../lib/deskThemes'
import {
  getIsBrowserFullscreen,
  subscribeBrowserFullscreen,
  DESKTOP_DASHBOARD_MIN,
} from '../../lib/fullscreen'
import { catalogKindToModuleIds, kindToSourceType } from './catalog'
import { loadModuleIds, moduleById, persistModuleIds } from './moduleState'

/** Layout storage key (v12: content-box coords, chrome outside layout rect). */
const THEME_STORAGE = 'known.dashboard.v12'

const DENSITY_KEY = 'known.dashboard.density.v1'
/** Applied on <html> so Layout chrome can hide without prop drilling. */
const FS_HTML_CLASS = 'dashboard-is-fullscreen'

export type Density = 'desk' | 'focus'

function loadDensity(): Density {
  try {
    const raw = localStorage.getItem(DENSITY_KEY)
    if (raw === 'desk' || raw === 'focus') return raw
  } catch {
    /* ignore */
  }
  return 'desk'
}

export function useDashboardState() {
  const [now, setNow] = useState(() => new Date())
  const [density, setDensity] = useState<Density>(() => loadDensity())
  const [moduleIds, setModuleIds] = useState<string[]>(() => loadModuleIds())
  const [themeMap, setThemeMap] = useState<ThemeMap>(() => loadThemeMap(THEME_STORAGE))
  /** Preferred theme when adding from catalog (keyed by catalog kind). */
  const [addThemeByKind, setAddThemeByKind] = useState<Record<string, DeskThemeId>>({})
  const { toast, success } = useToast()
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== 'undefined' ? getIsBrowserFullscreen() : false,
  )
  const [stackLayout, setStackLayout] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < DESKTOP_DASHBOARD_MIN,
  )

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(DENSITY_KEY, density)
    } catch {
      /* ignore */
    }
  }, [density])

  useEffect(() => {
    persistModuleIds(moduleIds)
  }, [moduleIds])

  useEffect(() => {
    persistThemeMap(THEME_STORAGE, themeMap)
  }, [themeMap])

  useEffect(() => {
    const sync = () => setIsFullscreen(getIsBrowserFullscreen())
    sync()
    return subscribeBrowserFullscreen(sync)
  }, [])

  useEffect(() => {
    const onResize = () => setStackLayout(window.innerWidth < DESKTOP_DASHBOARD_MIN)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const apply = isFullscreen && window.innerWidth >= DESKTOP_DASHBOARD_MIN
    root.classList.toggle(FS_HTML_CLASS, apply)
    return () => {
      root.classList.remove(FS_HTML_CLASS)
    }
  }, [isFullscreen])

  const removeModule = useCallback(
    (id: string) => {
      const mod = moduleById(id)
      setModuleIds((prev) => prev.filter((x) => x !== id))
      toast(mod ? `Removed “${mod.title || mod.type}”` : 'Module removed')
    },
    [toast],
  )

  const addFromCatalog = useCallback(
    (kind: string, title: string, themeOverride?: DeskThemeId) => {
      const ids = catalogKindToModuleIds(kind)
      if (!ids.length) {
        toast(`${title} is not available as a board module yet`)
        return
      }
      const type = kindToSourceType(kind)
      const theme =
        themeOverride ??
        addThemeByKind[kind] ??
        (type ? defaultThemeForType(type) : 'paper')
      const label = tileSkinLabel(theme)

      setModuleIds((prev) => {
        const next = [...prev]
        let added = 0
        const addedIds: string[] = []
        for (const id of ids) {
          if (!next.includes(id)) {
            next.push(id)
            addedIds.push(id)
            added++
          }
        }
        // Wash/terminal are render-time defaults — ThemeMap only stores picker ids.
        if (isDeskThemeId(theme)) {
          const targets = added === 0 ? ids : addedIds
          setThemeMap((tm) => {
            const patch = { ...tm }
            for (const id of targets) patch[id] = theme
            return patch
          })
        }
        if (added === 0) {
          success(`Color updated · ${label}`)
          return prev
        }
        toast(
          added === 1
            ? `Added “${title}” · ${label}`
            : `Added ${added} modules · ${label}`,
        )
        return next
      })
    },
    [addThemeByKind, success, toast],
  )

  const restoreAll = useCallback(() => {
    setModuleIds(dashboardModules.map((m) => m.id))
    toast('Restored all modules')
  }, [toast])

  return {
    now,
    density,
    setDensity,
    moduleIds,
    themeMap,
    setThemeMap,
    addThemeByKind,
    setAddThemeByKind,
    isFullscreen,
    stackLayout,
    removeModule,
    addFromCatalog,
    restoreAll,
  }
}
