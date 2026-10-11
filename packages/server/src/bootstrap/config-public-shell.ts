import { parseExactOrigin, requireNonEmpty } from './config-parse-helpers.js';
import type { PublicShellMetaConfig } from './config-types.js';

export function loadPublicShellConfigs(env: NodeJS.ProcessEnv): Readonly<{
  publicShellMeta: PublicShellMetaConfig;
}> {
  const collectionEnabled = parseFlag(env.KNOWN_FEATURE_PUBLIC_SHELL_META, 'KNOWN_FEATURE_PUBLIC_SHELL_META');
  const origin = collectionEnabled
    ? parseExactOrigin(requireNonEmpty(env, 'WEB_SHELL_ORIGIN'), 'WEB_SHELL_ORIGIN')
    : null;
  return Object.freeze({
    publicShellMeta: Object.freeze({ enabled: collectionEnabled, webShellOrigin: collectionEnabled ? origin : null }),
  });
}

function parseFlag(value: string | undefined, name: string): boolean {
  const normalized = (value ?? 'false').trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false') throw new Error(`${name} must be true or false`);
  return normalized === 'true';
}
