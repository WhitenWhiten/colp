import { createProductBookmarkPreferencesClient, type BookmarkPreferencesPatch } from '@known/product-v1-client'
import { getApiBaseUrl } from './config'
import { getOrCreateCommandId } from './commandId'
import { wrapGeneratedFollowError, type MutationCall, type MutationOptions, type ReadOptions } from './product-client-shared'

export function createBookmarkPreferencesWebClient(mutationCall: MutationCall) {
  function client(csrfToken = '', signal?: AbortSignal) {
    return createProductBookmarkPreferencesClient({ origin: getApiBaseUrl() || globalThis.location.origin, csrfToken,
      fetch: (input, init) => globalThis.fetch(input, { ...init, signal }) })
  }
  return {
    async getBookmarkPreferences(options?: ReadOptions) {
      try { return await client('', options?.signal).read() }
      catch (error) { throw wrapGeneratedFollowError(error) }
    },
    updateBookmarkPreferences(patch: BookmarkPreferencesPatch, etag: string, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).patch(patch, getOrCreateCommandId(intentId), etag) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, maxRetries: 0, rotateCommandOnConflict: false })
    },
  }
}
