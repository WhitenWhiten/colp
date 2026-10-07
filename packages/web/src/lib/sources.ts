import type { BookmarkType, SourceType } from '../types/catalog'

export const sourceLabel: Record<SourceType, string> = {
  github: 'GitHub',
  youtube: 'YouTube',
  bilibili: 'bilibili',
  wikipedia: 'Wikipedia',
  zhihu: '知乎',
  douban: '豆瓣',
  article: 'Article',
  path: 'Path',
  arxiv: 'arXiv',
  spotify: 'Spotify',
  figma: 'Figma',
  producthunt: 'Product Hunt',
  x: 'X',
  medium: 'Medium',
  stackoverflow: 'Stack Overflow',
  npm: 'npm',
  huggingface: 'Hugging Face',
  notion: 'Notion',
  reddit: 'Reddit',
  xiaohongshu: '小红书',
  wechat: '公众号',
  hackernews: 'Hacker News',
  dribbble: 'Dribbble',
  codepen: 'CodePen',
  vimeo: 'Vimeo',
  substack: 'Substack',
  nature: 'Nature',
  semanticscholar: 'Semantic Scholar',
  scholar: 'Google Scholar',
  openreview: 'OpenReview',
  paperswithcode: 'Papers with Code',
  distill: 'Distill',
  lesswrong: 'LessWrong',
  arena: 'Are.na',
  techcrunch: 'TechCrunch',
  theverge: 'The Verge',
  nytimes: 'The New York Times',
  reuters: 'Reuters',
  kr36: '36氪',
  sspai: '少数派',
  infoq: 'InfoQ',
  ted: 'TED',
  coursera: 'Coursera',
  bluesky: 'Bluesky',
  lobsters: 'Lobsters',
  devto: 'DEV',
  smashing: 'Smashing Magazine',
  acm: 'ACM DL',
  collectionlist: 'Collection list',
  search: 'Search',
  sticky: '随手记',
  todo: 'Todo',
  weather: 'Weather',
  pomodoro: 'Pomodoro',
  clock: 'Clock',
  quicklinks: 'Quick links',
  habits: 'Habits',
  reading: 'Reading queue',
  ssh: 'SSH',
  ghheatmap: 'Contributions',
  aichat: 'AI chat',
  wordbook: 'Word book',
}

/** Types that show a colored source-dot in the card chrome */
export const dottedSources = [
  'youtube',
  'bilibili',
  'vimeo',
  'zhihu',
  'douban',
  'spotify',
  'producthunt',
  'x',
  'reddit',
  'xiaohongshu',
  'hackernews',
  'dribbble',
  'techcrunch',
  'theverge',
  'kr36',
  'sspai',
  'lobsters',
  'bluesky',
  'devto',
] as const satisfies readonly BookmarkType[]

const dottedSourceSet: ReadonlySet<string> = new Set(dottedSources)

export function isDottedSource(type: SourceType): boolean {
  return dottedSourceSet.has(type)
}

export const videoSources = ['youtube', 'bilibili', 'vimeo', 'ted'] as const satisfies readonly BookmarkType[]

const videoSourceSet: ReadonlySet<string> = new Set(videoSources)

export function isVideoSource(type: SourceType): boolean {
  return videoSourceSet.has(type)
}
