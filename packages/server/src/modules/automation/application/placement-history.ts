/** Conservative authority used both by the explanation read side and compensation. */
export interface PlacementUndoFacts {
  originalDestinationKnown: boolean;
  originalDestinationAvailable: boolean;
  currentOwner: boolean;
  currentResourceMatches: boolean;
  currentContentMatches: boolean;
  alreadyReverted: boolean;
}
export function placementUndoAvailability(facts: PlacementUndoFacts): { undoAvailable: boolean; undoReason: string } {
  if (facts.alreadyReverted) return { undoAvailable: false, undoReason: 'This placement has already been reverted.' };
  if (!facts.originalDestinationKnown) return { undoAvailable: false, undoReason: 'Placement verified; the canonical original destination was not observed.' };
  if (!facts.currentOwner) return { undoAvailable: false, undoReason: 'Current Owner authority is unavailable.' };
  if (!facts.originalDestinationAvailable) return { undoAvailable: false, undoReason: 'The original folder is unavailable.' };
  if (!facts.currentResourceMatches || !facts.currentContentMatches)
    return { undoAvailable: false, undoReason: 'A newer canonical change prevents safe Undo.' };
  return { undoAvailable: true, undoReason: 'Undo moves only this bookmark back to its verified original folder.' };
}
