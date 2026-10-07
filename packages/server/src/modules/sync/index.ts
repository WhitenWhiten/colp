export * from './replica-facts.js';
export * from './replica-lifecycle.js';
export * from './sync-session.js';
export * from './sync-route-authority.js';
export * from './sync-session-http.js';
export * from './sync-bootstrap-snapshot.js';
export * from './sync-snapshot-parent-first.js';
export * from './sync-sequence.js';
export * from './sync-push.js';
export * from './sync-node-create.js';
export * from './sync-node-update.js';
export * from './sync-operation-effects.js';
export * from './sync-node-move.js';
export * from './sync-node-delete.js';
export * from './sync-node-restore.js';
export * from './sync-mount-roles.js';
export * from './sync-conflict-resolution.js';
export * from './application/sync-pull.js';
export * from './application/sync-ack.js';
export * from './domain/sync-recovery-capability.js';
export * from './sync-retire.js';
export * from './product-sync-center.js';
export * from './product-sync-trash.js';
export * from './sync-profile-claim-gate.js';
export * from './application/sync-evidence-maintenance.js';
// FIX-L-033 (SYNC-R17): the Sync domain defines the minimal
// AttachmentExposurePolicyPort (allow/deny attachment projection only, see
// ./sync-bootstrap-snapshot.js) and never imports the attachments module; the
// composition adapter maps the attachments exposure-eligibility gate onto it.
