/** Legacy entry point: retired phase scopes now use the explicit current
 * eleven-owner sync audit. See docs/sync-audit-coverage.md for real PG execution
 * and per-file floors; this is not whole-server or historical phase coverage. */
export { default } from './vitest.sync-audit-coverage.config.js';
