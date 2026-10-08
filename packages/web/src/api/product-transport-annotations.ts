import type { ProductTransportHttp } from './product-transport-http'
import type { AnnotationSubjectParams, MutationCallOptions } from './product-transport-types'
import type {
  AnnotationMergePatch,
  AnnotationPage,
  AnnotationView,
  CreateAnnotationRequest,
  DeleteAnnotationResult,
} from './types'

export function createAnnotationsTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async listAnnotations(collectionId: string, params: AnnotationSubjectParams) {
      const query: Record<string, string | number | undefined> = {
        resourceType: params.resourceType,
        resourceId: params.resourceId,
      }
      if (params.cursor) query.cursor = params.cursor
      else if (params.limit != null) query.limit = params.limit
      return request<AnnotationPage>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/annotations`,
        query,
        signal: params.signal,
      })
    },

    async getAnnotation(collectionId: string, annotationId: string, signal?: AbortSignal) {
      return request<AnnotationView>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/annotations/${encodeURIComponent(annotationId)}`,
        signal,
      })
    },

    async createAnnotation(
      collectionId: string,
      subject: Pick<AnnotationSubjectParams, 'resourceType' | 'resourceId'>,
      body: CreateAnnotationRequest,
      opts: MutationCallOptions,
    ) {
      return request<AnnotationView>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/annotations`,
        query: { resourceType: subject.resourceType, resourceId: subject.resourceId },
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async updateAnnotation(
      collectionId: string,
      annotationId: string,
      body: AnnotationMergePatch,
      opts: MutationCallOptions,
    ) {
      return request<AnnotationView>({
        method: 'PATCH',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/annotations/${encodeURIComponent(annotationId)}`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/merge-patch+json',
        signal: opts.signal,
      })
    },

    async deleteAnnotation(collectionId: string, annotationId: string, opts: MutationCallOptions) {
      return request<DeleteAnnotationResult>({
        method: 'DELETE',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/annotations/${encodeURIComponent(annotationId)}`,
        headers: mutationHeaders(opts),
        signal: opts.signal,
      })
    },
  }
}
