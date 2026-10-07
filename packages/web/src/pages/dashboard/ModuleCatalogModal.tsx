import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { Modal } from '../../components/Modal'
import { dashboardModules, deskModuleCatalog } from '../../api/mock-data'
import {
  defaultThemeForType,
  isDeskThemeId,
  themesForType,
  type DeskThemeId,
} from '../../lib/deskThemes'
import { catalogKindToModuleIds, kindToSourceType } from './catalog'

type ModuleCatalogModalProps = {
  open: boolean
  onClose: () => void
  moduleIds: string[]
  moduleCount: number
  addThemeByKind: Record<string, DeskThemeId>
  setAddThemeByKind: Dispatch<SetStateAction<Record<string, DeskThemeId>>>
  addFromCatalog: (kind: string, title: string, themeOverride?: DeskThemeId) => void
  restoreAll: () => void
}

export function ModuleCatalogModal({
  open,
  onClose,
  moduleIds,
  moduleCount,
  addThemeByKind,
  setAddThemeByKind,
  addFromCatalog,
  restoreAll,
}: ModuleCatalogModalProps) {
  const catalogItems = useMemo(() => {
    const rank = (kind: string) => {
      const ids = catalogKindToModuleIds(kind)
      if (ids.length === 0) return 2
      if (ids.every((id) => moduleIds.includes(id))) return 1
      return 0
    }
    return [...deskModuleCatalog].sort((a, b) => rank(a.kind) - rank(b.kind))
  }, [moduleIds])
  const canAddModule = catalogItems.some((item) => {
    const ids = catalogKindToModuleIds(item.kind)
    return ids.some((id) => !moduleIds.includes(id))
  })

  return (
      <Modal
        open={open}
        onClose={onClose}
        label="Add board module"
        title="Add to your board"
      >
        <div className="module-market-head">
          <p className="section-label">Board modules</p>
          <p className="meta">
            {canAddModule
              ? 'Pick a color, then Add. On the board: right-click a card to recolor.'
              : 'These modules are on the board. Pick a color, then Recolor.'}
          </p>
        </div>
            <div className="module-catalog">
              {catalogItems.map((m) => {
                const ids = catalogKindToModuleIds(m.kind)
                const presentCount = ids.filter((id) => moduleIds.includes(id)).length
                const allOnBoard = ids.length > 0 && presentCount === ids.length
                const someOnBoard = presentCount > 0
                const unavailable = ids.length === 0
                const type = kindToSourceType(m.kind)
                const palettes = type ? themesForType(type) : []
                const selectedTheme =
                  addThemeByKind[m.kind] ?? (type ? defaultThemeForType(type) : 'paper')

                return (
                  <div key={m.id} className="module-catalog-row">
                    <div>
                      <strong>{m.title}</strong>
                      <p className="meta module-catalog-desc">
                        {m.body}
                      </p>
                      {palettes.length > 0 && (
                        <div className="module-theme-row" role="group" aria-label={`${m.title} colors`}>
                          {palettes.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              className={`module-theme-dot ${selectedTheme === t.id ? 'is-active' : ''}`}
                              title={t.label}
                              aria-label={t.label}
                              aria-pressed={selectedTheme === t.id}
                              onClick={() =>
                                setAddThemeByKind((prev) => ({ ...prev, [m.kind]: t.id }))
                              }
                            >
                              <span aria-hidden>
                                {t.swatches.map((c, i) => (
                                  <i key={i} style={{ background: c }} />
                                ))}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`btn btn-sm ${allOnBoard || unavailable ? 'btn-secondary' : 'btn-primary'}`}
                      disabled={unavailable}
                      onClick={() =>
                        addFromCatalog(
                          m.kind,
                          m.title,
                          isDeskThemeId(selectedTheme) ? selectedTheme : undefined,
                        )
                      }
                    >
                      {unavailable
                        ? 'Soon'
                        : allOnBoard
                          ? 'Recolor'
                          : someOnBoard
                            ? 'Add more'
                            : 'Add'}
                    </button>
                  </div>
                )
              })}
            </div>
            {moduleCount < dashboardModules.length && (
              <button
                type="button"
                className="btn btn-secondary btn-sm module-market-restore"
                onClick={() => {
                  restoreAll()
                  onClose()
                }}
              >
                Restore all modules
              </button>
            )}
      </Modal>
  )
}
