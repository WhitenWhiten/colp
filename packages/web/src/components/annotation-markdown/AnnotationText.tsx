import { Fragment, type ReactNode } from 'react'
import { parseMarkdown } from './parser'
import { renderMarkdown, type MarkdownVariant, type RenderOptions } from './renderer'

export type AnnotationTextProps = {
  value: string | null | undefined
  format?: 'plain' | 'markdown' | string
  variant?: MarkdownVariant
  headingOffset?: number
  headingCap?: number
  allowDel?: boolean
  className?: string
}

export function AnnotationText({ value, format = 'plain', variant = 'document', headingOffset, headingCap, allowDel = true, className }: AnnotationTextProps): ReactNode {
  const content = String(value ?? '')
  if (format !== 'markdown') return <span className={className}>{content}</span>
  const options: RenderOptions = { variant, headingOffset, headingCap }
  const rendered = renderMarkdown(parseMarkdown(content, allowDel), options)
  // A fragment keeps the component safe to place inside an existing paragraph;
  // request a className when a block wrapper is desired.
  if (!className) return <Fragment>{rendered}</Fragment>
  return <div className={className} data-format="markdown" data-variant={variant}>{rendered}</div>
}

export const FormattedText = AnnotationText
