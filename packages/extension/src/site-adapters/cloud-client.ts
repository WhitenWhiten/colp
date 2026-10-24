import { readBoundedJson } from '../json-response.js';
import { sourceDigest } from './source-db.js';
export const SOURCE_CLOUD_PATH = '/colp/v0.1/sync/source-archives';
export interface CloudScope { site: string; identityVersion: number; sourceAccount: string; collectionId: string;
  roots: { ruleId: string; nodeId: string; resourceRevision: string; collectionIds: string[] }[];
  policy: { revision: number; copies: 'sourceAndSemantic'; backgroundClassification: 'disabled'; sourceRemoval: 'retainArchive' };
  rulesDigest: string; bindingDigest: string }
export interface CloudEdge { itemId: string; collectionId: string; collectionTitle: string; title: string; url: string; ruleId: string; entry: 'siteImport' | 'reconcile'; observationDigest: string }
export interface CloudLease { replicaId: string; epoch: number; token: string; expiresAt: number }
export interface CloudEffect { itemId: string; collectionId: string; ruleId: string; nodeId: string; finalParentId: string; resourceRevision: string; operationId: string | null; disposition: 'created' | 'reused' }
export interface CloudMutation { kind: 'folder' | 'bookmark'; nodeId: string; parentId: string; operationId: string; resourceRevision: string; contentRevision: string; commitOrdinal: string }
export interface CloudReceipt { version: 1; planId: string; digest: string; epoch: number; collectionId: string; classification: 'disabled'; effects: CloudEffect[]; effectDigest: string; mutations: CloudMutation[]; mutationsDigest: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function assertSourceCloudProfile(v: unknown) {
  if (!record(v) || v.version !== 1 || v.sourceAdmission !== 1 || v.sourceFinalEffects !== 1 || v.sourceAuthorityLease !== 1
    || v.classification !== false || v.classificationDestinationPolicy !== false || v.maxEdges !== 20 || v.leaseMs !== 120000
    || JSON.stringify(v.copies) !== JSON.stringify(['sourceAndSemantic'])) throw new Error('sourceCloudUnsupported');
}
/** No fallback to ordinary rule/intake/classification endpoints on older deployments. */
export function createSourceCloudClient(ports: { origin: string; fetch: typeof fetch; headers(): Promise<Record<string, string>>; assertCurrent(): Promise<void>; authorize?(action?: string): Promise<void> }) {
  const url = new URL(SOURCE_CLOUD_PATH, ports.origin);
  async function request(action?: string, input?: unknown): Promise<unknown> {
    await ports.assertCurrent(); await ports.authorize?.(action); const headers = await ports.headers(); await ports.assertCurrent(); await ports.authorize?.(action); const signal = AbortSignal.timeout(15000);
    const response = await ports.fetch(url, { method: action ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { ...headers, Accept: 'application/json', ...(action ? { 'Content-Type': 'application/json' } : {}) },
      ...(action ? { body: JSON.stringify({ version: 1, action, input }) } : {}) });
    const data = await readBoundedJson(response, 256 * 1024, 'sourceCloudInvalid', { signal });
    if (!response.ok) throw new Error(record(data) && record(data.error) && typeof data.error.code === 'string' ? data.error.code : 'sourceCloudUnsupported');
    await ports.assertCurrent(); return data;
  }
  return { async profile() { const v = await request(); assertSourceCloudProfile(v); return v; },
    async call<T>(action: string, input: unknown): Promise<T> { await this.profile(); return await request(action, input) as T; } };
}
export function assertCloudReceipt(v: unknown, plan: { planId: string; digest: string; epoch: number; scope: CloudScope; edges: CloudEdge[] }): asserts v is CloudReceipt {
  if (!record(v) || v.version !== 1 || v.planId !== plan.planId || v.digest !== plan.digest || v.epoch !== plan.epoch || v.collectionId !== plan.scope.collectionId
    || !Array.isArray(v.mutations) || v.mutations.length > 40 || v.mutationsDigest !== sourceDigest(v.mutations) || v.classification !== 'disabled' || !Array.isArray(v.effects) || v.effects.length !== plan.edges.length || v.effectDigest !== sourceDigest(v.effects)) throw new Error('sourceCloudReceiptInvalid');
  const nodes = new Set<string>();
  for (const m of v.mutations) {
    if (!record(m) || !['folder', 'bookmark'].includes(String(m.kind)) || typeof m.nodeId !== 'string' || !m.nodeId || nodes.has(m.nodeId)
      || typeof m.parentId !== 'string' || !m.parentId || m.nodeId === m.parentId || typeof m.operationId !== 'string' || !m.operationId
      || typeof m.resourceRevision !== 'string' || !m.resourceRevision || typeof m.contentRevision !== 'string' || !m.contentRevision
      || typeof m.commitOrdinal !== 'string' || !/^[1-9]\d*$/.test(m.commitOrdinal)) throw new Error('sourceCloudReceiptInvalid');
    if (m.kind === 'folder' && !plan.scope.roots.some(r => r.nodeId === m.parentId)) throw new Error('sourceCloudReceiptInvalid');
    nodes.add(m.nodeId);
  }
  for (let n = 0; n < plan.edges.length; n++) {
    const e = plan.edges[n]!, f = v.effects[n];
    if (!record(f) || f.itemId !== e.itemId || f.collectionId !== e.collectionId || f.ruleId !== e.ruleId || typeof f.nodeId !== 'string' || !f.nodeId
      || typeof f.finalParentId !== 'string' || !f.finalParentId || f.nodeId === f.finalParentId || typeof f.resourceRevision !== 'string' || !f.resourceRevision
      || !['created', 'reused'].includes(String(f.disposition)) || !(f.operationId === null || typeof f.operationId === 'string')
      || f.disposition === 'created' && !v.mutations.some(m => record(m) && m.kind === 'bookmark' && m.nodeId === f.nodeId && m.parentId === f.finalParentId && m.operationId === f.operationId && m.resourceRevision === f.resourceRevision)
      || plan.scope.roots.some(r => r.nodeId === f.finalParentId)) throw new Error('sourceCloudReceiptInvalid');
  }
}
