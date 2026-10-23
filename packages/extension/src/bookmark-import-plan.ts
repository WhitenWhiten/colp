import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalOperationDigest } from '@know-n/colp/sync/canonical';
import { decodeBookmarkFaviconDataUrl } from './favicon-import.js';
import type { createFaviconSidecarStore } from './favicon-sidecar-store.js';
import { operation as validateColpOperation } from './generated/bookmark-operation-validators.js';
import type { ImportConversionResult, NormalizedImportNode } from './import-preview.js';
import type { ImportNodeRecord, ImportRecoveryCode, JsonObject, SyncScope,
  createSyncStateStore } from './sync-state-store.js';

export type ImportFolderChoice = { readonly sourceNodeId: string; readonly action: 'skip' }
  | { readonly sourceNodeId: string; readonly action: 'import'; readonly target: {
    readonly nativeId: string; readonly colpId: string; readonly revision: string } };
export type ImportFolderTarget = Extract<ImportFolderChoice, { action: 'import' }>['target'];

/** Commit re-reads the live Chromium tree and rejects a changed conversion/source digest. */
export function assertPreviewSourceUnchanged(previewed: ImportConversionResult, live: ImportConversionResult): void {
  if (previewed.digest !== live.digest || previewed.source.identity !== live.source.identity
      || previewed.source.profile !== live.source.profile) throw new Error('preview_expired');
}

/** Destinations must be the selected-root mappings shown in the same preview. */
export function bindImportFolderChoices(choices: readonly ImportFolderChoice[],
  allowed: ReadonlyMap<string, ImportFolderTarget>): ImportFolderChoice[] {
  return choices.map((choice) => {
    if (choice.action === 'skip') return choice;
    const target = allowed.get(`${choice.target.nativeId}\u0000${choice.target.colpId}`);
    if (!target) throw new Error('folder_choice_invalid');
    return { sourceNodeId: choice.sourceNodeId, action: 'import' as const,
      target: { nativeId: target.nativeId, colpId: target.colpId, revision: target.revision } };
  });
}
export interface BookmarkImportProgress { readonly total: number; readonly skipped: number; readonly queued: number;
  readonly terminal: number; readonly recoverable: number }
export interface BookmarkImportView { readonly planId: string; readonly state: 'active' | 'paused' | 'complete' | 'attention';
  readonly sourceProfile: ImportConversionResult['source']['profile']; readonly nodes: readonly ImportNodeRecord[];
  readonly progress: BookmarkImportProgress }
interface CoordinatorOptions { readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly now?: () => number }

export function createBookmarkImportCoordinator(options: CoordinatorOptions) {
  const now = options.now ?? Date.now;

  async function commit(input: { readonly conversion: ImportConversionResult;
    readonly choices: readonly ImportFolderChoice[];
    readonly sidecar?: ReturnType<typeof createFaviconSidecarStore>;
    readonly collectionId?: string; readonly randomUUID?: () => string; readonly now?: () => number;
  }): Promise<BookmarkImportView> {
    if (input.conversion.preview.creates === 0 || input.conversion.tree.length === 0) throw new Error('import_empty');
    const choiceMap = validateChoices(input.conversion.tree, input.choices);
    const choiceDigest = digestJson([...choiceMap.values()].map((choice) => choice.action === 'skip' ? choice : {
      sourceNodeId: choice.sourceNodeId, action: choice.action, target: {
        nativeId: choice.target.nativeId, colpId: choice.target.colpId } }).sort((a, b) => a.sourceNodeId.localeCompare(b.sourceNodeId)));
    const planId = `import-${hash(`${input.conversion.digest}\u0000${choiceDigest}`)}`;
    const existingPlans = await options.store.listImportPlans(options.scope);
    if (existingPlans.some((plan) => plan.planId !== planId && plan.state !== 'complete')) {
      throw new Error('import_in_progress');
    }
    const flattened: Array<{ node: NormalizedImportNode; parent: string | null; root: string; order: number }> = [];
    input.conversion.tree.forEach((node) => flatten(node, null, node.sourceNodeId, flattened));
    const nodes = flattened.map(({ node, parent, root, order }) => {
      const rootChoice = choiceMap.get(root)!; const skipped = rootChoice.action === 'skip';
      return { planId, sourceNodeId: node.sourceNodeId, order, parentSourceNodeId: parent,
        opId: `import-op-${hash(`${planId}\u0000${node.sourceNodeId}`)}`, choice: skipped ? 'skip' as const : 'import' as const,
        status: skipped ? 'skipped' as const : 'staged' as const,
        ...(rootChoice.action === 'skip' ? {} : { target: rootChoice.target }),
        node: skipped ? { kind: node.kind.toLowerCase() } : operationNode(node) };
    });
    const createdAt = now(); const allSkipped = nodes.every((node) => node.choice === 'skip');
    const plan = await options.store.commitImportPlan(options.scope, { plan: { planId,
      conversionDigest: input.conversion.digest, sourceProfile: input.conversion.source.profile,
      sourceIdentity: input.conversion.source.identity, choiceDigest, state: allSkipped ? 'complete' : 'active',
      createdAt, updatedAt: createdAt }, nodes });
    await materializeImportFavicons({ flattened, choiceMap, planId, sidecar: input.sidecar,
      collectionId: input.collectionId ?? options.scope.collectionId,
      randomUUID: input.randomUUID, createdAt: (input.now ?? now)() });
    if (plan.state === 'active') await advance(planId);
    return status(planId);
  }

  async function advance(planId: string): Promise<BookmarkImportView> {
    await reconcileAuthority(planId); let madeProgress = true;
    while (madeProgress) {
      madeProgress = false; const plans = await options.store.listImportPlans(options.scope);
      const plan = plans.find((item) => item.planId === planId); if (!plan) throw new Error('import_plan_not_found');
      if (plan.state !== 'active') break;
      const nodes = await options.store.listImportNodes(options.scope, planId);
      const bySource = new Map(nodes.map((node) => [node.sourceNodeId, node]));
      for (const node of nodes) {
        if (node.choice !== 'import' || (node.status !== 'staged' && node.status !== 'recoverable')) continue;
        const parent = await authoritativeParent(node, bySource); if (!parent) continue;
        try {
          await options.store.enqueueImportNode(options.scope, { planId, sourceNodeId: node.sourceNodeId,
            occurredAt: new Date(now()).toISOString(), parent, operation: { type: 'create_node', baseRevision: null,
              dependencies: [], payload: { parentId: parent.colpId, node: node.node } },
            nativeId: importNativeId(planId, node.sourceNodeId),
            validateOperation: validateColpOperation, digestOperation: canonicalOperationDigest });
        } catch (error) {
          if (error instanceof Error && (error.message === 'import_paused' || error.message === 'import_plan_inactive')) {
            return refreshPlanState(planId);
          }
          throw error;
        }
        madeProgress = true;
      }
    }
    return refreshPlanState(planId);
  }

  async function authoritativeParent(node: ImportNodeRecord, bySource: ReadonlyMap<string, ImportNodeRecord>) {
    if (node.parentSourceNodeId === null) return node.target ?? null;
    const parent = bySource.get(node.parentSourceNodeId); if (!parent || parent.choice !== 'import') return null;
    if (parent.authoritativeTarget) return { nativeId: importNativeId(node.planId, parent.sourceNodeId),
      colpId: parent.authoritativeTarget.colpId, revision: parent.authoritativeTarget.revision };
    const mapping = await options.store.getMappingByNativeId(options.scope, importNativeId(node.planId, parent.sourceNodeId));
    if (!mapping || mapping.colpId.startsWith('pending-')) return null;
    return { nativeId: mapping.nativeId, colpId: mapping.colpId, revision: mapping.projection.revision };
  }

  async function reconcileAuthority(planId: string) {
    const nodes = await options.store.listImportNodes(options.scope, planId);
    for (const node of nodes) {
      if (node.authoritativeTarget || !node.opId) continue;
      const queued = await options.store.getQueueByOpId(options.scope, node.opId);
      if (queued?.status === 'rejected') { await options.store.setImportNodeRecovery(options.scope, planId, node.opId, 'push_rejected');
        await options.store.setImportPlanState(options.scope, planId, 'attention', now()); continue; }
      if (queued?.status !== 'terminal') continue;
      const receipt = await options.store.getQueueReceipt(options.scope, queued.sequence);
      const result = receipt?.result;
      if (result?.status === 'conflict') { await options.store.setImportNodeRecovery(options.scope, planId, node.opId, 'conflict');
        await options.store.setImportPlanState(options.scope, planId, 'attention', now()); continue; }
      const mapping = await options.store.getMappingByNativeId(options.scope, importNativeId(planId, node.sourceNodeId));
      const targetId = result?.targetId; const revision = result?.revision;
      if (mapping?.colpId.startsWith('pending-') && typeof targetId === 'string' && typeof revision === 'string') {
        await options.store.rebindProvisionalBookmarkIdentity(options.scope, mapping.nativeId, node.opId, targetId, revision);
        continue;
      }
      if (mapping && !mapping.colpId.startsWith('pending-')) continue;
      await options.store.setImportNodeRecovery(options.scope, planId, node.opId, 'conflict');
      await options.store.setImportPlanState(options.scope, planId, 'attention', now());
    }
  }

  async function status(planId?: string): Promise<BookmarkImportView> {
    const plans = await options.store.listImportPlans(options.scope); const plan = planId
      ? plans.find((item) => item.planId === planId) : plans.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!plan) throw new Error('import_plan_not_found'); const nodes = await options.store.listImportNodes(options.scope, plan.planId);
    // Receipt settlement stamps the import node in the same transaction as the
    // queue. That durable outcome survives reclamation of completed Sync history.
    const terminal = nodes.filter((node) => node.status === 'terminal').length;
    return { planId: plan.planId, state: plan.state, sourceProfile: plan.sourceProfile, nodes,
      progress: { total: nodes.length, skipped: nodes.filter((node) => node.choice === 'skip').length,
        queued: nodes.filter((node) => node.sequence !== undefined && node.status !== 'terminal').length,
        terminal, recoverable: nodes.filter((node) => node.status === 'recoverable').length } };
  }

  async function pause(planId: string) { await options.store.setImportPlanState(options.scope, planId, 'paused', now());
    return status(planId); }
  async function resume(planId: string) { await options.store.setImportPlanState(options.scope, planId, 'active', now());
    return advance(planId); }
  async function retry(planId: string) { const nodes = await options.store.listImportNodes(options.scope, planId);
    for (const node of nodes) if (node.status === 'recoverable' && node.recovery !== 'conflict') {
      await options.store.retryImportNode(options.scope, planId, node.opId);
    }
    if (nodes.some((node) => node.status === 'recoverable' && node.recovery === 'conflict')) {
      await options.store.setImportPlanState(options.scope, planId, 'attention', now()); return status(planId);
    }
    await options.store.setImportPlanState(options.scope, planId, 'active', now()); return advance(planId); }
  async function recordRecovery(planId: string, opId: string, code: ImportRecoveryCode) {
    const node = (await options.store.listImportNodes(options.scope, planId)).find((item) => item.opId === opId);
    if (!node) throw new Error('import_node_not_found');
    if (node.status === 'terminal' || node.status === 'skipped') return status(planId);
    await options.store.setImportNodeRecovery(options.scope, planId, opId, code);
    await options.store.setImportPlanState(options.scope, planId, 'attention', now()); return status(planId); }

  async function refreshPlanState(planId: string) {
    const view = await status(planId); if (view.state === 'paused' || view.state === 'attention') return view;
    if (view.progress.terminal + view.progress.skipped === view.progress.total) {
      await options.store.setImportPlanState(options.scope, planId, 'complete', now()); return status(planId);
    }
    return view;
  }
  return Object.freeze({ commit, advance, status, pause, resume, retry, recordRecovery });
}

function validateChoices(tree: readonly NormalizedImportNode[], choices: readonly ImportFolderChoice[]) {
  const roots = new Set(tree.map((node) => node.sourceNodeId)); const result = new Map<string, ImportFolderChoice>();
  for (const choice of choices) {
    if (!roots.has(choice.sourceNodeId) || result.has(choice.sourceNodeId)) throw new Error('folder_choice_invalid');
    if (choice.action === 'import' && (!choice.target.nativeId || !choice.target.colpId || !choice.target.revision)) {
      throw new Error('folder_choice_invalid');
    }
    result.set(choice.sourceNodeId, choice);
  }
  if (result.size !== roots.size) throw new Error('folder_choice_required'); return result;
}
function flatten(node: NormalizedImportNode, parent: string | null, root: string,
  output: Array<{ node: NormalizedImportNode; parent: string | null; root: string; order: number }>) {
  output.push({ node, parent, root, order: output.length });
  for (const child of node.children) flatten(child, node.sourceNodeId, root, output);
}
function operationNode(node: NormalizedImportNode): JsonObject {
  const kind = node.kind.toLowerCase(); if (kind === 'separator') return { kind };
  return kind === 'bookmark' ? { kind, title: node.title ?? '', url: node.url ?? '' }
    : { kind, title: node.title ?? '' };
}
async function materializeImportFavicons(input: {
  readonly flattened: ReadonlyArray<{ node: NormalizedImportNode; root: string }>;
  readonly choiceMap: ReadonlyMap<string, ImportFolderChoice>; readonly planId: string;
  readonly sidecar?: ReturnType<typeof createFaviconSidecarStore>; readonly collectionId: string;
  readonly randomUUID?: () => string; readonly createdAt: number;
}): Promise<void> {
  if (!input.sidecar) return;
  const uuid = input.randomUUID ?? (() => crypto.randomUUID());
  for (const { node, root } of input.flattened) {
    if (input.choiceMap.get(root)?.action === 'skip' || node.kind !== 'Bookmark' || typeof node.icon !== 'string') continue;
    try {
      const decoded = decodeBookmarkFaviconDataUrl(node.icon);
      if (!decoded) continue;
      await input.sidecar.put({
        nativeId: importNativeId(input.planId, node.sourceNodeId), contentType: decoded.contentType, bytes: decoded.bytes,
        commandId: uuid().toLowerCase(), collectionId: input.collectionId, createdAt: input.createdAt,
        attempts: 0, notBefore: 0, origin: 'import',
      });
    } catch { /* Import UX must not fail because icon materialization failed. */ }
  }
}
function importNativeId(planId: string, sourceNodeId: string) { return `import:${planId}:${sourceNodeId}`; }
function hash(value: string) { return bytesToHex(sha256(new TextEncoder().encode(value))); }
function digestJson(value: unknown) { return `sha256:${hash(stableJson(value))}`; }
function stableJson(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>; return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`; }
