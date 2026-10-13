export interface ServerIntakeFence {
  intakeDisposition?: string; origin: string; action: string; defaultRoot: boolean; currentRevision: string | null; sourceRevision: string | null;
  sourceParent: string | null; currentParent: string | null; bindingAvailable: boolean;
}
/** These checks authorize only intake placement; they never authorize a model or a new user preference. */
export function serverIntakeBlock(fence: ServerIntakeFence): string | null {
  if (!['web','mcp','sync'].includes(fence.origin) || fence.action !== 'create') return 'Only canonical user creates are eligible; imports use run-once preview.';
  if (fence.intakeDisposition !== 'userDefault') return 'Default placement intent was not proven; preserve the Owner’s location.';
  if (!fence.defaultRoot) return 'An explicit folder is the Owner’s choice.';
  if (!fence.bindingAvailable) return 'Current destination authority or subtree membership is unavailable.';
  if (!fence.currentRevision || fence.currentRevision !== fence.sourceRevision || fence.currentParent !== fence.sourceParent)
    return 'A newer canonical edit or manual move prevents stale intake placement.';
  return null;
}
