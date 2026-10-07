import { dashboardModules, type SourceType } from '../../api/mock-data'
import { moduleById } from './moduleState'

/** Map module-market catalog kind → dashboard seed resource(s). */
export function catalogKindToModuleIds(kind: string): string[] {
  switch (kind) {
    case 'collection':
      return dashboardModules.filter((m) => m.type === 'collectionlist').map((m) => m.id)
    case 'timer':
    case 'pomodoro':
      return dashboardModules.filter((m) => m.type === 'pomodoro').map((m) => m.id)
    case 'heatmap':
    case 'ghheatmap':
      return dashboardModules.filter((m) => m.type === 'ghheatmap').map((m) => m.id)
    case 'feed':
    case 'path':
    case 'inbox':
      return []
    default:
      return dashboardModules.filter((m) => m.type === kind).map((m) => m.id)
  }
}

export function kindToSourceType(kind: string): SourceType | null {
  const ids = catalogKindToModuleIds(kind)
  const mod = ids[0] ? moduleById(ids[0]) : undefined
  return mod?.type ?? null
}
