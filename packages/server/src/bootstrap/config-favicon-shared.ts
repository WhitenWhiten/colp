import { resolveFaviconProviderUrl } from '../modules/collections/index.js';

export interface SharedFaviconConfig {
  readonly providerTemplate: string;
  readonly refreshIntervalMs: number;
  readonly providerIntervalMs: number;
}
export function loadSharedFaviconConfig(env: NodeJS.ProcessEnv): SharedFaviconConfig {
  const providerTemplate = env.FAVICON_SHARED_PROVIDER_TEMPLATE?.trim() || 'https://favicone.com/{hostname}';
  if (!resolveFaviconProviderUrl(providerTemplate, 'example.com')) {
    throw new Error('FAVICON_SHARED_PROVIDER_TEMPLATE must be a safe HTTPS template with {hostname}');
  }
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside its supported range`);
    return value;
  };
  return {
    providerTemplate,
    refreshIntervalMs: integer('FAVICON_SHARED_REFRESH_INTERVAL_SECONDS', 2_592_000, 86_400, 31_536_000) * 1000,
    providerIntervalMs: integer('FAVICON_PROVIDER_INTERVAL_MS', 10_000, 1000, 3_600_000),
  };
}
