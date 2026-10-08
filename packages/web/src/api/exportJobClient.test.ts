import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCommandId, getOrCreateCommandId } from './commandId'
import { productClient } from './productClient'
import {
  createMemorySessionStorage,
  installFetchMock,
  installSessionStorage,
  isUuidV4,
  jsonResponse,
  productErrorBody,
  requestHeaders,
  requestMethod,
  requestPathAndSearch,
  resetProductSession,
  seedAuthenticatedSession,
  type FetchCall,
} from './test-helpers'
import type { ExportJob, ExportJobPage, ExportLibraryDocument } from './types'

const INTENT = 'create-export-job'
const ENCODED_JOB_ID = 'job/a+b'

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

function requestHref(call: FetchCall): string {
  if (typeof call.input === 'string') return call.input
  if (call.input instanceof URL) return call.input.href
  return call.input.url
}

function exportJob(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    jobId: 'job-1',
    status: 'pending',
    createdAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  }
}

function exportPage(items: ExportJob[] = [exportJob()]): ExportJobPage {
  return { items }
}

function exportDocument(overrides: Partial<ExportLibraryDocument> = {}): ExportLibraryDocument {
  return {
    exportedAt: '2026-08-23T00:00:00.000Z',
    collections: [],
    ...overrides,
  }
}

describe('EXJ-FE export-job Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    restoreFetch = undefined
    resetProductSession()
  })

  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
    clearCommandId(INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('lists export jobs without mutation headers and with credentials include', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse(exportPage()))
    restoreFetch = mock.restore
    const signal = new AbortController().signal

    const page = await productClient.listMyExportJobs({ signal, maxRetries: 0 })
    expect(page.items[0]?.jobId).toBe('job-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/export-jobs')
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('creates an export job with CSRF and Known-Command-Id, without If-Match or JSON body', async () => {
    seedAuthenticatedSession('csrf-export-job')
    const commandId = getOrCreateCommandId(INTENT)
    const mock = installFetchMock(() => jsonResponse(exportJob()))
    restoreFetch = mock.restore

    const job = await productClient.createMyExportJob({ intentId: INTENT, maxRetries: 0 })
    expect(job.jobId).toBe('job-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/export-jobs')
    expect(call.init?.credentials).toBe('include')
    const body = call.init?.body
    expect(body == null || body === '').toBe(true)
    expect(String(body ?? '')).not.toBe('{}')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-export-job')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBeNull()
    expect(headers.get('Content-Type') ?? '').not.toMatch(/application\/json/i)
  })

  it('encodes jobId on get and download paths', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock((input) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (href.includes('/download')) return jsonResponse(exportDocument())
      return jsonResponse(exportJob({ jobId: ENCODED_JOB_ID, status: 'ready' }))
    })
    restoreFetch = mock.restore

    await productClient.getMyExportJob(ENCODED_JOB_ID, { maxRetries: 0 })
    const getCall = lastCall(mock.calls)
    expect(requestMethod(getCall)).toBe('GET')
    expect(requestHref(getCall)).toContain(`/api/v1/me/export-jobs/${encodeURIComponent(ENCODED_JOB_ID)}`)
    expect(requestHref(getCall)).not.toContain('/download')

    await productClient.downloadMyExportJob(ENCODED_JOB_ID, { maxRetries: 0 })
    const downloadCall = lastCall(mock.calls)
    expect(requestMethod(downloadCall)).toBe('GET')
    expect(requestHref(downloadCall)).toContain(
      `/api/v1/me/export-jobs/${encodeURIComponent(ENCODED_JOB_ID)}/download`,
    )
    expect(downloadCall.init?.credentials).toBe('include')
  })

  it('throws command_in_progress on POST with maxRetries 0 without extra retries', async () => {
    seedAuthenticatedSession('csrf-export-job')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_in_progress',
        message: 'busy',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore

    await expect(productClient.createMyExportJob({ intentId: INTENT, maxRetries: 0 }))
      .rejects.toMatchObject({ status: 409, code: 'command_in_progress' })
    expect(mock.calls).toHaveLength(1)
    expect(requestMethod(mock.calls[0]!)).toBe('POST')
  })
})
