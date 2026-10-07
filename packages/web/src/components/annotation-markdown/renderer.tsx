import { Fragment, type ReactNode } from 'react'
import type { BlockNode, InlineNode } from './parser'

export type MarkdownVariant = 'snippet' | 'document'
export type RenderOptions = { variant?: MarkdownVariant; headingOffset?: number; headingCap?: number }

function inline(nodes: InlineNode[], keyPrefix = 'i'): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    if (node.type === 'text') return <Fragment key={key}>{node.value}</Fragment>
    if (node.type === 'code') return <code key={key}>{node.value}</code>
    const Tag = node.type === 'strong' ? 'strong' : node.type === 'em' ? 'em' : 'del'
    return <Tag key={key}>{inline(node.children ?? [], key)}</Tag>
  })
}

export function renderMarkdown(blocks: BlockNode[], options: RenderOptions = {}): ReactNode {
  const variant = options.variant ?? 'document'
  const offset = Math.max(0, Math.min(5, Math.trunc(options.headingOffset ?? 1)))
  const cap = Math.max(2, Math.min(6, Math.trunc(options.headingCap ?? 6)))
  return blocks.map((block, index) => {
    if (variant === 'snippet') {
      const separator = index > 0 ? <br key={`br-${index}`} /> : null
      const content = block.type === 'heading'
        ? <strong>{inline(block.children, `s-${index}`)}</strong>
        : <span>{inline(block.children, `s-${index}`)}</span>
      return <Fragment key={`s-${index}`}>{separator}{content}</Fragment>
    }
    if (block.type === 'paragraph') return <p key={`p-${index}`}>{inline(block.children, `p-${index}`)}</p>
    const level = Math.min(cap, Math.max(2, block.level + offset))
    const children = inline(block.children, `h-${index}`)
    switch (level) {
      case 2: return <h2 key={`h-${index}`}>{children}</h2>
      case 3: return <h3 key={`h-${index}`}>{children}</h3>
      case 4: return <h4 key={`h-${index}`}>{children}</h4>
      case 5: return <h5 key={`h-${index}`}>{children}</h5>
      default: return <h6 key={`h-${index}`}>{children}</h6>
    }
  })
}
