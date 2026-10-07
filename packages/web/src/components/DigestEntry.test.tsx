// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PublicCollectionResource } from '../lib/publicCollectionTree'
import { cleanup, mountTree } from '../test/render'
import { DigestEntry } from './DigestEntry'

const resource = {
  node: {
    id: 'bm-1',
    title: 'A paper',
    description: 'Why it matters',
    tldr: null,
    note: null,
  },
  href: 'https://arxiv.org/abs/1',
  host: 'arxiv.org',
} as PublicCollectionResource

describe('DigestEntry', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders a DomainMark beside the host on the entry row', () => {
    mountTree(
      <MemoryRouter>
        <DigestEntry resource={resource} slug="weekly" cdnAllowed />
      </MemoryRouter>,
    )
    const row = document.querySelector('[data-testid="digest-entry"]')
    expect(row?.querySelector('[data-testid="digest-entry-host"] [data-testid="domain-mark"]')).not.toBeNull()
    expect(row?.querySelector('[data-testid="digest-entry-host-name"]')?.textContent).toBe('arxiv.org')
    expect(row?.querySelector('span.digest-entry-index')).toBeNull()
  })

  it('hotlinks the favicon CDN only when the collection gate is open and the node has not opted out', () => {
    const src = () => document.querySelector('[data-testid="domain-mark"] img')?.getAttribute('src') ?? null
    mountTree(<MemoryRouter><DigestEntry resource={resource} slug="weekly" cdnAllowed /></MemoryRouter>)
    expect(src()).toContain('a.favicon.im/arxiv.org')
    cleanup()
    mountTree(<MemoryRouter><DigestEntry resource={resource} slug="weekly" cdnAllowed={false} /></MemoryRouter>)
    expect(src()).toBeNull()
    cleanup()
    const optedOut = { ...resource, node: { ...resource.node, faviconCdnAllowed: false } } as PublicCollectionResource
    mountTree(<MemoryRouter><DigestEntry resource={optedOut} slug="weekly" cdnAllowed /></MemoryRouter>)
    expect(src()).toBeNull()
  })
})
