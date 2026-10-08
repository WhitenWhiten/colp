import type { ProductTransportHttp } from './product-transport-http'
import type { ClassifyInboxListParams, MutationCallOptions } from './product-transport-types'
import type {
  ClassifyInboxAcceptReceipt,
  ClassifyInboxAcceptRequest,
  ClassifyInboxDecisionReceipt,
  ClassifyInboxPage,
  ClassifyInboxSkipRequest,
} from './types'

export function createClassifyTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async getMyClassifyInbox(params?: ClassifyInboxListParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else {
        query.limit = params?.limit
      }
      return request<ClassifyInboxPage>({
        method: 'GET',
        path: '/api/v1/me/classify-inbox',
        query,
        headers: { Accept: 'application/json' },
        signal: params?.signal,
      })
    },

    async skipMyClassifyInboxItem(
      nodeId: string,
      body: ClassifyInboxSkipRequest,
      opts: MutationCallOptions,
    ) {
      return request<ClassifyInboxDecisionReceipt>({
        method: 'POST',
        path: `/api/v1/me/classify-inbox/${encodeURIComponent(nodeId)}/skip`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async acceptMyClassifyInboxItem(
      nodeId: string,
      body: ClassifyInboxAcceptRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<ClassifyInboxAcceptReceipt>({
        method: 'POST',
        path: `/api/v1/me/classify-inbox/${encodeURIComponent(nodeId)}/accept`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}
