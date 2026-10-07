import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './parser'

describe('limited markdown parser', () => {
  it('keeps plain text and line breaks literal at block level', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'one\ntwo' }] }])
  })

  it('parses supported inline marks', () => {
    expect(parseInline('**b** *i* ~~d~~ `x *not mark*`')).toMatchObject([
      { type: 'strong' }, { type: 'text', value: ' ' }, { type: 'em' },
      { type: 'text', value: ' ' }, { type: 'del' }, { type: 'text', value: ' ' }, { type: 'code', value: 'x *not mark*' },
    ])
  })

  it('leaves unclosed markers as literal text', () => {
    expect(parseInline('start **unfinished')).toEqual([{ type: 'text', value: 'start **unfinished' }])
    expect(parseInline('\\*literal\\*')).toEqual([{ type: 'text', value: '*literal*' }])
    expect(parseInline('*foo \\* bar*')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'foo * bar' }] }])
    expect(parseInline('* x *')).toEqual([{ type: 'text', value: '* x *' }])
    expect(parseInline('a*b*c')).toEqual([{ type: 'text', value: 'a*b*c' }])
    expect(parseInline('*重点*')).toMatchObject([{ type: 'em' }])
    expect(parseInline('中文*重点*中文')).toMatchObject([{ type: 'text', value: '中文' }, { type: 'em' }, { type: 'text', value: '中文' }])
    expect(parseInline('**hello **')).toEqual([{ type: 'text', value: '**hello **' }])
    expect(parseInline('***x***')).toEqual([{ type: 'text', value: '***x***' }])
  })

  it('bounds scans for marker-heavy malformed input', () => {
    const value = '*'.repeat(12_000)
    const result = parseInline(value)
    expect(result.map((node) => node.type).every((type) => type === 'text' || type === 'em')).toBe(true)
  })

  it('recognizes only ATX headings and paragraphs', () => {
    expect(parseMarkdown('# Title\n\nbody')).toMatchObject([
      { type: 'heading', level: 1 }, { type: 'paragraph' },
    ])
  })
})
