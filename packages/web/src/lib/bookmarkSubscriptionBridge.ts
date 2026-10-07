export type BookmarkSubscriptionSource = { sourceType: 'collection' | 'digest_series'; sourceId: string }
type BridgeRuntime = { sendMessage: (extensionId: string, message: unknown, callback: (reply: unknown) => void) => void; lastError?: unknown }
export type BridgeResult = 'accepted' | 'unavailable'

export function subscriptionDeployment() {
  const extensionId = import.meta.env.VITE_KNOWN_EXTENSION_ID?.trim() ?? ''
  const rawStore = import.meta.env.VITE_KNOWN_EXTENSION_STORE_URL?.trim() ?? ''
  let storeUrl: string | null = null
  try {
    const url = new URL(rawStore)
    if (url.protocol === 'https:' && ['chromewebstore.google.com', 'microsoftedge.microsoft.com'].includes(url.hostname) && !url.username && !url.password) storeUrl = url.href
  } catch { /* An unpublished deployment uses the setup page. */ }
  return { extensionId: /^[a-p]{32}$/.test(extensionId) ? extensionId : null, storeUrl }
}

/** Only a source reference crosses this boundary; the extension validates it and opens its wizard. */
export async function openBookmarkSubscription(source: BookmarkSubscriptionSource, requestId: string,
  options: { extensionId?: string | null; runtime?: BridgeRuntime; timeoutMs?: number } = {},
): Promise<BridgeResult> {
  if (!['collection', 'digest_series'].includes(source.sourceType) || !/^[A-Za-z0-9._~-]{1,128}$/.test(source.sourceId) || !/^[0-9a-f-]{36}$/i.test(requestId)) return 'unavailable'
  const id = options.extensionId ?? subscriptionDeployment().extensionId
  const runtime = options.runtime ?? (globalThis as typeof globalThis & { chrome?: { runtime?: BridgeRuntime } }).chrome?.runtime
  if (!id || !/^[a-p]{32}$/.test(id) || !runtime?.sendMessage) return 'unavailable'
  return new Promise(resolve => {
    let settled = false
    const finish = (result: BridgeResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const timer = setTimeout(() => finish('unavailable'), options.timeoutMs ?? 2500)
    try {
      runtime.sendMessage(id, { kind: 'known.subscription.open', requestId, sourceType: source.sourceType, sourceId: source.sourceId }, reply => {
        if (runtime.lastError) { finish('unavailable'); return }
        const value = reply as { accepted?: unknown; protocolVersion?: unknown } | null
        finish(value?.accepted === true && value.protocolVersion === 1 ? 'accepted' : 'unavailable')
      })
    } catch { finish('unavailable') }
  })
}
