const KIND_DOMAINS: Array<{ kind: string; domains: readonly string[] }> = [
  { kind: 'Repo', domains: ['github.com', 'gitlab.com'] },
  {
    kind: 'Paper',
    domains: [
      'arxiv.org',
      'nature.com',
      'openreview.net',
      'semanticscholar.org',
      'paperswithcode.com',
      'scholar.google.com',
      'dl.acm.org',
      'distill.pub',
    ],
  },
  { kind: 'Course', domains: ['coursera.org', 'edx.org'] },
  { kind: 'Video', domains: ['youtube.com', 'youtu.be', 'bilibili.com', 'vimeo.com', 'ted.com'] },
  { kind: '知乎', domains: ['zhihu.com'] },
  { kind: 'Reddit', domains: ['reddit.com'] },
  { kind: 'Post', domains: ['x.com', 'twitter.com'] },
  { kind: 'Package', domains: ['npmjs.com'] },
  { kind: 'Model', domains: ['huggingface.co'] },
  { kind: 'File', domains: ['figma.com'] },
  { kind: 'Wiki', domains: ['wikipedia.org'] },
  { kind: 'Article', domains: ['medium.com', 'substack.com'] },
]

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** Short kind for a public collection bookmark, inferred from host. Unknown hosts are Link, not Article. */
export function resourceKindLabel(host: string): string {
  const normalized = host.replace(/^www\./, '').toLowerCase()
  if (!normalized || normalized === '-') return 'Link'
  for (const group of KIND_DOMAINS) {
    if (group.domains.some((domain) => hostMatches(normalized, domain))) return group.kind
  }
  return 'Link'
}
