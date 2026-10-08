import { loadConfig as loadRuntimeConfig } from '../../src/bootstrap/config.js';
export * from '../../src/bootstrap/config.js';

/** Isolated suites do not provision R2. Export suites opt in explicitly, while
 * default/startup contract tests import the production loader directly. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadRuntimeConfig({ KNOWN_FEATURE_EXPORT_JOBS: 'false', ...env });
}
