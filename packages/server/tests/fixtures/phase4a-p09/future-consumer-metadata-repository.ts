/**
 * P4A-P09 fixture: a FUTURE shared consumer reaching the P02-era owner-private
 * Attachment METADATA repository port directly.
 *
 * This is the strongest forbidden shape after productization: a consumer that
 * reads `attachments` row facts (`attachmentId` / `logicalState` /
 * `attachedAt` / retirement/deletion facts) without any exposure-eligibility
 * gate. The architecture scan must classify this as
 * `consumer_repository_import`.
 */
import type { AttachmentMetadataRepositoryPort } from '../../../src/modules/attachments/attachment-metadata-repository-port.js';

export function metadataRepositoryBypassFutureConsumer(): {
  readonly metadata: AttachmentMetadataRepositoryPort<unknown> | null;
} {
  return { metadata: null };
}
