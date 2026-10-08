import type { AppConfig } from '../bootstrap/config.js';

export type ExtensionProductOriginConfiguration = {readonly allowedOrigins: readonly string[]; readonly betterAuth: Pick<AppConfig['betterAuth'], 'enabled' | 'trustedOrigins'>};
export function extensionProductAllowedOrigins(config: ExtensionProductOriginConfiguration): readonly string[] {
  const extensionOrigins = config.betterAuth.enabled
    ? config.betterAuth.trustedOrigins.filter(origin => /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) : [];
  return [...new Set([...config.allowedOrigins, ...extensionOrigins])];
}
