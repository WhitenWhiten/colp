import type { ReactNode } from 'react'
import type { BookmarkResource } from '../../../types/catalog'

export type SourceBodyProps = {
  resource: BookmarkResource
  isVideo?: boolean
}

export type SourceBodyRenderer = (props: SourceBodyProps) => ReactNode
