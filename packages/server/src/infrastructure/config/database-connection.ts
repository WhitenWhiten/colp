export interface DatabaseConnectionConfig {
  readonly nodeEnv: string;
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
}

/** Parse the connection facts shared by application and maintenance processes. */
export function loadDatabaseConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConnectionConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
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
