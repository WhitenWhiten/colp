export interface PlanUndoFacts {
  currentOwner: boolean; versionLinked: boolean; operationTypes: readonly string[];
  effectUnitMatches: boolean; contentMatches: boolean; resourceMatches: boolean; originalFolderAvailable: boolean; reverted: boolean; fieldRestorable?: boolean;
}
/** A tree snapshot is not metadata Undo; field effects require their own stored compensation. */
export function planUndoAvailability(facts: PlanUndoFacts): { undoAvailable: boolean; undoReason: string } {
  if (facts.reverted) return { undoAvailable: false,undoReason: 'This effect has already been reverted.' };
  if (!facts.currentOwner) return { undoAvailable: false,undoReason: 'Current collection Owner authority is unavailable.' };
  if (!facts.versionLinked) return { undoAvailable: false,undoReason: 'The committed plan has no verified version linkage.' };
  const move = facts.operationTypes[0] === 'move_node';
  if (facts.operationTypes.length !== 1 || !facts.effectUnitMatches || (!move && !facts.fieldRestorable))
    return { undoAvailable: false,undoReason: 'This effect has no complete stored compensation; its tree snapshot alone cannot restore it.' };
  if (!facts.contentMatches || !facts.resourceMatches || move && !facts.originalFolderAvailable)
    return { undoAvailable: false,undoReason: 'Later edits or unavailable original placement prevent conservative Undo.' };
  return { undoAvailable: true,undoReason: 'This isolated effect has a stored compensation under current content and resource fences.' };
}
