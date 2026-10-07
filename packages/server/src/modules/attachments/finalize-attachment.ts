/**
 * P4A-P06 owner-private Product finalize use case.
 *
 * Runs the ENTIRE finalize in ONE caller-provided transaction over the P02
 * Canonical Mutation port: Collection lock + authorization, intent-Collection
 * binding, I13 blob handoff, Attachment metadata, resource ID ledger,
 * Operation/Audit/Outbox and the idempotency receipt (plan §6 P4A-P06,
 * §2.4 invariant 5). The transaction NEVER calls R2, and the future-finalize
 * handoff always uses the CALLER's transaction (the canonical port is
 * transaction-bound by contract).
 *
 * Input is only `{ actor, blobId, Known-Command-Id }` — the finalize has no
 * request body, so every generation/verified fact is resolved from the
 * committed ledger inside the same transaction and re-verified by the
 * canonical handoff under row locks. The physical key, digest and filename
 * never enter the use case or any row it writes.
 *
 * Idempotency (Known-Command-Id):
 *  - the Attachment identity is DERIVED deterministically from
 *    (principalId, blobId, commandId), so a replay of the identical request
 *    converges to the SAME binding and the canonical mutation returns
 *    `already_finalized` with the ORIGINAL committed receipt (plan §4.2.9:
 *    replaying the same idempotency key returns the original receipt = success);
 *  - the commandId is persisted in the canonical Operation payload, so after
 *    response loss / API restart the committed receipt is re-read from the
 *    database and replayed — never inferred from the client exception;
 *  - the same commandId on a DIFFERENT blob is `idempotency_conflict`; a
 *    different commandId on the same blob is a permanent `binding_conflict`
 *    (409 attachment_state_conflict) — only a different binding conflicts;
 *  - after a lost commit response the use case re-reads the recovery facts
 *    and `resolveAttachmentFinalizeUnknownOutcome` decides — it never infers
 *    rollback from the caught exception and never blindly redoes a different
 *    Attachment.
 *
 * Authorization: the actor must be the blob's committed owner binding AND a
 * current live Collection member (`read_editor` capability re-read from
 * PostgreSQL on EVERY finalize — no cached authorization). Every foreign /
 * absent / revoked / terminal identity is concealed as the identical
 * `not_found` (404 concealment, plan §2.4 invariant 6).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
} from '../access-policy/index.js';
import {
  classifyAttachmentsLedgerError,
  type PhaseBarrier,
} from './attachments-ledger-contract.js';
import type {
  AttachmentsLedgerPort,
} from './attachments-repository-port.js';
import {
  resolveAttachmentFinalizeUnknownOutcome,
  type AttachmentCanonicalMutationPort,
  type FinalizeAttachmentReceipt,
  type FinalizeAttachmentResult as CanonicalFinalizeResult,
} from './attachment-canonical-mutation-port.js';
import type { IntentUnitOfWork } from './issue-upload-intent.js';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface ProductFinalizeInput {
  /** Trusted actor; the finalize is bound to the actor's subject + principal. */
  readonly actor: ActorPrincipal;
  /** Opaque logical blob identity (the key/generation are NEVER inputs). */
  readonly blobId: string;
  /** Known-Command-Id: the idempotency binding of the finalize receipt. */
  readonly idempotencyKey: string;
}

export type ProductFinalizeResult =
  | { outcome: 'finalized'; kind: 'finalized'; receipt: FinalizeAttachmentReceipt }
  | { outcome: 'already_finalized'; kind: 'already_finalized'; receipt: FinalizeAttachmentReceipt }
  /** Foreign/absent/revoked/terminal identity — identical concealment. */
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

export type FinalizeAttachmentInputErrorCode = 'idempotency_key_required';

export class FinalizeAttachmentInputError extends Error {
  readonly code: FinalizeAttachmentInputErrorCode;
  constructor(code: FinalizeAttachmentInputErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'FinalizeAttachmentInputError';
    this.code = code;
  }
}

const MAX_BLOB_ID_LENGTH = 512;

/**
 * Pure validation. An invalid blobId is existence-hidden exactly like a
 * missing blob (identical concealment); a missing idempotency key is a
 * programming error (the route already enforces the canonical UUID).
 */
export function validateFinalizeAttachmentInput(input: ProductFinalizeInput):
  { readonly blobId: string; readonly idempotencyKey: string } | null {
  const blobId = input.blobId.trim();
  if (blobId.length === 0 || blobId.length > MAX_BLOB_ID_LENGTH) return null;
  // Printable ASCII only: opaque identity, no whitespace/control characters.
  if (/[^\x21-\x7e]/u.test(blobId)) return null;
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) throw new FinalizeAttachmentInputError('idempotency_key_required');
  return { blobId, idempotencyKey };
}

/**
 * Deterministic Attachment identity for a finalize binding. The same
 * (principalId, blobId, Known-Command-Id) always derives the same id, so a
 * replay converges to the ORIGINAL committed binding (never a unique
 * violation, never a second attachment). The blobId is part of the domain so
 * the same commandId on a different blob can never silently reuse the
 * committed binding identity.
 */
export function computeFinalizeAttachmentId(
  principalId: string,
  blobId: string,
  idempotencyKey: string,
): string {
  return `att-finalize-${createHash('sha256')
    .update(`known:attachment-finalize:v1:${principalId}\u0000${blobId}\u0000${idempotencyKey}`, 'utf8')
    .digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Authorization: current membership gate layered on the immutable owner
// binding (same vocabulary as the status read and the upload-intent policy).
// ---------------------------------------------------------------------------

const FINALIZE_CAPABILITY = 'read_editor' as const;

// ---------------------------------------------------------------------------
// Canonical outcome -> use-case result (the frozen rejection mapping)
// ---------------------------------------------------------------------------

function mapCanonicalFinalizeOutcome(result: CanonicalFinalizeResult): ProductFinalizeResult {
  switch (result.outcome) {
    case 'finalized':
      return { outcome: 'finalized', kind: 'finalized', receipt: result.receipt };
    case 'already_finalized':
      return { outcome: 'already_finalized', kind: 'already_finalized', receipt: result.receipt };
    case 'binding_conflict':
      return { outcome: 'state_conflict', reason: 'binding_conflict' };
    case 'collection_not_found':
    case 'collection_deleted':
    case 'collection_owner_mismatch':
    case 'not_found':
    case 'owner_mismatch':
      // Authorization / existence boundaries are concealed identically.
      return { outcome: 'not_found' };
    case 'collection_binding_mismatch':
      return { outcome: 'state_conflict', reason: 'collection_binding_mismatch' };
    case 'not_finalizable':
      return { outcome: 'state_conflict', reason: `not_finalizable:${result.logicalState}` };
    case 'generation_mismatch':
      return { outcome: 'state_conflict', reason: 'generation_mismatch' };
    case 'etag_mismatch':
      return { outcome: 'state_conflict', reason: 'etag_mismatch' };
    case 'verified_facts_mismatch':
      return { outcome: 'state_conflict', reason: `verified_facts_mismatch:${result.code}` };
    case 'policy_mismatch':
      return { outcome: 'state_conflict', reason: 'policy_mismatch' };
    case 'expired':
      return { outcome: 'state_conflict', reason: 'expired' };
    case 'inconsistent':
      return { outcome: 'inconsistent', reason: result.reason };
  }
}

// ---------------------------------------------------------------------------
// Use case deps
// ---------------------------------------------------------------------------

export interface FinalizeAttachmentDeps<Transaction> {
  /** Transaction-bound ledger: finalize facts + committed-receipt re-read. */
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** P4A-P02 Canonical Mutation port (transaction-bound; never calls R2). */
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
 * Finalizes one owner-private Attachment in a single canonical transaction.
 * All rejections return before any write; any failure after a write rolls the
 * whole set back; a lost commit response is recovered by re-reading the
 * database (never inferred from the caught exception).
 */
export async function finalizeAttachment<Transaction>(
  deps: FinalizeAttachmentDeps<Transaction>,
  input: ProductFinalizeInput,
): Promise<ProductFinalizeResult> {
  const validated = validateFinalizeAttachmentInput(input);
  if (validated === null) return { outcome: 'not_found' };
  const attemptedAttachmentId = computeFinalizeAttachmentId(
    input.actor.principalId, validated.blobId, validated.idempotencyKey,
  );

  try {
    return await deps.uow.execute(async ({ transaction }) => {
      // 1. Resolve the current blob/generation/intent facts from the ledger.
      const factsResult = await deps.ledger.findBlobForFinalize(transaction, { blobId: validated.blobId });
      if (factsResult.outcome === 'not_found') return { outcome: 'not_found' as const };
      const facts = factsResult.facts;

      // 2. Concealment gate (no existence side channel): foreign owner,
      //    terminal metadata, and missing Collection are identical 404s.
      if (facts.ownerSubjectId !== input.actor.subjectId) return { outcome: 'not_found' as const };
      if (facts.attachmentLogicalState === 'retired' || facts.attachmentLogicalState === 'deleted') {
        return { outcome: 'not_found' as const };
      }
      if (facts.collectionId === null) return { outcome: 'not_found' as const };

      // 3. Current membership authorization (re-read on EVERY finalize).
      const decision = await authorizeCapability(deps.accessPolicyFor(transaction), {
        collectionId: facts.collectionId,
        actor: input.actor,
        capability: FINALIZE_CAPABILITY,
      });
      if (decision.outcome !== 'allow') return { outcome: 'not_found' as const };

      // 4. Idempotency receipt: the committed operation for this command id
      //    (persisted in the canonical Operation payload). A committed
      //    receipt on the SAME blob is the original receipt; the same command
      //    id on a DIFFERENT blob is an idempotency conflict.
      const committed = await deps.ledger.findFinalizeByCommandId(transaction, { commandId: validated.idempotencyKey });
      if (committed.outcome === 'found') {
        if (committed.facts.blobId !== validated.blobId) {
          return { outcome: 'idempotency_conflict' as const };
        }
        return {
          outcome: 'already_finalized' as const,
          kind: 'already_finalized' as const,
          receipt: {
            attachmentId: committed.facts.attachmentId,
            blobId: committed.facts.blobId,
            operationId: committed.facts.operationId,
            collectionId: committed.facts.collectionId,
            commitOrdinal: committed.facts.commitOrdinal,
            logicalState: 'attached_private',
          },
        };
      }

      // 5. Finalizable state: current, active, verified, unexpired
      //    stored_private generation (the canonical handoff re-verifies
      //    every fact under row locks; these cheap gates map the reachable
      //    states to the stable 409 without touching the handoff).
      if (facts.logicalState !== 'stored_private') {
        return { outcome: 'state_conflict' as const, reason: `logical_state_${facts.logicalState}` };
      }
      if (facts.currentGenerationId === null || facts.currentGenerationState !== 'active') {
        return { outcome: 'state_conflict' as const, reason: 'generation_not_active' };
      }
      if (facts.observedEtag === null || facts.verifiedSize === null || facts.verifiedSha256 === null
        || facts.mediaType === null || facts.verificationPolicyVersion === null) {
        return { outcome: 'state_conflict' as const, reason: 'verified_facts_missing' };
      }

      // 6. The canonical mutation: Collection lock + authorization + binding
      //    check + I13 handoff + metadata + ledger + Operation/Audit/Outbox
      //    + ordinal, all in THIS transaction (never an R2 call).
      const result = await deps.canonical.finalizeAttachment(transaction, {
        blobId: validated.blobId,
        attachmentId: attemptedAttachmentId,
        operationId: randomUUID(),
        collectionId: facts.collectionId,
        ownerSubjectId: input.actor.subjectId,
        sanitizedFilename: null,
        expectedGenerationId: facts.currentGenerationId,
        expectedEtag: facts.observedEtag,
        verifiedSize: facts.verifiedSize,
        verifiedSha256: facts.verifiedSha256,
        mediaType: facts.mediaType,
        policyRevision: facts.verificationPolicyVersion,
        actorPrincipalId: input.actor.principalId,
        commandId: validated.idempotencyKey,
      }, { barrier: deps.barrier });
      return mapCanonicalFinalizeOutcome(result);
    });
  } catch (error) {
    const classified = classifyAttachmentsLedgerError(error);
    if (classified.class === 'unknown_outcome') {
      return recoverCommitUnknown(deps, validated.blobId, attemptedAttachmentId);
    }
    if (classified.class === 'retryable') {
      // A real 40P01/40001/55P03 from the canonical transaction: retryable at
      // the command boundary (the P02 race suite pins the classification);
      // the route maps it to the stable 503 and the retry converges.
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
 *  - committed_different -> the attempted binding lost a race (409 conflict);
 *  - not_committed -> the transaction rolled back; the identical request may
 *    be retried (retryable 503);
 *  - inconsistent -> manual review; recovery NEVER fabricates the metadata.
 */
async function recoverCommitUnknown<Transaction>(
  deps: FinalizeAttachmentDeps<Transaction>,
  blobId: string,
  attemptedAttachmentId: string,
): Promise<ProductFinalizeResult> {
  const recoveryUow = deps.recoveryUow ?? deps.uow;
  const recovery = await recoveryUow.execute(({ transaction }) =>
    deps.canonical.readAttachmentFinalizeRecoveryFacts(transaction, blobId));
  if (recovery.outcome === 'not_found') {
    return { outcome: 'inconsistent', reason: 'blob_not_found_after_commit_attempt' };
  }
  const decision = resolveAttachmentFinalizeUnknownOutcome({
    attemptedAttachmentId,
    reRead: recovery.facts,
  });
  switch (decision.decision) {
    case 'committed_same':
      return { outcome: 'finalized', kind: 'finalized', receipt: decision.receipt };
    case 'committed_different':
      return { outcome: 'state_conflict', reason: 'binding_conflict' };
    case 'not_committed':
      return { outcome: 'retryable', reason: 'commit_outcome_not_committed' };
    case 'inconsistent':
      return { outcome: 'inconsistent', reason: decision.reason };
  }
}
