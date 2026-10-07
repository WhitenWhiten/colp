import {
  WIDGET_TYPES,
  type SourceType,
  type WidgetResource,
  type WidgetType,
} from '../../types/catalog'
import { CollectionListEmbed } from '../CollectionListEmbed'
import { AiChatWidget } from '../widgets/AiChatWidget'
import { DeskClockWidget } from '../widgets/DeskClockWidget'
import { DeskSearch } from '../widgets/DeskSearch'
import { GithubHeatmapWidget } from '../widgets/GithubHeatmapWidget'
import { HabitTrackerWidget } from '../widgets/HabitTrackerWidget'
import { PomodoroWidget } from '../widgets/PomodoroWidget'
import { QuickLinksWidget } from '../widgets/QuickLinksWidget'
import { ReadingQueueWidget } from '../widgets/ReadingQueueWidget'
import { SshTerminalWidget } from '../widgets/SshTerminalWidget'
import { StickyNote } from '../widgets/StickyNote'
import { TodoWidget } from '../widgets/TodoWidget'
import { WeatherWidget } from '../widgets/WeatherWidget'
import { WordBookWidget } from '../widgets/WordBookWidget'

/** Canvas modules that fill the card body (not bookmark-style media cards). */
export const FILL_TYPES = WIDGET_TYPES satisfies readonly WidgetType[]
/** Tool widgets — not bookmarks; hide save/read mark actions. */
export const TOOL_TYPES = [
  'search',
  'sticky',
  'todo',
  'weather',
  'pomodoro',
  'clock',
  'quicklinks',
  'habits',
  'reading',
  'ssh',
  'ghheatmap',
  'aichat',
  'wordbook',
] as const satisfies readonly WidgetType[]

const TOOL_TYPE_SET: ReadonlySet<string> = new Set(TOOL_TYPES)

export function isToolType(type: SourceType): boolean {
  return TOOL_TYPE_SET.has(type)
}

type WidgetBodyProps = {
  resource: WidgetResource
  editable: boolean
}

/**
 * Widget body dispatcher (C03). Renders the canvas module for a fill
 * source type. The type branch decides body content only; a missing
 * WidgetType case fails typecheck (`never` default).
 */
export function WidgetBody({ resource, editable }: WidgetBodyProps) {
  switch (resource.type) {
    case 'collectionlist':
      return <CollectionListEmbed resource={resource} />
    case 'search':
      return <DeskSearch resourceId={resource.id} editable={editable} />
    case 'sticky':
      return <StickyNote resourceId={resource.id} />
    case 'todo':
      return <TodoWidget resourceId={resource.id} defaultTitle={resource.title || 'Today'} />
    case 'weather':
      return (
        <WeatherWidget
          resourceId={resource.id}
          defaultCity={String(resource.meta?.city ?? 'Beijing')}
          defaultLat={Number(resource.meta?.lat ?? 39.9042)}
          defaultLon={Number(resource.meta?.lon ?? 116.4074)}
        />
      )
    case 'pomodoro':
      return <PomodoroWidget resourceId={resource.id} />
    case 'clock':
      return <DeskClockWidget resourceId={resource.id} />
    case 'quicklinks':
      return <QuickLinksWidget resourceId={resource.id} />
    case 'habits':
      return <HabitTrackerWidget resourceId={resource.id} />
    case 'reading':
      return <ReadingQueueWidget resourceId={resource.id} />
    case 'ssh':
      return (
        <SshTerminalWidget
          resourceId={resource.id}
          defaultHost={String(resource.meta?.host ?? resource.host ?? 'lab.known.dev')}
          defaultUser={String(resource.meta?.user ?? 'alex')}
        />
      )
    case 'ghheatmap':
      return (
        <GithubHeatmapWidget
          resourceId={resource.id}
          handle={String(resource.meta?.handle ?? 'alexchen')}
        />
      )
    case 'aichat':
      return <AiChatWidget resourceId={resource.id} />
    case 'wordbook':
      return <WordBookWidget resourceId={resource.id} />
    default: {
      const _exhaustive: never = resource.type
      return _exhaustive
    }
  }
}
