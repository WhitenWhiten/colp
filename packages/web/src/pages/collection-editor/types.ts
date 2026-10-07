import type {
  EditableNodeView,
  EditorSnapshot,
  ProductApiError,
  RootNodeView,
} from '../../api'

export type TreeNode = EditableNodeView | RootNodeView

export type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: ProductApiError | Error; hint: string }
  | { status: 'ready'; snap: EditorSnapshot }

export type CursorRecoveryReason = 'snapshot_expired' | 'invalid_cursor'

export type EditorBanner = {
  readonly message: string
  readonly action: 'refresh' | 'review_drafts'
}

