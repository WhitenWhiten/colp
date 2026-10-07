export const COLLECTION_GRANT_ACTIONS = Object.freeze([
  'collection.content.write',
  'collection.publish',
] as const);

export const REPORT_GRANT_ACTIONS = Object.freeze([
  'report.metadata.write',
  'report.issue.write',
  'report.issue.publish',
  'report.issue.withdraw',
] as const);

export const GRANT_ACTIONS = Object.freeze([
  ...COLLECTION_GRANT_ACTIONS,
  ...REPORT_GRANT_ACTIONS,
] as const);

export type CollectionGrantAction = (typeof COLLECTION_GRANT_ACTIONS)[number];
export type ReportGrantAction = (typeof REPORT_GRANT_ACTIONS)[number];
export type CredentialGrantAction = (typeof GRANT_ACTIONS)[number];
export type CredentialGrantResourceKind = 'collection' | 'report';

const ACTION_SCOPES: Readonly<Record<CredentialGrantAction, readonly string[]>> = Object.freeze({
  'collection.content.write': Object.freeze(['nodes:write']),
  'collection.publish': Object.freeze(['access:write']),
  'report.metadata.write': Object.freeze(['reports:write']),
  'report.issue.write': Object.freeze(['reports:write']),
  'report.issue.publish': Object.freeze(['reports:write', 'reports:publish']),
  'report.issue.withdraw': Object.freeze(['reports:write']),
});

export function scopesForGrantActions(actions: readonly CredentialGrantAction[]): readonly string[] {
  const scopes = new Set<string>();
  for (const action of actions) {
    const mapped = ACTION_SCOPES[action];
    if (!mapped) throw new Error(`unmapped grant action: ${action}`);
    for (const scope of mapped) scopes.add(scope);
  }
  return Object.freeze([...scopes].sort());
}

export function isCollectionGrantAction(value: string): value is CollectionGrantAction {
  return (COLLECTION_GRANT_ACTIONS as readonly string[]).includes(value);
}

export function isReportGrantAction(value: string): value is ReportGrantAction {
  return (REPORT_GRANT_ACTIONS as readonly string[]).includes(value);
}

export function grantActionsCoverScopes(
  actions: readonly CredentialGrantAction[],
  requiredScopes: readonly string[],
): boolean {
  const granted = new Set(scopesForGrantActions(actions));
  return requiredScopes.every((scope) => granted.has(scope));
}
