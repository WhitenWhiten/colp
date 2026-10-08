import { afterEach, beforeEach } from 'vitest'
import { cleanup } from './render'

const unexpectedFetches: string[] = []
const rejectUnexpectedFetch: typeof fetch = async (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const url = input instanceof Request ? input.url : String(input)
  unexpectedFetches.push(`${method.toUpperCase()} ${url}`)
  throw new Error(`unexpected network request in unit test: ${method.toUpperCase()} ${url}`)
}

beforeEach(() => {
  unexpectedFetches.length = 0
  globalThis.fetch = rejectUnexpectedFetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = rejectUnexpectedFetch
  if (unexpectedFetches.length > 0) {
    throw new Error(`unit test issued undeclared network requests:\n${unexpectedFetches.join('\n')}`)
  }
})
