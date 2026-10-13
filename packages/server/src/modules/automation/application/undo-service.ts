export interface PlanUndoFacts {
  currentOwner: boolean; versionLinked: boolean; operationTypes: readonly string[];
  effectUnitMatches: boolean; contentMatches: boolean; resourceMatches: boolean; originalFolderAvailable: boolean; reverted: boolean;
}
/** Existing tree versions do not contain tags or annotations. Never offer fictitious field restore. */
export function planUndoAvailability(facts: PlanUndoFacts): { undoAvailable: boolean; undoReason: string } {
  if (facts.reverted) return { undoAvailable: false,undoReason: 'This effect has already been reverted.' };
  if (!facts.currentOwner) return { undoAvailable: false,undoReason: 'Current collection Owner authority is unavailable.' };
  if (!facts.versionLinked) return { undoAvailable: false,undoReason: 'The committed plan has no verified version linkage.' };
  if (facts.operationTypes.length !== 1 || facts.operationTypes[0] !== 'move_node' || !facts.effectUnitMatches)
    return { undoAvailable: false,undoReason: 'The existing tree snapshot cannot isolate this effect. Tags, notes and grouped plans have no safe single-effect Undo.' };
  if (!facts.contentMatches || !facts.resourceMatches || !facts.originalFolderAvailable)
    return { undoAvailable: false,undoReason: 'Later edits or unavailable original placement prevent conservative Undo.' };
  return { undoAvailable: true,undoReason: 'One isolated move can be compensated to its verified original folder under current content fences.' };
}
