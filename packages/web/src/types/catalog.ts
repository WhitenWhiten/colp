/** Catalog types used by product UI. Seed values stay in `legacy-demo/data`. */

export const BOOKMARK_TYPES = [
  'github',
  'youtube',
  'bilibili',
  'wikipedia',
  'zhihu',
  'douban',
  'article',
  'path',
  'arxiv',
  'spotify',
  'figma',
  'producthunt',
  'x',
  'medium',
  'stackoverflow',
  'npm',
  'huggingface',
  'notion',
  'reddit',
  'xiaohongshu',
  'wechat',
  'hackernews',
  'dribbble',
  'codepen',
  'vimeo',
  'substack',
  'nature',
  'semanticscholar',
  'scholar',
  'openreview',
  'paperswithcode',
  'distill',
  'lesswrong',
  'arena',
  'techcrunch',
  'theverge',
  'nytimes',
  'reuters',
  'kr36',
  'sspai',
  'infoq',
  'ted',
  'coursera',
  'bluesky',
  'lobsters',
  'devto',
  'smashing',
  'acm',
] as const

export const WIDGET_TYPES = [
  'collectionlist',
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
] as const

export type BookmarkType = (typeof BOOKMARK_TYPES)[number]
export type WidgetType = (typeof WIDGET_TYPES)[number]
export type SourceType = BookmarkType | WidgetType

const WIDGET_TYPE_SET: ReadonlySet<string> = new Set(WIDGET_TYPES)

export function isWidgetType(type: SourceType): type is WidgetType {
  return WIDGET_TYPE_SET.has(type)
}

export interface CardLayout {
  x: number
  y: number
  w: number
  h: number
  z: number
  /** Canvas pin: locked modules stay above unlocked ones. */
  locked?: boolean
}

export interface ResourceBase {
  id: string
  title: string
  url: string
  summary: string
  host: string
  layout: CardLayout
  locked?: boolean
  image?: string
}

export type BookmarkResource = ResourceBase & {
  type: BookmarkType
  meta?: Record<string, string | number>
}

export type WidgetResource = ResourceBase & {
  type: WidgetType
  meta?: Record<string, string | number>
}

export type Resource = BookmarkResource | WidgetResource

export function isWidgetResource(resource: Resource): resource is WidgetResource {
  return isWidgetType(resource.type)
}

export interface Collection {
  id: string
  slug: string
  title: string
  description: string
  curator: string
  curatorHandle: string
  tags: string[]
  links: number
  followers: number
  updated: string
  public: boolean
  resources: Resource[]
}

export interface Curator {
  handle: string
  name: string
  bio: string
  collections: number
  followers: number
  following: number
}

export type MyLink = {
  id: string
  title: string
  host: string
  folder: string
  added: string
  url?: string
  /** Optional seed note shown once until the user edits (demo only). */
  seedNote?: string
  seedTldr?: string
}
