import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  automationDigest, normalizeRuleDefinition, ruleSemanticDigest,
  type CompiledRule, type EventFacts, type FolderRef, type Rule, type RuleBundle, type RuleDefinition, type Run,
} from '@know-n/colp/automation';

/** Reviewed M1 rule (copied byte for byte from packages/node/tests/fixtures/automation). */
export const M1_RULE = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/automation/m1-placement.json'), 'utf8')) as RuleDefinition;
export const SERVER_UUID = 'server-fixture';
export const COLLECTION_ID = 'c_personal';
export const folderRef = (nodeId: string, collectionId = COLLECTION_ID): FolderRef => ({ serverUuid: SERVER_UUID, collectionId, nodeId });

/** A compiled rule the way the server's compileBundle produces it: normalized definition, digest, bindings. */
export function compiledRule(input: {
  readonly ruleId?: string; readonly folder?: FolderRef; readonly priority?: number; readonly host?: string;
  readonly definition?: Partial<RuleDefinition>; readonly ruleRevision?: string; readonly bindingRevision?: string;
} = {}): CompiledRule {
  const base: RuleDefinition = { ...structuredClone(M1_RULE), ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.host ? { match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: input.host } } : {}), ...input.definition };
  const definition = normalizeRuleDefinition(base);
  return { ruleId: input.ruleId ?? 'rule-arxiv', ruleRevision: input.ruleRevision ?? '1', bindingRevision: input.bindingRevision ?? '1',
    definition, programId: 'hostRoute', parameters: { host: 'arxiv.org', folderRole: 'academicRoot' },
    nativeBindingHints: { academicRoot: { kind: 'folder', folder: input.folder ?? folderRef('academic'), followIdentity: true,
      onUnavailable: 'block', notifyOn: ['delete'] } },
    semanticDigest: ruleSemanticDigest(definition) };
}

export const DAY = 86_400_000;
export const NOW = Date.parse('2026-10-14T08:00:00.000Z');

export function ruleBundle(rules: readonly CompiledRule[], options: {
  readonly revision?: string; readonly settingsRevision?: number; readonly paused?: boolean; readonly issuedAt?: number;
  readonly expiresAt?: number; readonly removedRuleIds?: readonly string[];
} = {}): RuleBundle {
  const issuedAt = options.issuedAt ?? NOW;
  const content = { revision: options.revision ?? '1', profile: 'browser-bounded-v1' as const, rules: options.paused ? [] : [...rules],
    paused: options.paused ?? false, settingsRevision: options.settingsRevision ?? 1, issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(options.expiresAt ?? issuedAt + 7 * DAY).toISOString(), removedRuleIds: [...(options.removedRuleIds ?? [])] };
  return { ...content, digest: automationDigest(content) };
}

/** Facts for a bookmark about to be created under `parent` (the shape sw/automation builds before a save). */
export function intakeFacts(url: string, parent?: FolderRef, extra: Partial<EventFacts['bookmark']> = {}): EventFacts {
  const parsed = new URL(url);
  return { eventId: 'local-event', operationId: 'local-operation', type: 'node.created', collectionId: COLLECTION_ID, nodeId: 'local-node',
    commitOrdinal: '0', occurredAt: new Date(NOW).toISOString(), origin: 'sync', changedFields: ['create'], hopCount: 0,
    bookmark: { kind: 'bookmark', title: 'A paper', tags: [], url: { host: parsed.hostname, path: parsed.pathname },
      ...(parent ? { parent, ancestors: [parent] } : {}), ...extra } };
}

/** A rule as `GET /api/v1/me/automations/rules` lists it. */
export function serverRule(input: { readonly id?: string; readonly name?: string; readonly state?: Rule['effectiveState']; readonly usage?: Rule['usage'] } = {}): Rule {
  return { id: input.id ?? 'rule-arxiv', revision: '1', desiredState: 'enabled', effectiveState: input.state ?? 'active',
    definition: { ...structuredClone(M1_RULE), ...(input.name ? { name: input.name } : {}) }, bindingSetId: 'bindings-1',
    createdAt: new Date(NOW - DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(), ...(input.usage ? { usage: input.usage } : {}) };
}

/** A run as `GET /api/v1/me/automations/runs` lists it. */
export function serverRun(input: Partial<Pick<Run, 'id' | 'ruleId' | 'status' | 'kind' | 'held' | 'explanation' | 'unread' | 'outputCount'>> & { readonly at?: number } = {}): Run {
  const at = new Date(input.at ?? NOW).toISOString();
  return { id: input.id ?? 'run-1', revision: '1', ruleId: input.ruleId ?? 'rule-arxiv', ruleRevision: '1', bindingRevision: '1',
    executionPolicyRevision: null, status: input.status ?? 'completed', memberEventIds: ['event-1'], recipientTargetIds: [], createdAt: at, updatedAt: at,
    jobIds: [], causationRoot: 'event-1', kind: input.kind ?? 'intake', effects: [], unread: input.unread ?? false, outputCount: input.outputCount ?? 0,
    ...(input.held === undefined ? {} : { held: input.held }), ...(input.explanation ? { explanation: input.explanation } : {}) };
}
