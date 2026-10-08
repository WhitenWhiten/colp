import { allocateCommandId } from './command-intent'
import { parseProductError } from './product-error'
import { createProductWriteApprovalClient } from '@known/product-v1-client'
import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions, WriteApprovalListParams } from './product-transport-types'
import type {
  WriteApprovalDecision,
  WriteApprovalDecisionResult,
  WriteApprovalPage,
  WriteApprovalView,
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
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const generated = error as { status?: number; problem?: unknown; headers?: Headers }
      if (typeof generated?.status === 'number') {
        throw parseProductError(generated.status, generated.problem, generated.headers ?? {})
      }
      throw parseProductError(
        0,
        {
          error: {
            code: 'transport_error',
            message: error instanceof Error ? error.message : 'Network error',
            recovery: 'same_request',
            sameRequestRetrySafe: true,
          },
        },
        {},
      )
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
