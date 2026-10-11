/**
 * Feature flags for the self-hosted web UI.
 *
 * - `false` -> the capability is not offered
 * - `true`  -> use the real API; if the API fails the page shows an error
 *
 * Tests can override a flag with `window.__KNOWN_FLAGS__`.
 */
export const FEATURE_FLAGS = {
  annotations: true,
  relations: true,
  collaborators: true,
  collectionHistory: true,
  // MCP write approvals. Navigation is limited to signed-in accounts; direct
  // links resume after sign-in.
  writeApprovals: true,
  linkHealth: true,
} as const

export type FeatureFlag = keyof typeof FEATURE_FLAGS

/** Returns true when the backend capability is ready and the page should use real API. */
export function isLive(flag: FeatureFlag): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.[flag] !== undefined) {
    return window.__KNOWN_FLAGS__[flag] === true
  }
  return FEATURE_FLAGS[flag] === true
}

declare global {
  interface Window { __KNOWN_FLAGS__?: Partial<Record<FeatureFlag, boolean>> }
}

/** MCP write approval exposure is live; the Vite switch remains an acceptance override. */
export function isWriteApprovalsExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.writeApprovals !== undefined) {
    return window.__KNOWN_FLAGS__.writeApprovals
  }
  try {
    return FEATURE_FLAGS.writeApprovals
      || String(import.meta.env?.VITE_WRITE_APPROVALS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** LH-04 link-health exposure is live; VITE_LINK_HEALTH_ACCEPTANCE remains as an acceptance-only override. */
export function isLinkHealthExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.linkHealth !== undefined) {
    return window.__KNOWN_FLAGS__.linkHealth
  }
  try {
    return FEATURE_FLAGS.linkHealth
      || String(import.meta.env?.VITE_LINK_HEALTH_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** HV-FE-02 collection history exposure is live; VITE_COLLECTION_HISTORY_ACCEPTANCE is an acceptance-only override. */
export function isCollectionHistoryExposureEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__KNOWN_FLAGS__?.collectionHistory !== undefined) {
    return window.__KNOWN_FLAGS__.collectionHistory
  }
  try {
    return FEATURE_FLAGS.collectionHistory
      || String(import.meta.env?.VITE_COLLECTION_HISTORY_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}
