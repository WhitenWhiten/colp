/**
 * P1-13: command intent ID allocation (stable UUID v4 per user intent).
 *
 * Production: src/api/commandId.ts
 *   getOrCreateCommandId / clearCommandId / rotateCommandId
 *   sessionStorage prefix: known.command-id.v1:
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCommandId,
  getOrCreateCommandId,
  isCommandId,
  mutationIntentKey,
  rotateCommandId,
} from './commandId'
import {
  createMemorySessionStorage,
  installSessionStorage,
  isUuidV4,
} from './test-helpers'

const STORAGE_PREFIX = 'known.command-id.v1:'

describe('getOrCreateCommandId / clearCommandId / rotateCommandId', () => {
  let restoreStorage: () => void
  let storage: Storage

  beforeEach(() => {
    storage = createMemorySessionStorage()
    restoreStorage = installSessionStorage(storage)
  })

  afterEach(() => {
    restoreStorage()
  })

  it('returns the same UUID for the same intentId across retries', () => {
    const first = getOrCreateCommandId('create-collection:draft-1')
    const second = getOrCreateCommandId('create-collection:draft-1')

    expect(isUuidV4(first)).toBe(true)
    expect(isCommandId(first)).toBe(true)
    expect(second).toBe(first)
    expect(storage.getItem(`${STORAGE_PREFIX}create-collection:draft-1`)).toBe(first)
  })

  it('allocates a different id for a different intentId', () => {
    const a = getOrCreateCommandId('create-collection:draft-1')
    const b = getOrCreateCommandId('create-collection:draft-2')

    expect(isUuidV4(a)).toBe(true)
    expect(isUuidV4(b)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('persists lowercase UUID v4 values only', () => {
    const id = getOrCreateCommandId('node-create:parent-root')
    expect(id).toBe(id.toLowerCase())
    expect(isUuidV4(id)).toBe(true)
  })

  it('clearCommandId allows a new id for the same intent on the next user action', () => {
    const first = getOrCreateCommandId('delete-node:n1')
    clearCommandId('delete-node:n1')
    expect(storage.getItem(`${STORAGE_PREFIX}delete-node:n1`)).toBeNull()

    const second = getOrCreateCommandId('delete-node:n1')
    expect(isUuidV4(second)).toBe(true)
    expect(second).not.toBe(first)
  })

  it('clearCommandId is a no-op when the intent was never allocated', () => {
    expect(() => clearCommandId('never-used')).not.toThrow()
    expect(storage.getItem(`${STORAGE_PREFIX}never-used`)).toBeNull()
  })

  it('rotateCommandId replaces the stored id (command_id_reused / result expired)', () => {
    const first = getOrCreateCommandId('intent-rotate')
    const rotated = rotateCommandId('intent-rotate')
    expect(isUuidV4(rotated)).toBe(true)
    expect(rotated).not.toBe(first)
    expect(getOrCreateCommandId('intent-rotate')).toBe(rotated)
  })

  it('rejects empty intentId', () => {
    expect(() => getOrCreateCommandId('')).toThrow(/intent(Key|Id)/i)
  })

  it('mutationIntentKey builds a stable scope:nonce key', () => {
    expect(mutationIntentKey('create-node:col-1', 'nonce-a')).toBe(
      'create-node:col-1:nonce-a',
    )
  })
})

describe('unavailable command storage', () => {
  let restoreStorage: () => void
  beforeEach(() => { restoreStorage = installSessionStorage(createMemorySessionStorage()) })
  afterEach(() => { restoreStorage() })
  it('keeps one command in memory if storage reads and writes fail', () => {
    const read = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      const first = getOrCreateCommandId('blocked-classification')
      expect(getOrCreateCommandId('blocked-classification')).toBe(first)
      clearCommandId('blocked-classification')
      expect(getOrCreateCommandId('blocked-classification')).not.toBe(first)
    } finally { read.mockRestore(); write.mockRestore(); clearCommandId('blocked-classification') }
  })
  it('also keeps the command if reads work but quota prevents persistence', () => {
    const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      const first = getOrCreateCommandId('quota-classification')
      expect(getOrCreateCommandId('quota-classification')).toBe(first)
    } finally { write.mockRestore(); clearCommandId('quota-classification') }
  })
})
