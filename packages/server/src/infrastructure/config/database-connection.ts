import { loadNodeEnvironment, type NodeEnvironment } from './environment.js';

// The bootstrap import graph grants only this dependency-free config leaf
// (`infrastructure/config/database-connection.ts`). Re-export the shared
// process-environment facts from here so bootstrap, the migration CLI and the
// seed CLI all use the same NODE_ENV/HOST normalization.
export {
  DEFAULT_LISTEN_HOST,
  isNodeEnvironment,
  loadListenHost,
  loadNodeEnvironment,
  NODE_ENVIRONMENTS,
  type NodeEnvironment,
} from './environment.js';

export interface DatabaseConnectionConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
}

/** Parse the connection facts shared by application and maintenance processes. */
export function loadDatabaseConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionConfig {
  // Validate/normalize first: NODE_ENV decides the SSL default and every
  // production-only gate, so an unknown value must never fall through.
  const nodeEnv = loadNodeEnvironment(env);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const databaseSslMode = (
    env.DATABASE_SSL_MODE ?? (nodeEnv === 'production' ? 'require' : 'disable')
  ).trim();
  if (databaseSslMode !== 'require' && databaseSslMode !== 'disable') {
    throw new Error('DATABASE_SSL_MODE must be require or disable');
  }
  return Object.freeze({
    nodeEnv,
    databaseUrl,
    databaseSsl: databaseSslMode === 'require',
  });
}
