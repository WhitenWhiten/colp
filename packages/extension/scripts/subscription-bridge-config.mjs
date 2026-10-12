/** Build-time allowlist; runtime verifies the exact origin and backend again. */
export function subscriptionBridgeMatches(config) {
  const entries = config.subscriptionBridgeOrigins ?? [];
  if (!Array.isArray(entries) || entries.length > 16) throw new Error('Invalid subscription bridge allowlist');
  const origins = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['webOrigin', 'serverOrigin'].includes(key))) throw new Error('Invalid subscription bridge entry');
    const web = new URL(entry.webOrigin), server = new URL(entry.serverOrigin);
    const local = config.environment === 'development' && web.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(web.hostname);
    if (web.hostname.includes('*') || (!local && web.protocol !== 'https:') || web.origin !== entry.webOrigin || web.username || web.password || server.origin !== entry.serverOrigin || entry.serverOrigin !== config.serverOrigin || origins.has(web.origin)) throw new Error('Subscription bridge must use exact, unique, deployment-bound origins');
    origins.add(web.origin);
  }
  return [...origins].map(origin => origin + '/*');
}
