import { describe, expect, it } from 'vitest'
import { agentPublicMarkdownToHtml, renderAgentPublicInlineHtml } from './agentPublicMarkdown'

describe('renderAgentPublicInlineHtml', () => {
  it('turns https markdown links into anchors', () => {
    expect(renderAgentPublicInlineHtml('[x](https://example.com)')).toBe(
      '<a href="https://example.com/">x</a>',
    )
  })

  it('keeps same-origin paths and mailto as anchors', () => {
    expect(renderAgentPublicInlineHtml('[mcp](/mcp)')).toBe('<a href="/mcp">mcp</a>')
    expect(renderAgentPublicInlineHtml('[mail](mailto:help@know-n.com)')).toBe(
      '<a href="mailto:help@know-n.com">mail</a>',
    )
  })

  it('does not turn javascript: or protocol-relative hrefs into anchors', () => {
    const js = renderAgentPublicInlineHtml('[x](javascript:alert(1))')
    expect(js).not.toMatch(/<a\b/u)
    expect(js).toBe('[x](javascript:alert(1))')
    const protoRel = renderAgentPublicInlineHtml('[x](//evil.example/phish)')
    expect(protoRel).not.toMatch(/<a\b/u)
  })
})

describe('agentPublicMarkdownToHtml fenced code blocks', () => {
  it('renders a fenced block as escaped pre/code without markdown parsing inside', () => {
    const html = agentPublicMarkdownToHtml(
      ['before', '```', 'curl -H "Mcp-Name: <uri>" \\', '# not a heading', '- not a list', '```', 'after'].join('\n'),
    )
    expect(html).toContain(
      '<pre><code>curl -H "Mcp-Name: &lt;uri&gt;" \\\n# not a heading\n- not a list</code></pre>',
    )
    expect(html).toContain('<p>before</p>')
    expect(html).toContain('<p>after</p>')
    expect(html).not.toContain('<h1>')
    expect(html).not.toContain('<li>not a list</li>')
  })

  it('emits an unclosed fence at end of input as a code block', () => {
    const html = agentPublicMarkdownToHtml(['```', 'tail'].join('\n'))
    expect(html).toBe('<pre><code>tail</code></pre>')
  })
})
