import type { operations } from '../../server/generated/openapi/product-v1.js';
import { captureCloudEnabled, manifestCloudEnabled } from './cloud-capability.js';
import { readBoundedJson } from './json-response.js';
import { assertCredentialHostPermission } from './server-origin-permission.js';

type Preview = operations['previewCollectionBookmarkClassification'];
export type ClassificationPreviewRequest = Preview['requestBody']['content']['application/json'];
export type ClassificationPreviewResponse = Preview['responses'][200]['content']['application/json'];
// The Extension only ever reads the server_managed projection: provider-profile
// selection is Web-only and server BYOK is dormant by default, while the
// BYOK-capable v2 media type answers 404 whenever KNOWN_FEATURE_CLASSIFICATION_BYOK
// is false (plan D4). Asking for it would make every server classification fail
// with `classification_unavailable`.
export type ClassificationSettings = operations['getCollectionClassificationSettings']['responses'][200]['content']['application/json'];
export type CaptureEditorPage = operations['getCollectionEditorPage']['responses'][200]['content']['application/json'];

export class ClassificationProductError extends Error {
  constructor(readonly code: string, readonly status: number, readonly sameRequestRetrySafe = false) {
    super(code); this.name = 'ClassificationProductError';
  }
}

/**
 * A Product response that deterministically refused this exact request, so its
 * durable command may be closed and a replacement issued.
 *
 * `401 reconnect_required` is deliberately NOT terminal: the Product session
 * (cookie/CSRF) expiring is an authorization change, not a verdict on the
 * command. Every call site constructs it with `new ClassificationProductError(
 * 'reconnect_required', 401)` when no verified session exists, so treating it as
 * a rejection would permanently strand an otherwise replayable command. 408/429
 * and retry-safe responses are transient for the same reason.
 */
export function isDefinitiveClassificationRejection(error: unknown): error is ClassificationProductError {
  return error instanceof ClassificationProductError && error.status >= 400 && error.status < 500
    && error.status !== 401 && error.code !== 'reconnect_required' && error.code !== 'unsupported'
    && !error.sameRequestRetrySafe && error.status !== 408 && error.status !== 429;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Product cookies only. Never receives a COLP bearer, raw Cookie header or provider credential. */
export function createClassificationProductClient(options: {
  readonly serverOrigin: string; readonly expectedAuthUserId: string;
  /** `false` when Manifest `features.cloud` is off. Omitted reads the manifest on capability checks. */
  readonly cloudEnabled?: boolean;
  readonly dispatch?: (send: () => Promise<Response>) => Promise<Response>;
  readonly assertCurrent: () => Promise<void>; readonly assertMutation?: () => Promise<void>; readonly signal?: AbortSignal; readonly fetch?: typeof fetch;
}) {
  const origin = new URL(options.serverOrigin);
  if (origin.origin !== options.serverOrigin || origin.username || origin.password
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname)))) throw new TypeError('Invalid Product origin');
  if (!options.expectedAuthUserId) throw new ClassificationProductError('reconnect_required',401);
  const fetcher = options.fetch ?? fetch;
  let verifiedSessionId: string | null = null;
  async function manifestAllowsCloud(): Promise<boolean> {
    if (options.cloudEnabled === false) return false;
    if (options.cloudEnabled === true) return true;
    try {
      const response = await fetcher(`${origin.origin}/.well-known/collection-protocol`, {
        redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/vnd.collection-protocol.manifest+json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return true;
      return manifestCloudEnabled(await response.json());
    } catch { return true; }
  }
  async function request(path: string, init: RequestInit = {}, timeoutMs = 5000, maxBytes = 64 * 1024): Promise<{body:unknown;response:Response}> {
    if (options.cloudEnabled === false) throw new ClassificationProductError('unsupported', 404);
    await options.assertCurrent();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline,options.signal]) : deadline;
    let response: Response;
    if (init.method === 'POST') await options.assertMutation?.();
    try {
      const send = async () => {
        const url = `${origin.origin}${path}`;
        const request: RequestInit = { ...init, credentials: 'include', redirect: 'error', cache: 'no-store', signal };
        await assertCredentialHostPermission(url, request);
        return fetcher(url, request);
      };
      response = await (options.dispatch ? options.dispatch(send) : send());
    }
    catch { throw new ClassificationProductError('transport_error',0,true); }
    let body: unknown;
    try { body = await readBoundedJson(response,maxBytes,'classification_response_invalid'); }
    catch { throw new ClassificationProductError(response.status === 404 ? 'unsupported' : 'classification_response_invalid', response.status, response.status !== 404); }
    await options.assertCurrent();
    if (!response.ok) {
      if (response.status === 401) throw new ClassificationProductError('reconnect_required',401);
      if (response.status === 404) throw new ClassificationProductError('unsupported', 404);
      const error = record(body) && record(body.error) ? body.error : null;
      const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/u.test(error.code) ? error.code : 'classification_unavailable';
      throw new ClassificationProductError(code,response.status,error?.sameRequestRetrySafe === true);
    }
    return {body,response};
  }
  async function bootstrap(): Promise<string> {
    const {body} = await request('/api/v1/session');
    if (!record(body) || body.authenticated !== true || typeof body.csrfToken !== 'string' || !body.csrfToken || body.csrfToken.length > 1024) {
      throw new ClassificationProductError('reconnect_required',401);
    }
    // Product account ids differ from BA auth user ids. Verify the browser cookie's
    // BA identity against the Extension's authority without transmitting its token.
    const identity = (await request('/api/v1/auth/get-session')).body;
    if (!record(identity) || !record(identity.user) || identity.user.id !== options.expectedAuthUserId) throw new ClassificationProductError('reconnect_required',401);
    verifiedSessionId = record(identity.session) && typeof identity.session.id === 'string' ? identity.session.id : null;
    return body.csrfToken;
  }
  async function mutate<T>(path: string, document: unknown, commandId: string, ifMatch?: string): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(commandId)) throw new TypeError('Invalid command id');
    const body = JSON.stringify(document);
    const send = async (csrf: string) => { return request(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,
      'Known-Command-Id':commandId,...(ifMatch ? {'If-Match':ifMatch} : {})},body},22000); };
    let result;
    try { result = await send(await bootstrap()); }
    catch (error) {
      // A verified CSRF rejection occurs before admission/provider work. Refresh
      // once after cookie rotation, preserving the command, body and If-Match.
      if (!(error instanceof ClassificationProductError) || error.status !== 403 || error.code !== 'csrf_failed') throw error;
      result = await send(await bootstrap());
    }
    return result.body as T;
  }
  return {
    async captureLearning() {
      await bootstrap(); const sessionId = verifiedSessionId;
      if (!sessionId) throw new ClassificationProductError('reconnect_required', 401);
      const result = await request('/api/v1/me/capture-learning');
      if (result.response.headers.get('Known-Capture-Session') !== sessionId) throw new ClassificationProductError('reconnect_required', 401);
      return result.body as operations['getCaptureLearning']['responses'][200]['content']['application/json'];
    },
    clearCaptureLearning: (commandId: string, generation: number) =>
      mutate<operations['clearCaptureLearning']['responses'][200]['content']['application/json']>('/api/v1/me/capture-learning/clear', {}, commandId, `"capture-learning-${generation}"`),
    reportCapture: (document: operations['reportCaptureTask']['requestBody']['content']['application/json'], commandId: string) =>
      mutate<operations['reportCaptureTask']['responses'][200]['content']['application/json']>('/api/v1/me/bookmark-captures', document, commandId),
    async captureHistory(query: Readonly<Record<string, string>>, aggregate = false) {
      await bootstrap(); const sessionId = verifiedSessionId;
      if (!sessionId) throw new ClassificationProductError('reconnect_required', 401);
      const result = await request(`/api/v1/me/bookmark-captures${aggregate ? '/aggregate' : ''}?${new URLSearchParams(query)}`, {}, 5000, 4 * 1024 * 1024);
      if (result.response.headers.get('Known-Capture-Session') !== sessionId) throw new ClassificationProductError('reconnect_required', 401);
      return result.body as operations['getCaptureHistory']['responses'][200]['content']['application/json'] | operations['getCaptureStatistics']['responses'][200]['content']['application/json'];
    },
    async captureCapabilities() {
      if (!(await manifestAllowsCloud())) return 'unsupported' as const;
      try {
        await bootstrap();
        const body = (await request('/api/v1/me/capture-capabilities')).body;
        if (!captureCloudEnabled(body)) return 'unsupported' as const;
        return body as operations['getMyCaptureCapabilities']['responses'][200]['content']['application/json'];
      } catch (error) {
        if (error instanceof ClassificationProductError && error.code === 'unsupported') return 'unsupported' as const;
        throw error;
      }
    },
    async findCaptureDecision(collectionId: string, captureId: string) {
      await bootstrap(); const sessionId = verifiedSessionId;
      if (!sessionId) throw new ClassificationProductError('reconnect_required', 401);
      const result = await request(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions?${new URLSearchParams({ captureId })}`);
      if (result.response.headers.get('Known-Capture-Session') !== sessionId) throw new ClassificationProductError('reconnect_required', 401);
      return (result.body as operations['findCaptureDecision']['responses'][200]['content']['application/json']).decision;
    },
    async captureDecision(collectionId: string, decisionId: string) {
      await bootstrap();
      return (await request(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions/${encodeURIComponent(decisionId)}`)).body as operations['getCaptureDecision']['responses'][200]['content']['application/json'];
    },
    classifyCapture: (collectionId: string, document: operations['classifyCapturedBookmark']['requestBody']['content']['application/json'], commandId: string) =>
      mutate<operations['classifyCapturedBookmark']['responses'][200]['content']['application/json']>(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions`, document, commandId),
    applyCapture: (collectionId: string, decisionId: string, controlGeneration: number, commandId: string, ifMatch: string, userInitiated = false) =>
      mutate<operations['applyCaptureDecision']['responses'][200]['content']['application/json']>(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions/${encodeURIComponent(decisionId)}/apply`, { controlGeneration, ...(userInitiated ? { userInitiated: true } : {}) }, commandId, ifMatch),
    undoCapture: (collectionId: string, decisionId: string, commandId: string, ifMatch: string) =>
      mutate<operations['undoCaptureDecision']['responses'][200]['content']['application/json']>(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions/${encodeURIComponent(decisionId)}/undo`, {}, commandId, ifMatch),
    captureFeedback: (collectionId: string, decisionId: string, document: operations['recordCaptureFeedback']['requestBody']['content']['application/json'], expectedRevision: number) =>
      mutate<operations['recordCaptureFeedback']['responses'][200]['content']['application/json']>(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions/${encodeURIComponent(decisionId)}/feedback`, document, document.eventId, `"capture-feedback-${expectedRevision}"`),
    correctCapture: (collectionId: string, decisionId: string, document: { parentId: string; tags: readonly string[]; learningEligible?: boolean; evidenceGeneration?: number }, commandId: string, ifMatch: string) =>
      mutate<operations['correctCaptureDecision']['responses'][200]['content']['application/json']>(`/api/v1/collections/${encodeURIComponent(collectionId)}/capture-decisions/${encodeURIComponent(decisionId)}/correct`, document, commandId, ifMatch),
    async editorPage(collectionId: string, cursor?: string): Promise<CaptureEditorPage> {
      await bootstrap();
      const sessionId = verifiedSessionId;
      if (!sessionId) throw new ClassificationProductError('reconnect_required', 401);
      const query = cursor ? `cursor=${encodeURIComponent(cursor)}` : 'limit=100';
      const result = await request(`/api/v1/collections/${encodeURIComponent(collectionId)}/editor?${query}`, {}, 5000, 2 * 1024 * 1024);
      if (result.response.headers.get('Known-Editor-Session') !== sessionId) throw new ClassificationProductError('reconnect_required', 401);
      return result.body as CaptureEditorPage;
    },
    async session() { await bootstrap(); return {authenticated:true as const}; },
    async settings(collectionId: string) {
      // No Accept override: `application/json` is the server_managed projection the
      // Extension consumes, and the only one that exists while server BYOK is off.
      await bootstrap(); const result = await request(`/api/v1/collections/${encodeURIComponent(collectionId)}/classification-settings`);
      return {settings:result.body as ClassificationSettings,etag:result.response.headers.get('etag')};
    },
    preview: (collectionId: string, document: ClassificationPreviewRequest, commandId: string) =>
      mutate<ClassificationPreviewResponse>(`/api/v1/collections/${encodeURIComponent(collectionId)}/classification/preview`,document,commandId),
  };
}
