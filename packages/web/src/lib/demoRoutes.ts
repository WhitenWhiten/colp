/**
 * Demo and QA sandboxes (/demos, /demo/*, /extension/popup) are mounted only
 * in development or in a build that opts in with VITE_DEMO_ROUTES=true.
 * Production builds fold this to `false` and tree-shake the sandbox chunks
 * (R15-09): they serve canned data under real chrome and name seeded
 * moderation accounts.
 */
export const DEMO_ROUTES_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_ROUTES === 'true'
