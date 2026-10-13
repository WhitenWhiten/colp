import type { FolderRef, TaskOutput } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';

/** The model never supplies canonical operation objects. */
export function assessTypedEffect(output: TaskOutput,allowedFolders: readonly FolderRef[]) {
  if (output.kind === 'placement') {
    if (output.decision === 'review') return 'review' as const;
    if (output.decision === 'keepParent') return 'none' as const;
    if (!output.destination || !allowedFolders.some(f => f.serverUuid === output.destination!.serverUuid
      && f.collectionId === output.destination!.collectionId && f.nodeId === output.destination!.nodeId))
      throw new AutomationError('automation_binding_unavailable','Placement is outside the pinned allowed subtree.');
    return 'move' as const;
  }
  if (output.kind === 'tags') return 'tags' as const;
  if (output.kind === 'text' && output.textType === 'summary') return 'note' as const;
  return 'none' as const;
}
