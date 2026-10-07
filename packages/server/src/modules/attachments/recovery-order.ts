/**
 * P4A-P10 fixed recovery order (plan §9 P10 item 1/7).
 *
 * After a combined attachments outage (R2 / PostgreSQL / Redis / API /
 * Worker / isolated origin), dependencies are restored in a FIXED order:
 * secret/control -> PostgreSQL -> R2 reconcile -> Redis limiter -> Worker ->
 * isolated origin -> admission. Admission is the LAST step: the durable
 * admission switch only resumes once every dependency has been verified, so
 * traffic can never be admitted onto an unverified stack.
 *
 * The sequence is a sealed production contract: the ops runbook, the
 * recovery rehearsal suites and the evidence bundle all pin this module, so
 * a reordered recovery can never pass a rehearsal.
 */
export const ATTACHMENTS_RECOVERY_STEPS = Object.freeze([
  'secret_control',
  'postgres',
  'r2_reconcile',
  'redis_limiter',
  'worker',
  'isolated_origin',
  'admission',
] as const);
export type AttachmentsRecoveryStep = typeof ATTACHMENTS_RECOVERY_STEPS[number];

/**
 * Validates a recovery step sequence against the sealed order. Only the
 * EXACT fixed sequence passes; reordered, missing, duplicated, unknown or
 * truncated sequences fail closed (an operator must never "resume admission"
 * early or skip a dependency verification).
 */
export function assertAttachmentsRecoveryOrder(steps: readonly string[]): void {
  if (steps.length !== ATTACHMENTS_RECOVERY_STEPS.length) {
    throw new Error(`attachments_recovery_order_invalid:expected_${ATTACHMENTS_RECOVERY_STEPS.length}_steps`);
  }
  for (let index = 0; index < ATTACHMENTS_RECOVERY_STEPS.length; index += 1) {
    if (steps[index] !== ATTACHMENTS_RECOVERY_STEPS[index]) {
      throw new Error(
        `attachments_recovery_order_invalid:step_${index}_expected_${ATTACHMENTS_RECOVERY_STEPS[index]}`,
      );
    }
  }
}
