import { normalizeUrl, type EventFacts, type PlacementIntent } from '@know-n/colp/automation';
import type { CaptureAutomation } from '../capture/contracts.js';
import { canonicalLocation, projectRule, type CanonicalLocation, type ProjectionDeps } from './binding-projector.js';
import { bundleState, type BundleRecord } from './bundle-store.js';
import { evaluateLocalRules, ruleCollectionId } from './runtime-profile.js';

/**
 * The pre-save rule path. Every extension-owned save (popup, shortcut, context
 * menu, Save tabs) asks the installed rules where the bookmark belongs before
 * `chrome.bookmarks.create`, so a rule places it directly: there is no
 * create-then-move. The decision is recorded on the capture task as evaluated.
 *
 * The facts are the server's for a Sync create in this collection: the URL
 * through the shared normalizer, the title, the canonical parent and ancestors
 * of the folder the save would otherwise use, and no tags (tags are written
 * after the create, so a `hasTag` rule never matches at intake here or on the
 * server). An explicit folder choice is `userSelected`, which no rule
 * overrides; remembered and default folders are `userDefault`.
 */
export interface PreSaveScope { readonly collectionId: string; readonly replicaId: string; readonly generation: number }
export interface PreSaveInput {
  readonly url: string;
  readonly title: string;
  /** Where the save goes without a rule. */
  readonly parentNativeId: string;
  readonly explicit: boolean;
}
export interface PreSaveDecision {
  readonly automation: CaptureAutomation;
  /** The rule's folder in this browser; only a placement has one. */
  readonly targetNativeId: string | null;
}

export function preSaveFacts(page: Pick<PreSaveInput, 'url' | 'title'>, collectionId: string, location: CanonicalLocation,
  intent: PlacementIntent, now: number): EventFacts {
  const url = normalizeUrl(page.url);
  return { eventId: 'pre-save', operationId: 'pre-save', type: 'node.created', collectionId, nodeId: 'pre-save', commitOrdinal: '0',
    occurredAt: new Date(now).toISOString(), origin: 'sync', changedFields: ['create'], hopCount: 0, intakeDisposition: intent,
    bookmark: { kind: 'bookmark', title: page.title, tags: [], url: url.status === 'available' ? { host: url.host, path: url.path } : { host: '' },
      ...(location.parent ? { parent: location.parent } : {}), ancestors: [...location.ancestors] } };
}

/**
 * The rules' decision for one save, or null when no rule applies (none
 * installed, paused, another collection, no match). An expired copy is still
 * evaluated so the save can say its rules are out of date, but it never places.
 */
export async function decidePreSave(context: { readonly record: BundleRecord; readonly now: number; readonly scope: PreSaveScope;
  readonly deps: ProjectionDeps }, input: PreSaveInput): Promise<PreSaveDecision | null> {
  const { record, now, scope, deps } = context;
  const state = bundleState(record, now).state;
  const bundle = record.bundle;
  if (!bundle || !record.serverUuid || (state !== 'active' && state !== 'expired')) return null;
  const rules = bundle.rules.filter((rule) => ruleCollectionId(rule) === scope.collectionId);
  if (!rules.length) return null;
  const local = await Promise.all(rules.map((rule) => projectRule(rule, scope.collectionId, deps)));
  const location = await canonicalLocation(input.parentNativeId, { serverUuid: record.serverUuid, collectionId: scope.collectionId }, deps);
  const intent: PlacementIntent = input.explicit ? 'userSelected' : 'userDefault';
  const placement = evaluateLocalRules(local, preSaveFacts(input, scope.collectionId, location, intent, now), intent);
  if (placement.kind === 'none') return null;
  const ruleId = placement.kind === 'place' ? placement.ruleId : placement.ruleIds[0]!;
  const rule = rules.find((item) => item.ruleId === ruleId)!;
  const expired = state === 'expired' && placement.kind !== 'keep';
  const outcome: CaptureAutomation['outcome'] = expired ? 'expired' : placement.kind === 'place' ? 'placed'
    : placement.kind === 'keep' ? 'kept' : placement.kind;
  const automation: CaptureAutomation = {
    outcome, ...(placement.kind === 'blocked' && !expired ? { reason: placement.reason } : {}),
    rule: { id: rule.ruleId, name: rule.definition.name, revision: rule.ruleRevision, bindingRevision: rule.bindingRevision,
      semanticDigest: rule.semanticDigest },
    ruleIds: [...placement.ruleIds], bundleRevision: bundle.revision, settingsRevision: bundle.settingsRevision,
    satisfies: placement.kind === 'place' && !expired ? [...placement.satisfies] : [],
    ...(placement.kind === 'place' ? { destination: { ...placement.folder.folder }, folderTitle: placement.folder.title } : {}),
    fromNativeId: input.parentNativeId, collectionId: scope.collectionId, replicaId: scope.replicaId, generation: scope.generation,
  };
  return { automation, targetNativeId: outcome === 'placed' && placement.kind === 'place' ? placement.folder.nativeId : null };
}

/** A placement that could not use the rule's folder after all (it turned out unavailable for saving) is blocked. */
export function blockedPlacement(automation: CaptureAutomation): CaptureAutomation {
  const { destination: _destination, folderTitle: _title, ...rest } = automation;
  return { ...rest, outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [] };
}
