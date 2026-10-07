import { TRANSFER_TIMEOUT_MS } from './requestTimeout'
import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type {
  CollectionVersion,
  CollectionVersionCreateRequest,
  CollectionVersionPage,
  CollectionVersionRestoreReceipt,
  CollectionVersionRestoreRequest,
  ExportJob,
  ExportJobPage,
  ExportLibraryDocument,
  OrganizePlan,
  OrganizePlanApplyReceipt,
  OrganizePlanApplyRequest,
  OrganizePlanCreateRequest,
} from './types'

export function createExportTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async listMyExportJobs(opts?: { signal?: AbortSignal }) {
      return request<ExportJobPage>({
        method: 'GET',
        path: '/api/v1/me/export-jobs',
        headers: { Accept: 'application/json' },
        signal: opts?.signal,
      })
    },

    async createMyExportJob(opts: MutationCallOptions) {
      return request<ExportJob>({
        method: 'POST',
        path: '/api/v1/me/export-jobs',
        headers: mutationHeaders(opts),
        signal: opts.signal,
      })
    },

    async getMyExportJob(jobId: string, opts?: { signal?: AbortSignal }) {
      return request<ExportJob>({
        method: 'GET',
        path: `/api/v1/me/export-jobs/${encodeURIComponent(jobId)}`,
        headers: { Accept: 'application/json' },
        signal: opts?.signal,
      })
    },

    async downloadMyExportJob(jobId: string, opts?: { signal?: AbortSignal }) {
      return request<ExportLibraryDocument>({
        method: 'GET',
        path: `/api/v1/me/export-jobs/${encodeURIComponent(jobId)}/download`,
        headers: { Accept: 'application/json' },
        signal: opts?.signal,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      })
    },

    async createCollectionOrganizePlan(
      collectionId: string,
      body: OrganizePlanCreateRequest,
      opts: MutationCallOptions,
    ) {
      return request<OrganizePlan>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/organize-plans`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async getCollectionOrganizePlan(
      collectionId: string,
      planId: string,
      opts?: { signal?: AbortSignal },
    ) {
      return request<OrganizePlan>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/organize-plans/${encodeURIComponent(planId)}`,
        headers: { Accept: 'application/json' },
        signal: opts?.signal,
      })
    },

    async applyCollectionOrganizePlan(
      collectionId: string,
      planId: string,
      body: OrganizePlanApplyRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<OrganizePlanApplyReceipt>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/organize-plans/${encodeURIComponent(planId)}/apply`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async createCollectionVersion(
      collectionId: string,
      body: CollectionVersionCreateRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<CollectionVersion>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async listCollectionVersions(
      collectionId: string,
      params?: { limit?: number; cursor?: string; signal?: AbortSignal },
    ) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else if (params?.limit != null) {
        query.limit = params.limit
      }
      return request<CollectionVersionPage>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions`,
        query,
        headers: { Accept: 'application/json' },
        signal: params?.signal,
      })
    },

    async getCollectionVersion(
      collectionId: string,
      versionId: string,
      opts?: { signal?: AbortSignal },
    ) {
      return request<CollectionVersion>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions/${encodeURIComponent(versionId)}`,
        headers: { Accept: 'application/json' },
        signal: opts?.signal,
      })
    },

    async restoreCollectionVersion(
      collectionId: string,
      versionId: string,
      body: CollectionVersionRestoreRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<CollectionVersionRestoreReceipt>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions/${encodeURIComponent(versionId)}/restore`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}
