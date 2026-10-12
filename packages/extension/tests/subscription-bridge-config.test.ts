import { describe, expect, it } from 'vitest';
// @ts-expect-error Build script is JavaScript and is not part of the browser bundle.
import { subscriptionBridgeMatches } from '../scripts/subscription-bridge-config.mjs';
const config = { environment: 'production', serverOrigin: 'https://know-n.com', subscriptionBridgeOrigins: [{ webOrigin: 'https://know-n.com', serverOrigin: 'https://know-n.com' }] };
describe('subscription deployment allowlist', () => {
  it('generates exact origin matches and defaults to no external access', () => {
    expect(subscriptionBridgeMatches(config)).toEqual(['https://know-n.com/*']);
    expect(subscriptionBridgeMatches({ ...config, subscriptionBridgeOrigins: undefined })).toEqual([]);
  });
  it.each(['https://know-n.com/path', 'https://know-n.com/', 'https://*.know-n.com', 'http://know-n.com', 'https://evil.test@know-n.com'])('rejects non-exact or insecure origins: %s', webOrigin => {
    expect(() => subscriptionBridgeMatches({ ...config, subscriptionBridgeOrigins: [{ webOrigin, serverOrigin: config.serverOrigin }] })).toThrow();
  });
  it('rejects cross-environment IDs and duplicate origins', () => {
    expect(() => subscriptionBridgeMatches({ ...config, subscriptionBridgeOrigins: [{ webOrigin: 'https://know-n.com', serverOrigin: 'https://staging.known.example' }] })).toThrow();
    expect(() => subscriptionBridgeMatches({ ...config, subscriptionBridgeOrigins: [...config.subscriptionBridgeOrigins, ...config.subscriptionBridgeOrigins] })).toThrow();
  });
});
