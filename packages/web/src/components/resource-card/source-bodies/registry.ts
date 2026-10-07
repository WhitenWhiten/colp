import type { BookmarkType } from '../../../types/catalog'
import { GenericBody } from './generic'
import { GithubBody } from './github'
import {
  DoubanBody,
  DribbbleBody,
  SpotifyBody,
} from './media'
import { NewsBody } from './news'
import {
  AcmBody,
  ArxivBody,
  DistillBody,
  NatureBody,
  OpenReviewBody,
  PapersWithCodeBody,
  ScholarBody,
} from './papers'
import {
  BlueskyBody,
  DevtoBody,
  HackerNewsBody,
  LessWrongBody,
  LobstersBody,
  MediumBody,
  RedditBody,
  SubstackBody,
  WechatBody,
  XBody,
  XiaohongshuBody,
} from './social'
import {
  ArenaBody,
  CodepenBody,
  CourseraBody,
  FigmaBody,
  HuggingFaceBody,
  NotionBody,
  NpmBody,
  PathBody,
  ProductHuntBody,
  StackOverflowBody,
} from './tools'
import type { SourceBodyRenderer } from './types'
import { VideoBody } from './video'
import { WikipediaBody } from './wikipedia'
import { ZhihuBody } from './zhihu'

const videoCluster = {
  youtube: VideoBody,
  bilibili: VideoBody,
  vimeo: VideoBody,
  ted: VideoBody,
} satisfies Partial<Record<BookmarkType, SourceBodyRenderer>>

const newsCluster = {
  techcrunch: NewsBody,
  theverge: NewsBody,
  nytimes: NewsBody,
  reuters: NewsBody,
  kr36: NewsBody,
  sspai: NewsBody,
  infoq: NewsBody,
  smashing: NewsBody,
} satisfies Partial<Record<BookmarkType, SourceBodyRenderer>>

const papersCluster = {
  arxiv: ArxivBody,
  nature: NatureBody,
  semanticscholar: ScholarBody,
  scholar: ScholarBody,
  openreview: OpenReviewBody,
  paperswithcode: PapersWithCodeBody,
  distill: DistillBody,
  acm: AcmBody,
} satisfies Partial<Record<BookmarkType, SourceBodyRenderer>>

const socialCluster = {
  x: XBody,
  reddit: RedditBody,
  hackernews: HackerNewsBody,
  bluesky: BlueskyBody,
  lobsters: LobstersBody,
  xiaohongshu: XiaohongshuBody,
  wechat: WechatBody,
  lesswrong: LessWrongBody,
  medium: MediumBody,
  substack: SubstackBody,
  devto: DevtoBody,
} satisfies Partial<Record<BookmarkType, SourceBodyRenderer>>

/**
 * Typed bookmark-body registry. Extra keys that are not `BookmarkType` fail
 * typecheck. Widget types cannot be registered or looked up (ResourceBody
 * sends those to WidgetBody). Unregistered bookmark types fall through to
 * GenericBody.
 */
export const sourceBodyRegistry: Partial<Record<BookmarkType, SourceBodyRenderer>> = {
  github: GithubBody,
  ...videoCluster,
  wikipedia: WikipediaBody,
  zhihu: ZhihuBody,
  douban: DoubanBody,
  path: PathBody,
  ...papersCluster,
  ...socialCluster,
  ...newsCluster,
  spotify: SpotifyBody,
  dribbble: DribbbleBody,
  figma: FigmaBody,
  producthunt: ProductHuntBody,
  stackoverflow: StackOverflowBody,
  npm: NpmBody,
  huggingface: HuggingFaceBody,
  notion: NotionBody,
  codepen: CodepenBody,
  arena: ArenaBody,
  coursera: CourseraBody,
}

export function resolveSourceBody(type: BookmarkType, isVideo = false): SourceBodyRenderer {
  return sourceBodyRegistry[type] ?? (isVideo ? VideoBody : GenericBody)
}
