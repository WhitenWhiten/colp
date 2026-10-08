import type { ProductTransport } from './product-transport-types'
import {
  createAuthRetryRead,
  type ReadOptions,
  type SessionReader,
} from './product-client-shared'
import type { CreditLedgerListParams } from './product-transport-types'

export function createProductCreditsClient(
  transport: ProductTransport,
  getSession: SessionReader,
) {
  const authRetryRead = createAuthRetryRead(getSession)

  return {
    getMyCredits(options?: ReadOptions) {
      return authRetryRead(
        () => transport.getMyCredits(options?.signal),
        options,
      )
    },

    listMyCreditLedger(params: Omit<CreditLedgerListParams, 'signal'> = {}, options?: ReadOptions) {
      return authRetryRead(
        () => transport.listMyCreditLedger({ ...params, signal: options?.signal }),
        options,
      )
    },

    getMyCreditLedgerEntry(entryId: string, options?: ReadOptions) {
      return authRetryRead(
        () => transport.getMyCreditLedgerEntry(entryId, options?.signal),
        options,
      )
    },
  }
}
