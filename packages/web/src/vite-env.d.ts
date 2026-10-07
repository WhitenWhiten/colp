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
  readonly VITE_FOLLOW_ACCEPTANCE?: string
  /** Fail-closed collection-follow candidate path used only by independent acceptance. */
  readonly VITE_COLLECTION_FOLLOW_ACCEPTANCE?: string
  /** Fail-closed LH-04 candidate path used only by independent acceptance. */
  readonly VITE_LINK_HEALTH_ACCEPTANCE?: string
  /** Fail-closed classify inbox candidate path used only by independent acceptance. */
  readonly VITE_CLASSIFY_ACCEPTANCE?: string
  /** Fail-closed OG-FE-01 candidate path used only by independent acceptance. */
  readonly VITE_AI_ORGANIZE_ACCEPTANCE?: string
  /** Fail-closed HV-FE-01 candidate path used only by independent acceptance. */
  readonly VITE_COLLECTION_HISTORY_ACCEPTANCE?: string
  /** Fail-closed RX-FE-01 candidate path used only by independent acceptance. */
  readonly VITE_READABLE_REPLICA_ACCEPTANCE?: string
  /** `true` mounts the demo and QA sandboxes in a non-dev build (R15-09). */
  readonly VITE_DEMO_ROUTES?: string
  /** `self-hosted` drops social routes and gates first-run registration. */
  readonly VITE_EDITION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
