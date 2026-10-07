import { assertClassificationRequestBudget,ClassificationProviderError,type ClassificationCallResult } from '../../modules/collections/index.js';
import type { ClassificationUpstream } from './classification-provider-cloudflare-jev.js';

/** Upper bound on a header value so a hostile `retry-after` cannot overflow the math. */
const MAX_RETRY_AFTER_MS = 3_600_000;
/** A retry never blocks longer than this, even when the header asks for more. */
const MAX_RETRY_WAIT_MS = 10_000;

/** Requested backoff in ms, unclamped so the caller can decide whether it fits the deadline. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const parsedDate = Date.parse(header);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, Math.min(parsedDate - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return 1000;
}

async function waitWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ClassificationProviderError('deadline');
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ClassificationProviderError('deadline'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

export function createCloudflareJevTransport(upstream: ClassificationUpstream, transport: typeof fetch = globalThis.fetch) {
  async function request(input: unknown, signal: AbortSignal, deadlineAt?: string): Promise<{
    readonly payload: Record<string, unknown>; readonly usage: Omit<ClassificationCallResult, 'answer'>;
  }> {
    assertClassificationRequestBudget(input);
    if (signal.aborted) throw new ClassificationProviderError('deadline');
    let attempts = 0;
    const send = async () => {
      attempts += 1;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (upstream.credential.accessKey) headers['Authorization'] = `Bearer ${upstream.credential.accessKey}`;
      if (upstream.credential.gatewayId) headers['cf-aig-gateway-id'] = upstream.credential.gatewayId;
      // D1: never let a missing gateway BYOK key fall through to Unified Billing.
      if (upstream.byokOnly) headers['cf-aig-no-wholesale'] = 'true';
      // The internal input already is {state, questions}; the Cloudflare envelope nests it.
      const body = upstream.wire === 'typesafe_systemone_v1'
        ? {...(input as Record<string, unknown>), model: upstream.model}
        : {model: upstream.model, input};
      return transport(upstream.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(upstream.requestTimeoutMs)]),
        headers,
        body: JSON.stringify(body),
      });
    };
    let response: Response;
    try { response = await send(); }
    catch { throw new ClassificationProviderError('outcome_unknown', attempts); }

    if (response.status === 429 || response.status === 529) {
      try { await response.body?.cancel(); } catch {}
      const retryAfter = response.headers.get('retry-after');
      const requestedDelayMs = parseRetryAfterMs(retryAfter);
      // Only start a retry that can still finish inside the stage deadline: the
      // requested backoff plus a full attempt must fit. A 429 proves the provider
      // did not run, so an unfitting retry is terminal `rate_limited` — which the
      // caller refunds — instead of a wait that burns the deadline.
      const remainingMs = deadlineAt ? Date.parse(deadlineAt) - Date.now() : null;
      if (remainingMs !== null && (!Number.isFinite(remainingMs) || requestedDelayMs + upstream.requestTimeoutMs > remainingMs))
        throw new ClassificationProviderError('rate_limited', attempts);
      await waitWithSignal(Math.min(requestedDelayMs, MAX_RETRY_WAIT_MS), signal);
      try { response = await send(); }
      catch { throw new ClassificationProviderError('outcome_unknown', attempts); }
    }

    if (!response.ok) {
      try{await response.body?.cancel();}catch{ /* The received status remains authoritative; error bodies are never retained. */ }
      if (response.status === 401 || response.status === 403) throw new ClassificationProviderError('credentials', attempts);
      if (response.status === 400) throw new ClassificationProviderError('contract_drift', attempts);
      if (response.status === 429 || response.status === 529) throw new ClassificationProviderError('rate_limited', attempts);
      throw new ClassificationProviderError('outcome_unknown', attempts);
    }
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > 65536) throw new ClassificationProviderError('contract_drift', attempts);
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ClassificationProviderError) throw error;
      throw new ClassificationProviderError('outcome_unknown', attempts);
    }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ClassificationProviderError('contract_drift', attempts); }
    if(payload?.success===false)throw new ClassificationProviderError('outcome_unknown', attempts);
    for (let i = 0; i < 3 && payload && !payload.answers && payload.result; i++) payload = payload.result as Record<string, unknown>;
    const reportedModel = typeof payload.model === 'string' && payload.model ? payload.model : null;
    const expected = upstream.expectedModelVersion;
    if (!payload || !reportedModel || (expected && reportedModel !== expected)) throw new ClassificationProviderError('contract_drift', attempts);
    const usage = payload.usage as Record<string, unknown> | undefined;
    const token = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {payload, usage: {modelVersion: reportedModel, inputTokens: token(usage?.input_tokens), outputTokens: token(usage?.output_tokens), attemptNumber: attempts}};
  }
  return request;
}
