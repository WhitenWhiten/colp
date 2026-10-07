/**
 * P4A-P07 owner-private retirement use case (`retireAttachment`).
 *
 * Logically retires one finalized owner-private Attachment into retention
 * (plan §6 P4A-P07): in ONE canonical transaction the Attachment metadata row
 * moves `attached_private -> retired` (DB-clock retired_at), the CURRENT
 * generation moves `active -> retired` (DB-clock retired_at), the blob
 * current pointer is cleared so the retired generation becomes cleanup-
 * claimable, and the canonical Operation/Audit/Outbox rows + collection
 * ordinal commit atomically (plan §2.4 invariant 5 boundary — metadata
 * update and pointer switch in the SAME transaction; the transaction NEVER
 * calls R2 — external deletion converges asynchronously through the cleanup
 * coordinator after the retention window).
 *
 * Contract (frozen OpenAPI `retireAttachment`):
 *  - input is ONLY `{ actor, blobId, Known-Command-Id }` — no request body;
 *  - the blob must be owner-matched, current-member-authorized, and carry a
 *    committed `attached_private` Attachment with an ACTIVE current
 *    generation (the frozen `retire` allowed action). Foreign / absent /
 *    revoked / tombstoned (`deleted`) identities are concealed as the
 *    identical `not_found`; an inadmissible state is the stable 409
 *    `attachment_state_conflict`;
 *  - replays converge to `already_retired` with the ORIGINAL committed
 *    receipt (same or different Known-Command-Id — retirement is terminal);
 *    the same Known-Command-Id on a DIFFERENT blob is the permanent
 *    `idempotency_conflict` (mirrors finalize);
 *  - after a lost commit response the use case re-reads the DATABASE and
 *    `resolveAttachmentRetireUnknownOutcome` decides — it never infers
 *    rollback from the caught exception and never blindly redoes a different
 *    retirement;
 *  - the status/metadata read conceals a retired Attachment exactly like a
 *    missing blob (frozen contract); only the retire route can re-observe the
 *    terminal `already_retired` receipt.
 */
import { randomUUID } from 'node:crypto';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
} from '../access-policy/index.js';
import { classifyAttachmentsLedgerError, type PhaseBarrier } from './attachments-ledger-contract.js';
import type { AttachmentsLedgerPort } from './attachments-repository-port.js';
import {
  resolveAttachmentRetireUnknownOutcome,
  type AttachmentCanonicalMutationPort,
  type RetireAttachmentReceipt,
  type RetireAttachmentResult as CanonicalRetireResult,
} from './attachment-canonical-mutation-port.js';
import type { IntentUnitOfWork } from './issue-upload-intent.js';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface ProductRetireInput {
  /** Trusted actor; the retirement is bound to the actor's subject + principal. */
  readonly actor: ActorPrincipal;
  /** Opaque logical blob identity (the key/generation are NEVER inputs). */
  readonly blobId: string;
  /** Known-Command-Id: the idempotency binding of the retirement receipt. */
  readonly idempotencyKey: string;
}

export type ProductRetireResult =
  | { outcome: 'retired'; kind: 'retired'; receipt: RetireAttachmentReceipt }
  | { outcome: 'already_retired'; kind: 'already_retired'; receipt: RetireAttachmentReceipt }
  /** Foreign/absent/revoked/tombstoned identity — identical concealment. */
  | { outcome: 'not_found' }
  /** Stable 409 attachment_state_conflict source (never leaked verbatim). */
  | { outcome: 'state_conflict'; reason: string }
  /** Same commandId reused with a different blob binding (409 idempotency conflict). */
  | { outcome: 'idempotency_conflict' }
  /** Retryable database outcome (deadlock/serialization/lock_timeout/…). */
  | { outcome: 'retryable'; reason: string }
  /** Integrity state that must never be auto-recreated (500). */
  | { outcome: 'inconsistent'; reason: string };

// ---------------------------------------------------------------------------
// Errors / validation
// ---------------------------------------------------------------------------

export type RetireAttachmentInputErrorCode = 'idempotency_key_required';

export class RetireAttachmentInputError extends Error {
  readonly code: RetireAttachmentInputErrorCode;
  constructor(code: RetireAttachmentInputErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RetireAttachmentInputError';
    this.code = code;
  }
}

const MAX_BLOB_ID_LENGTH = 512;

/**
 * Pure validation. An invalid blobId is existence-hidden exactly like a
 * missing blob (identical concealment); a missing idempotency key is a
 * programming error (the route already enforces the canonical UUID).
 */
export function validateRetireAttachmentInput(input: ProductRetireInput):
  { readonly blobId: string; readonly idempotencyKey: string } | null {
  const blobId = input.blobId.trim();
  if (blobId.length === 0 || blobId.length > MAX_BLOB_ID_LENGTH) return null;
  // Printable ASCII only: opaque identity, no whitespace/control characters.
  if (/[^\x21-\x7e]/u.test(blobId)) return null;
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) throw new RetireAttachmentInputError('idempotency_key_required');
  return { blobId, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Authorization: current membership gate layered on the immutable owner
// binding (same vocabulary as the status read and the finalize policy).
// ---------------------------------------------------------------------------

const RETIRE_CAPABILITY = 'read_editor' as const;

// ---------------------------------------------------------------------------
// Canonical outcome -> use-case result (the frozen rejection mapping)
// ---------------------------------------------------------------------------

function mapCanonicalRetireOutcome(result: CanonicalRetireResult): ProductRetireResult {
  switch (result.outcome) {
    case 'retired':
      return { outcome: 'retired', kind: 'retired', receipt: result.receipt };
    case 'already_retired':
      return { outcome: 'already_retired', kind: 'already_retired', receipt: result.receipt };
    case 'collection_not_found':
    case 'collection_deleted':
    case 'collection_owner_mismatch':
    case 'not_found':
      // Authorization / existence boundaries are concealed identically.
      return { outcome: 'not_found' };
    case 'not_retirable':
      return { outcome: 'state_conflict', reason: `not_retirable:${result.logicalState}` };
    case 'generation_mismatch':
      return { outcome: 'state_conflict', reason: 'generation_mismatch' };
    case 'binding_missing':
      return { outcome: 'inconsistent', reason: 'binding_missing' };
    case 'inconsistent':
      return { outcome: 'inconsistent', reason: result.reason };
  }
}

// ---------------------------------------------------------------------------
// Use case deps
// ---------------------------------------------------------------------------

export interface RetireAttachmentDeps<Transaction> {
  /** Transaction-bound ledger: retire facts + committed-receipt re-read. */
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** P4A-P07 Canonical Mutation port (transaction-bound; never calls R2). */
  readonly canonical: AttachmentCanonicalMutationPort<Transaction>;
  /** Binds the access-policy facts port to the caller-provided transaction. */
  readonly accessPolicyFor: (transaction: Transaction) => AccessPolicyFactsPort;
  readonly uow: IntentUnitOfWork<Transaction>;
  /**
   * Fault-free unit of work for the post-commit-unknown recovery re-read
   * (production composes the same `createUnitOfWork(db)`; the focused suite
   * separates it so a simulated lost-commit acknowledgement never poisons the
   * recovery re-read).
   */
  readonly recoveryUow?: IntentUnitOfWork<Transaction>;
  /** Deterministic test seam passed through to the canonical port options. */
  readonly barrier?: PhaseBarrier;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Retires one owner-private Attachment in a single canonical transaction.
 * All rejections return before any write; any failure after a write rolls the
 * whole set back; a lost commit response is recovered by re-reading the
 * database (never inferred from the caught exception).
 */
export async function retireAttachment<Transaction>(
  deps: RetireAttachmentDeps<Transaction>,
  input: ProductRetireInput,
): Promise<ProductRetireResult> {
  const validated = validateRetireAttachmentInput(input);
  if (validated === null) return { outcome: 'not_found' };
  // The attempted attachment id is resolved inside the transaction (the
  // committed binding) and captured for the commit-unknown recovery re-read.
  let attemptedAttachmentId: string | null = null;

  try {
    return await deps.uow.execute(async ({ transaction }) => {
      // 1. Resolve the current blob/generation/attachment facts.
      const factsResult = await deps.ledger.findBlobForRetire(transaction, { blobId: validated.blobId });
      if (factsResult.outcome === 'not_found') return { outcome: 'not_found' as const };
      const facts = factsResult.facts;

      // 2. Concealment gate (no existence side channel): foreign owner,
      //    tombstoned metadata, and missing Collection are identical 404s.
      if (facts.ownerSubjectId !== input.actor.subjectId) return { outcome: 'not_found' as const };
      if (facts.attachment?.logicalState === 'deleted') return { outcome: 'not_found' as const };
      if (facts.collectionId === null) return { outcome: 'not_found' as const };

      // 3. Current membership authorization (re-read on EVERY retire).
      const decision = await authorizeCapability(deps.accessPolicyFor(transaction), {
        collectionId: facts.collectionId,
        actor: input.actor,
        capability: RETIRE_CAPABILITY,
      });
      if (decision.outcome !== 'allow') return { outcome: 'not_found' as const };

      // 4. Terminal replay: an already-retired Attachment returns the
      //    ORIGINAL committed receipt (retirement is terminal; the status
      //    read conceals it, only the retire command re-observes it).
      if (facts.attachment?.logicalState === 'retired') {
        const recovery = await deps.canonical.readAttachmentRetireRecoveryFacts(transaction, validated.blobId);
        if (recovery.outcome === 'not_found' || recovery.facts.attachment === null
          || recovery.facts.attachment.logicalState !== 'retired' || recovery.facts.operation === null) {
          return { outcome: 'inconsistent' as const, reason: 'retired_without_operation' };
        }
        return {
          outcome: 'already_retired' as const,
          kind: 'already_retired' as const,
          receipt: {
            attachmentId: recovery.facts.attachment.attachmentId,
            blobId: recovery.facts.attachment.blobId,
            operationId: recovery.facts.operation.operationId,
            collectionId: recovery.facts.attachment.collectionId,
            commitOrdinal: recovery.facts.operation.commitOrdinal,
            logicalState: 'retired' as const,
          },
        };
      }

      // 5. Idempotency receipt: the committed retire Operation for this
      //    command id (persisted in the canonical Operation payload). A
      //    committed receipt on the SAME blob is the original receipt; the
      //    same command id on a DIFFERENT blob is an idempotency conflict.
      const committed = await deps.ledger.findRetireByCommandId(transaction, { commandId: validated.idempotencyKey });
      if (committed.outcome === 'found') {
        if (committed.facts.blobId !== validated.blobId) {
          return { outcome: 'idempotency_conflict' as const };
        }
        return {
          outcome: 'already_retired' as const,
          kind: 'already_retired' as const,
          receipt: {
            attachmentId: committed.facts.attachmentId,
            blobId: committed.facts.blobId,
            operationId: committed.facts.operationId,
            collectionId: committed.facts.collectionId,
            commitOrdinal: committed.facts.commitOrdinal,
            logicalState: 'retired' as const,
          },
        };
      }

      // 6. Retirable state: a committed attached_private Attachment with an
      //    ACTIVE current generation (the canonical assembly re-verifies
      //    every fact under row locks).
      if (facts.attachment === null) {
        return { outcome: 'state_conflict' as const, reason: 'attachment_not_finalized' };
      }
      if (facts.logicalState !== 'attached_private') {
        return { outcome: 'state_conflict' as const, reason: `logical_state_${facts.logicalState}` };
      }
      if (facts.currentGenerationId === null || facts.currentGenerationState !== 'active') {
        return { outcome: 'state_conflict' as const, reason: 'generation_not_active' };
      }

      // 7. The canonical retirement: Attachment metadata -> retired +
      //    generation -> retired + pointer clear + Operation/Audit/Outbox +
      //    ordinal, all in THIS transaction (never an R2 call).
      attemptedAttachmentId = facts.attachment.attachmentId;
      const result = await deps.canonical.retireAttachment(transaction, {
        blobId: validated.blobId,
        attachmentId: facts.attachment.attachmentId,
        operationId: randomUUID(),
        collectionId: facts.collectionId,
        ownerSubjectId: input.actor.subjectId,
        expectedGenerationId: facts.currentGenerationId,
        actorPrincipalId: input.actor.principalId,
        commandId: validated.idempotencyKey,
      }, { barrier: deps.barrier });
      return mapCanonicalRetireOutcome(result);
    });
  } catch (error) {
    const classified = classifyAttachmentsLedgerError(error);
    if (classified.class === 'unknown_outcome') {
      return recoverRetireCommitUnknown(deps, validated.blobId, attemptedAttachmentId);
    }
    if (classified.class === 'retryable') {
      return { outcome: 'retryable', reason: classified.code ?? 'database_retryable' };
    }
    if (classified.class === 'identity_failure') {
      return { outcome: 'inconsistent', reason: `identity_${classified.code ?? 'unknown'}` };
    }
    throw error;
  }
}

/**
 * Commit-unknown recovery: after a lost commit response the caller re-reads
 * the DATABASE (never infers rollback from the caught exception) and decides:
 *  - committed_same -> the original receipt is returned (the commit landed);
 *  - committed_different -> the attempted retirement lost a race (409);
 *  - not_committed -> the transaction rolled back; the identical request may
 *    be retried (retryable 503);
 *  - inconsistent -> manual review; recovery NEVER fabricates the metadata.
 */
async function recoverRetireCommitUnknown<Transaction>(
  deps: RetireAttachmentDeps<Transaction>,
  blobId: string,
  attemptedAttachmentId: string | null,
): Promise<ProductRetireResult> {
  const recoveryUow = deps.recoveryUow ?? deps.uow;
  const recovery = await recoveryUow.execute(({ transaction }) =>
    deps.canonical.readAttachmentRetireRecoveryFacts(transaction, blobId));
  if (recovery.outcome === 'not_found') {
    return { outcome: 'inconsistent', reason: 'blob_not_found_after_commit_attempt' };
  }
  const decision = resolveAttachmentRetireUnknownOutcome({
    attemptedAttachmentId: attemptedAttachmentId
      ?? recovery.facts.attachmentBindingId
      ?? (recovery.facts.attachment?.attachmentId ?? ''),
    reRead: recovery.facts,
  });
  switch (decision.decision) {
    case 'committed_same':
      return { outcome: 'retired', kind: 'retired', receipt: decision.receipt };
    case 'committed_different':
      return { outcome: 'state_conflict', reason: 'binding_conflict' };
    case 'not_committed':
      return { outcome: 'retryable', reason: 'commit_outcome_not_committed' };
    case 'inconsistent':
      return { outcome: 'inconsistent', reason: decision.reason };
  }
}
