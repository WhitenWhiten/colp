import { allocateCommandId } from './command-intent'
import { wrapGeneratedClientError } from './errors'
import { createProductWriteApprovalClient } from '@known/product-v1-client'
import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions, WriteApprovalListParams } from './product-transport-types'
import type {
  WriteApprovalDecision,
  WriteApprovalDecisionResult,
} from './types'

export function createWriteApprovalTransport(http: ProductTransportHttp) {
  const { fetchImpl, origin } = http

  function writeApprovalClient(csrfToken: string, signal?: AbortSignal) {
    const transport = fetchImpl ?? globalThis.fetch
    const fetchWithSignal: typeof globalThis.fetch = signal
      ? (input, init) => transport(input, { ...init, signal })
      : (input, init) => transport(input, init)
    return createProductWriteApprovalClient({
      origin: origin ?? 'http://localhost',
      csrfToken,
      ...(origin ? { originHeader: origin } : {}),
      fetch: fetchWithSignal,
    })
  }

  async function runWriteApprovalClient<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw wrapGeneratedClientError(error)
    }
  }
  return {
    async listWriteApprovals(params?: WriteApprovalListParams) {
      const client = writeApprovalClient('', params?.signal)
      return runWriteApprovalClient(() => client.approvals({ limit: params?.limit }))
    },

    async getWriteApproval(planId: string, signal?: AbortSignal) {
      const client = writeApprovalClient('', signal)
      return runWriteApprovalClient(() => client.approval(planId))
    },

    async decideWriteApproval(
      planId: string,
      decision: WriteApprovalDecision,
      opts: MutationCallOptions & { ifMatch: string },
    ): Promise<WriteApprovalDecisionResult> {
      const commandId = allocateCommandId(opts.commandIntentId)
      const client = writeApprovalClient(opts.csrfToken, opts.signal)
      return runWriteApprovalClient(() => client.decide(planId, decision, opts.ifMatch, commandId))
    },
  }
}
