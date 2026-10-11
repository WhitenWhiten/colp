/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KNOWN_EXTENSION_ID?: string
  readonly VITE_KNOWN_EXTENSION_STORE_URL?: string
  /**
   * Product API origin (no trailing slash), e.g. `http://localhost:3000`.
   * Empty / unset → relative `/api/v1/...` (same-origin or Vite proxy).
   */
  readonly VITE_API_ORIGIN?: string
  /** Explicit local-only bypass for Product session bootstrap. */
  readonly VITE_MOCK_SESSION?: string
  /** Fail-closed P2B-09 candidate path used only by independent acceptance. */
  readonly VITE_ANNOTATIONS_ACCEPTANCE?: string
  /** Fail-closed LH-04 candidate path used only by independent acceptance. */
  readonly VITE_LINK_HEALTH_ACCEPTANCE?: string
  /** Fail-closed HV-FE-01 candidate path used only by independent acceptance. */
  readonly VITE_COLLECTION_HISTORY_ACCEPTANCE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
