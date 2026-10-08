/**
 * Internal Product HTTP transport.
 *
 * The application-level client lives in productClient.ts. This module has no
 * shared instance or session policy; it only maps generated contract types to
 * HTTP requests for the canonical client.
 *
 * - authenticated reads and mutations include cookies; anonymous reads omit them
 * - Mutating methods: X-CSRF-Token + Known-Command-Id (from allocateCommandId)
 * - If-Match / If-Content-Match where required
 * - Content-Type application/json or merge-patch+json
 * - Parses Product error envelope via parseProductError
 *
 * API origin:
 *   createProductTransport({ baseUrl }) or VITE_API_ORIGIN, else relative `/`.
 *
 * Does NOT auto-retry command_in_progress — caller reuses the same intent key.
 */

export type {
  AnnotationSubjectParams,
  ClassifyInboxListParams,
  DeleteNodeOptions,
  EditorPageParams,
  Etagged,
  LinkHealthListParams,
  MutationCallOptions,
  OwnedCollectionPageParams,
  ProductTransport,
  ProductTransportOptions,
  PublicCollectionPageParams,
  PublicProfilePageParams,
  ReadingProgressListParams,
  RelationListParams,
  SavedResourceListParams,
  SearchParams,
  SessionCallOptions,
  SyncConflictListParams,
  SyncTrashListParams,
  WriteApprovalListParams,
  CreditLedgerListParams,
} from './product-transport-types'

import { createProductTransportHttp } from './product-transport-http'
import { createAnnotationsTransport } from './product-transport-annotations'
import { createClassifyTransport } from './product-transport-classify'
import { createEditorTransport } from './product-transport-editor'
import { createExportTransport } from './product-transport-export'
import { createFaviconTransport } from './product-transport-favicon'
import { createLibraryTransport } from './product-transport-library'
import { createRelationsTransport } from './product-transport-relations'
import { createReplicaTransport } from './product-transport-replica'
import { createLinkPreviewTransport } from './product-transport-link-preview'
import { createSearchPublicTransport } from './product-transport-search'
import { createSessionTransport } from './product-transport-session'
import { createSyncTransport } from './product-transport-sync'
import { createWriteApprovalTransport } from './product-transport-approvals'
import { createCreditsTransport } from './product-transport-credits'
import type { ProductTransport, ProductTransportOptions } from './product-transport-types'

export function createProductTransport(
  options: ProductTransportOptions = {},
): ProductTransport {
  const http = createProductTransportHttp(options)
  return {
    ...createSessionTransport(http),
    ...createEditorTransport(http),
    ...createSearchPublicTransport(http),
    ...createLibraryTransport(http),
    ...createSyncTransport(http),
    ...createClassifyTransport(http),
    ...createExportTransport(http),
    ...createFaviconTransport(http),
    ...createReplicaTransport(http),
    ...createLinkPreviewTransport(http),
    ...createAnnotationsTransport(http),
    ...createRelationsTransport(http),
    ...createWriteApprovalTransport(http),
    ...createCreditsTransport(http),
  }
}
