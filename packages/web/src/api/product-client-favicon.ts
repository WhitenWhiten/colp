import { clearCommandId } from './commandId'
import { wrapProductError } from './errors'
import {
  withSameRequestRetry,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type {
  BookmarkFaviconSource,
  FaviconCreateIconJobRequest,
  FaviconIconJob,
  FaviconIconJobAccepted,
  FaviconIconPolicy,
  FaviconIconPolicyPatch,
  FaviconPolicyResult,
  SetBookmarkFaviconSourceRequest,
} from './types'

/**
 * FO-01/FO-02 favicon policy/source client. The GETs return the server ETag so
 * the mutations can send If-Match; exact retries reuse the same intent key and
 * command id (cheap command-id conflict is never auto-rotated for favicon
 * intents, mirroring the bookmark favicon upload/delete). refreshBookmarkFavicon
 * (FO-02) returns the durable jobId; the UI polls the effective source state
 * with that jobId tracked, and closing the view never cancels the job. Feature
 * flag off surfaces as the server's 404 resource_not_found.
 */
export function createProductFaviconClient(
  transport: ProductTransport,
  mutationCall: MutationCall,
) {
  const faviconMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function getMyFaviconPolicy(options?: ReadOptions): Promise<FaviconIconPolicy & { etag: string }> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getMyFaviconPolicy(options?.signal)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateMyFaviconPolicy(
    patch: FaviconIconPolicyPatch,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<FaviconPolicyResult> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.updateMyFaviconPolicy(patch, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          signal: options.signal,
        }),
      faviconMutationOptions(options),
    )
  }

  async function getBookmarkFaviconSource(
    collectionId: string,
    nodeId: string,
    options?: ReadOptions,
  ): Promise<BookmarkFaviconSource & { etag: string }> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getBookmarkFaviconSource(collectionId, nodeId, options?.signal)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function setBookmarkFaviconSource(
    collectionId: string,
    nodeId: string,
    body: SetBookmarkFaviconSourceRequest,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<BookmarkFaviconSource> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.setBookmarkFaviconSource(collectionId, nodeId, body, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          signal: options.signal,
        }),
      faviconMutationOptions(options),
    )
  }

  async function refreshBookmarkFavicon(
    collectionId: string,
    nodeId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<FaviconIconJobAccepted> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.refreshBookmarkFavicon(collectionId, nodeId, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          signal: options.signal,
        }),
      faviconMutationOptions(options),
    )
  }

  async function createMyFaviconJob(
    body: FaviconCreateIconJobRequest,
    options: MutationOptions,
  ): Promise<FaviconIconJobAccepted> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.createMyFaviconJob(body, {
          commandIntentId,
          csrfToken: csrf,
          signal: options.signal,
        }),
      faviconMutationOptions(options),
    )
  }

  async function getMyFaviconJob(jobId: string, options?: ReadOptions): Promise<FaviconIconJob> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getMyFaviconJob(jobId, options?.signal)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function retryMyFaviconJob(
    jobId: string,
    options: MutationOptions,
  ): Promise<FaviconIconJobAccepted> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.retryMyFaviconJob(jobId, {
          commandIntentId,
          csrfToken: csrf,
          signal: options.signal,
        }),
      faviconMutationOptions(options),
    )
  }

  function abandonFaviconIntent(intentId: string): void { clearCommandId(intentId) }

  return {
    getMyFaviconPolicy,
    updateMyFaviconPolicy,
    getBookmarkFaviconSource,
    setBookmarkFaviconSource,
    refreshBookmarkFavicon,
    createMyFaviconJob,
    getMyFaviconJob,
    retryMyFaviconJob,
    abandonFaviconIntent,
  }
}

export type ProductFaviconClient = ReturnType<typeof createProductFaviconClient>