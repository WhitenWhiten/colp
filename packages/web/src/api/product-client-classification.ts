import { createProductClassificationProfilesClient, createProductClassificationClient, type ClassificationSettingsPatch, type ClassificationPreviewRequest, type ClassificationConfirmationRequest, type ClassificationRunCreateRequest, type ClassificationRunApplyRequest } from '@known/product-v1-client'
import { getApiBaseUrl } from './config'
import { clearCommandId, getOrCreateCommandId } from './commandId'
import { wrapGeneratedFollowError, type MutationCall, type MutationOptions, type ReadOptions } from './product-client-shared'

export function createClassificationWebClient(mutationCall: MutationCall) {
  function client(csrfToken: string, signal?: AbortSignal) {
    return createProductClassificationClient({
      origin: getApiBaseUrl() || globalThis.location?.origin || 'http://localhost', csrfToken,
      fetch: (input, init) => globalThis.fetch(input, { ...init, ...(signal ? { signal } : {}) }),
    })
  }
  const profiles=(csrfToken:string,signal?:AbortSignal)=>createProductClassificationProfilesClient({origin:getApiBaseUrl()||globalThis.location?.origin||'http://localhost',csrfToken,
    fetch:(input,init)=>globalThis.fetch(input,{...init,...(signal?{signal}:{})})})
  return {
    async listClassificationProfiles(options?:ReadOptions) {
      try { return await profiles('',options?.signal).list() } catch(error) { throw wrapGeneratedFollowError(error) }
    },
    forgetClassificationRunIntent: clearCommandId,
    async getClassificationRun(collectionId: string, runId: string, options?: ReadOptions) {
      try { return await client('', options?.signal).getRun(collectionId, runId) }
      catch (error) { throw wrapGeneratedFollowError(error) }
    },
    createClassificationRun(collectionId: string, document: ClassificationRunCreateRequest, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).createRun(collectionId, document, getOrCreateCommandId(intentId)) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, clearIntentOnSuccess: false, maxRetries: 0, rotateCommandOnConflict: false })
    },
    cancelClassificationRun(collectionId: string, runId: string, etag: string, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).cancelRun(collectionId, runId, getOrCreateCommandId(intentId), etag) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, clearIntentOnSuccess: false, maxRetries: 0, rotateCommandOnConflict: false })
    },
    applyClassificationRun(collectionId: string, runId: string, document: ClassificationRunApplyRequest, etag: string, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).applyRun(collectionId, runId, document, getOrCreateCommandId(intentId), etag) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, clearIntentOnSuccess: false, maxRetries: 0, rotateCommandOnConflict: false })
    },
    // The Web surface is server_managed-only (T-04): it never reads or writes a
    // provider profile, so it uses the `application/json` settings projection.
    // The v2 media type is the BYOK-capable one and is deliberately 404 while
    // KNOWN_FEATURE_CLASSIFICATION_BYOK=false (the shipped default), so asking
    // for it here would hide the panel and block every hosted classification.
    async getClassificationSettings(collectionId: string, options?: ReadOptions) {
      try { return await client('', options?.signal).settings(collectionId) }
      catch (error) { throw wrapGeneratedFollowError(error) }
    },
    updateClassificationSettings(collectionId: string, patch: ClassificationSettingsPatch, etag: string, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).updateSettings(collectionId, patch, getOrCreateCommandId(intentId), etag) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, maxRetries: 0, rotateCommandOnConflict: false })
    },
    confirmBookmarkClassification(collectionId: string, nodeId: string, document: ClassificationConfirmationRequest, etag: string, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).confirm(collectionId, nodeId, document, getOrCreateCommandId(intentId), etag) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, maxRetries: 0, rotateCommandOnConflict: false })
    },
    previewBookmarkClassification(collectionId: string, document: ClassificationPreviewRequest, options: MutationOptions) {
      return mutationCall(async (csrf, intentId) => {
        try { return await client(csrf, options.signal).preview(collectionId, document, getOrCreateCommandId(intentId)) }
        catch (error) { throw wrapGeneratedFollowError(error) }
      }, { ...options, maxRetries: 0, rotateCommandOnConflict: false })
    },
  }
}
