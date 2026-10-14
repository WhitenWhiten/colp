import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createHardenedEgressFetch, type HardenedEgressFetchOptions } from '../egress/index.js';
import { createWebhookCipher, signWebhook } from './webhook-signer.js';
/** Used for both challenges and occurrences: bounded response, no inherited credentials or redirects. */
export function createWebhookTransport(options: Pick<HardenedEgressFetchOptions,'resolve' | 'connect'> = {}) {
  const fetch = createHardenedEgressFetch({ ...options,followRedirects: false,label: 'automation webhook' });
  return async (url: string,body: string,headers: Record<string,string>,readBody = false) => {
    const controller = new AbortController(),timer = setTimeout(() => controller.abort(),10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(url,{ method: 'POST',body,headers,signal: controller.signal,redirect: 'error' });
      if(!readBody){await response.body?.cancel();return {status:response.status,body:'',retryAfter:response.headers.get('retry-after')};}
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];let size=0;
      if (reader) for (;;) {
        const chunk = await reader.read();if (chunk.done) break;
        size += chunk.value.byteLength;if (size>8192) throw new Error('Callback response exceeded its budget.');
        chunks.push(chunk.value);
      }
      return { status: response.status,body: Buffer.concat(chunks).toString('utf8'),retryAfter: response.headers.get('retry-after') };
    } catch { throw new Error('Callback request failed.'); }
    finally { clearTimeout(timer);controller.abort();await reader?.cancel().catch(() => {}); }
  };
}
export function createWebhookVerifier(masterKey: Buffer,options: Pick<HardenedEgressFetchOptions,'resolve' | 'connect'> & { previousMasterKey?: Buffer } = {}) {
  const cipher = createWebhookCipher(masterKey,options.previousMasterKey),send = createWebhookTransport(options);
  return { ...cipher,send,async verify(input: { id: string; url: string; secret: string }) {
    const challenge = randomBytes(32).toString('base64url'),body = JSON.stringify({ type: 'verification',challenge });
    const headers = signWebhook({ id: randomUUID(),subscriptionId: input.id,body,secret: input.secret });
    const response = await send(input.url,body,headers,true);
    if (response.status !== 200) throw new Error('Callback challenge failed.');
    let echo: unknown;try { echo=JSON.parse(response.body).challenge; } catch { throw new Error('Callback challenge failed.'); }
    if (typeof echo !== 'string' || Buffer.byteLength(echo) !== Buffer.byteLength(challenge)
      || !timingSafeEqual(Buffer.from(echo),Buffer.from(challenge))) throw new Error('Callback challenge failed.');
  } };
}
