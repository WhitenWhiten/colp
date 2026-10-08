export function installPageMetaBaseline(input: {
  description?: string
  canonical?: string
  ogUrl?: string
  ogTitle?: string
  ogImage?: string
} = {}): void {
  const description = input.description ?? 'Home description'
  const canonical = input.canonical ?? 'https://know-n.com/'
  const ogUrl = input.ogUrl ?? canonical
  const ogTitle = input.ogTitle ?? 'Home OG title'
  document.head.innerHTML = `
    <meta name="description">
    <link rel="canonical">
    <meta property="og:title">
    <meta property="og:description">
    <meta property="og:url">
    <meta property="og:image">
    <title>Know-N</title>
  `
  document.head.querySelector('meta[name="description"]')?.setAttribute('content', description)
  document.head.querySelector('link[rel="canonical"]')?.setAttribute('href', canonical)
  document.head.querySelector('meta[property="og:title"]')?.setAttribute('content', ogTitle)
  document.head.querySelector('meta[property="og:description"]')?.setAttribute('content', description)
  document.head.querySelector('meta[property="og:url"]')?.setAttribute('content', ogUrl)
  if (input.ogImage !== undefined) {
    document.head.querySelector('meta[property="og:image"]')?.setAttribute('content', input.ogImage)
  }
}

export function pageMetaContent(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute('content') ?? null
}

export function canonicalHref(): string | null {
  return document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
}

export function robotsContents(): string[] {
  return [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="robots"]')]
    .map((node) => node.content)
}
