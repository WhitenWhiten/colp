import { mapSnapshotFolderRole as projectFolderRole, SnapshotDocumentError } from '../collections/snapshot-document.js';
import { SyncBootstrapSnapshotError } from '../../modules/sync/index.js';

export function mapSnapshotFolderRole(...args: Parameters<typeof projectFolderRole>): ReturnType<typeof projectFolderRole> {
  try { return projectFolderRole(...args); }
  catch (error) {
    if (error instanceof SnapshotDocumentError) throw new SyncBootstrapSnapshotError('internal_error', error.message);
    throw error;
  }
}
