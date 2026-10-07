export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong' | 'em' | 'del' | 'code'; children?: InlineNode[]; value?: string }

export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }

const pushText = (out: InlineNode[], value: string) => {
  if (!value) return
  const prior = out[out.length - 1]
  if (prior?.type === 'text') prior.value += value
  else out.push({ type: 'text', value })
}

// Keep malformed marker-heavy annotation values bounded; ordinary annotation
// emphasis is short, while this prevents repeated unterminated scans from
// becoming quadratic on hostile input.
const MAX_MARKER_SCAN = 4096
function closingIndex(input: string, marker: string, start: number): number {
  const limit = Math.min(input.length - marker.length, start + MAX_MARKER_SCAN)
  for (let index = start; index <= limit; index++) {
    if (input[index] === '\\') { index += 1; continue }
    if (!input.startsWith(marker, index)) continue
    if (marker !== '`' && (input[index - 1] === '\\' || /\s/.test(input[index - 1] ?? ''))) continue
    return index
  }
  return -1
}

/** Parse only the deliberately small, safe Markdown subset used by annotations. */
export function parseInline(input: string, allowDel = true): InlineNode[] {
  const out: InlineNode[] = []
  let text = ''
  const flush = () => { pushText(out, text); text = '' }
  for (let i = 0; i < input.length;) {
    // Backslash escapes the small set of syntax characters we recognize.
    if (input[i] === '\\' && i + 1 < input.length && '*~`'.includes(input[i + 1] ?? '')) {
      text += input[i + 1]
      i += 2
      continue
    }
    if (input[i] === '*') {
      let run = 1
      while (input[i + run] === '*') run++
      if (run >= 3) { text += '*'.repeat(run); i += run; continue }
    }
    const candidates: Array<[string, 'strong' | 'em' | 'code' | 'del']> = [['**', 'strong'], ['*', 'em'], ['`', 'code']]
    if (allowDel) candidates.unshift(['~~', 'del'])
    let matched = false
    for (const [marker, type] of candidates) {
      if (!input.startsWith(marker, i)) continue
      if (type !== 'code' && /\s/.test(input[i + marker.length] ?? '')) continue
      const end = closingIndex(input, marker, i + marker.length)
      const inner = end >= 0 ? input.slice(i + marker.length, end) : ''
      const invalidDoubleRun = marker === '**' && end >= 0 && (input[end - 1] === '*' || input[end + marker.length] === '*')
      if (end <= i + marker.length || invalidDoubleRun || (type !== 'code' && (inner.includes('\n') || !inner.trim()))) {
        // A failed double marker must not degrade into a single-star parse.
        if (marker === '**') { text += '**'; i += 2; matched = true; break }
        continue
      }
      // Do not interpret markers embedded in an ordinary word (a*b*c).
      // Avoid eating arithmetic/identifier-like ASCII (`a*b*c`), while
      // allowing natural CJK text adjacent to emphasis (`中文*重点*中文`).
      if (marker === '*' && /[A-Za-z0-9]/.test(input[i - 1] ?? '') && /[A-Za-z0-9]/.test(input[i + marker.length] ?? '')) continue
      flush()
      if (type === 'code') out.push({ type, value: inner })
      else out.push({ type, children: parseInline(inner, allowDel) })
      i = end + marker.length
      matched = true
      break
    }
    if (!matched) { text += input[i]; i++ }
  }
  flush()
  return out
}

export function parseMarkdown(input: string, allowDel = true): BlockNode[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const blocks: BlockNode[] = []
  let paragraph: string[] = []
  const flush = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n'), allowDel) }); paragraph = [] } }
  for (const line of lines) {
    const heading = /^(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line)
    if (heading) { flush(); blocks.push({ type: 'heading', level: (heading[1] ?? '').length, children: parseInline(heading[2] ?? '', allowDel) }) }
    else if (/^[ \t]*$/.test(line)) flush()
    else paragraph.push(line)
  }
  flush()
  return blocks
}
