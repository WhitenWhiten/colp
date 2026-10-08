import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnotationText } from './AnnotationText'

describe('AnnotationText', () => {
  it('renders plain and unknown formats literally', () => {
    const html = renderToStaticMarkup(<AnnotationText value={'<b>x</b>\nnext'} format="plain" />)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;\nnext')
    expect(renderToStaticMarkup(<AnnotationText value="**x**" format="other" />)).toContain('**x**')
  })

  it('renders document headings safely and offsets away from h1', () => {
    const html = renderToStaticMarkup(<AnnotationText value={'# **Title**\n\nBody'} format="markdown" variant="document" />)
    expect(html).toContain('<h2><strong>Title</strong></h2>')
    expect(html).toContain('<p>Body</p>')
  })

  it('flattens snippet headings without heading elements', () => {
    const html = renderToStaticMarkup(<AnnotationText value={'## Title\n\nfirst\n\nsecond'} format="markdown" variant="snippet" />)
    expect(html).not.toMatch(/<h[1-6]/)
    expect(html).not.toContain('<p')
    expect(html).not.toContain('##')
    expect(html).toContain('<strong')
    expect(html).toContain('<br/>')
  })

  it('does not create DOM for raw HTML', () => {
    const html = renderToStaticMarkup(<AnnotationText value={'<img src=x onerror="alert(1)">'} format="markdown" />)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
