import { SyncFailureError, type SyncFailureCode, type SyncFailureSubject } from './sync-failure-class.js';

/** Only thrown by checks that precede any native call for this intent. */
export class SnapshotItemPreconditionError extends SyncFailureError {
  constructor(code: SyncFailureCode, subject: SyncFailureSubject) { super(code, subject); }
}
