import type { ProductTransportHttp } from './product-transport-http'
import type { CreditLedgerListParams } from './product-transport-types'
import type { CreditLedgerEntryResponse, CreditLedgerPage, CreditOverview } from './types'

export function createCreditsTransport(http: ProductTransportHttp) {
  const { request } = http

  return {
    async getMyCredits(signal?: AbortSignal) {
      return request<CreditOverview>({
        method: 'GET',
        path: '/api/v1/me/credits',
        query: { includeBillingMode: 'true' },
        signal,
      })
    },

    async listMyCreditLedger(params?: CreditLedgerListParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else {
        query.limit = params?.limit
        query.kind = params?.kind
        query.from = params?.from
        query.to = params?.to
        query.chargeId = params?.chargeId
        query.runId = params?.runId
      }
      return request<CreditLedgerPage>({
        method: 'GET',
        path: '/api/v1/me/credits/ledger',
        query,
        signal: params?.signal,
      })
    },

    async getMyCreditLedgerEntry(entryId: string, signal?: AbortSignal) {
      return request<CreditLedgerEntryResponse>({
        method: 'GET',
        path: `/api/v1/me/credits/ledger/${encodeURIComponent(entryId)}`,
        signal,
      })
    },
  }
}
