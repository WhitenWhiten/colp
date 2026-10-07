import type { Dispatch, SetStateAction } from 'react'
import { CanvasBoard } from '../../components/CanvasBoard'
import { EmptyState } from '../../components/EmptyState'
import { SourceCard } from '../../components/SourceCard'
import type { Resource } from '../../api/mock-data'
import { defaultThemeForType, type ThemeMap } from '../../lib/deskThemes'
import { DashboardCollistContext, type DashboardCollistValue } from '../../lib/collistBinding'
import type { Density } from './useDashboardState'

type DashboardBoardProps = {
  modules: Resource[]
  stackLayout: boolean
  collist: DashboardCollistValue
  themeMap: ThemeMap
  setThemeMap: Dispatch<SetStateAction<ThemeMap>>
  canEdit: boolean
  chromeOpen: boolean
  removeModule: (id: string) => void
  density: Density
  onAddModule: () => void
  restoreAll: () => void
}

export function DashboardBoard({
  modules,
  stackLayout,
  collist,
  themeMap,
  setThemeMap,
  canEdit,
  chromeOpen,
  removeModule,
  density,
  onAddModule,
  restoreAll,
}: DashboardBoardProps) {
  if (modules.length === 0) {
    return (
      <div className="dashboard-empty">
        <EmptyState
          icon="collection"
          title="No modules on the board"
          description="Add modules from the catalog, or restore the default layout."
          action={
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={onAddModule}>
                Add module
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={restoreAll}>
                Restore all
              </button>
            </>
          }
        />
      </div>
    )
  }
  if (stackLayout) {
    return (
      <DashboardCollistContext.Provider value={collist}>
        <div className="dashboard-stack" role="list" aria-label="Start page modules">
          {modules.map((mod) => (
            <SourceCard
              key={mod.id}
              resource={mod}
              layout={mod.layout}
              editable={false}
              themeId={themeMap[mod.id] ?? defaultThemeForType(mod.type)}
            />
          ))}
        </div>
      </DashboardCollistContext.Provider>
    )
  }
  return (
    <DashboardCollistContext.Provider value={collist}>
      <CanvasBoard
        resources={modules}
        storageKey="known.dashboard.v12"
        layoutEditable={canEdit}
        showEditChrome={canEdit && chromeOpen}
        customCanvasSize
        backgroundCustomizable
        defaultCanvasSize={{ width: 1400, height: density === 'focus' ? 1100 : 1460 }}
        onRemoveResource={canEdit ? removeModule : undefined}
        themeMap={themeMap}
        onThemeMapChange={setThemeMap}
      />
    </DashboardCollistContext.Provider>
  )
}
