/**
 * P4A-I15 credential rotation helper for the attachment RW/RO/control
 * credentials.
 *
 * The helper:
 *  (a) resolves the NEW secret reference (and the CURRENT one for the probe);
 *  (b) constructs a NEW store bound to the new credential via the injected
 *      `AttachmentCredentialStoreBuilder`;
 *  (c) verifies the NEW credential WORKS against that store and that the OLD
 *      credential is REJECTED by it (the rotated store no longer contains the
 *      old value — keeping the old credential so rotation "appears" to work is
 *      reported as `old_credential_still_accepted` and NEVER passes);
 *  (d) returns a rotation plan/result with NO secret material (only role,
 *      references, fixed probe details, step statuses).
 *
 * Provider retryable / 5xx / timeout / unknown probe outcomes are classified
 * `probe_inconclusive` (environment) and never pass. `verifyOldCredentialRejected`
 * is the post-revocation check the runbook runs against the live store.
 */
export type AttachmentCredentialRole = 'rw' | 'ro' | 'control';

export type AttachmentCredentialValue =
  | Readonly<{ kind: 's3'; accessKeyId: string; secretAccessKey: string }>
  | Readonly<{ kind: 'bearer'; token: string }>;

export type AttachmentCredentialProbeDetail =
  | 'ok'
  | 'denied'
  | 'not_found'
  | 'provider_retryable'
  | 'provider_5xx'
  | 'timeout'
  | 'unknown';

export interface AttachmentCredentialProbe {
  probe(
    role: AttachmentCredentialRole,
    credential: AttachmentCredentialValue,
  ): Promise<{ readonly ok: boolean; readonly detail: AttachmentCredentialProbeDetail }>;
}

export interface AttachmentSecretResolver {
  /** Resolve the CURRENT secret VALUE for a reference (memory only). */
  resolve(ref: string): Promise<AttachmentCredentialValue>;
}

export interface AttachmentCredentialStoreBuilder {
  /** Build a credential store bound to a single credential value for a role. */
  build(role: AttachmentCredentialRole, credential: AttachmentCredentialValue): AttachmentCredentialProbe;
}

export interface AttachmentRotationTarget {
  readonly role: AttachmentCredentialRole;
  readonly currentSecretRef: string;
  readonly newSecretRef: string;
}

export type AttachmentRotationStepName = 'activate_new' | 'revoke_old' | 'verify_old_rejected';

export interface AttachmentRotationStepStatus {
  readonly step: AttachmentRotationStepName;
  readonly status: 'verified' | 'pending' | 'failed';
  readonly detail: AttachmentCredentialProbeDetail | 'not_applied' | 'scheduled';
}

export type AttachmentRotationVerdict =
  | 'rotation_verified'
  | 'new_credential_rejected'
  | 'old_credential_still_accepted'
  | 'probe_inconclusive';

export interface AttachmentRotationResult {
  readonly role: AttachmentCredentialRole;
  readonly currentSecretRef: string;
  readonly newSecretRef: string;
  readonly newWorks: boolean;
  readonly newDetail: AttachmentCredentialProbeDetail;
  readonly oldRejected: boolean;
  readonly oldDetail: AttachmentCredentialProbeDetail;
  readonly verdict: AttachmentRotationVerdict;
  readonly steps: ReadonlyArray<AttachmentRotationStepStatus>;
}

export type AttachmentRotationLogEntry = Readonly<{
  readonly class:
    | 'rotation_planned'
    | 'rotation_verified'
    | 'rotation_new_rejected'
    | 'rotation_old_accepted'
    | 'rotation_inconclusive';
  readonly role: AttachmentCredentialRole;
  readonly detail: string;
}>;

function detailIsInconclusive(detail: AttachmentCredentialProbeDetail): boolean {
  return detail === 'provider_retryable' || detail === 'provider_5xx'
    || detail === 'timeout' || detail === 'unknown';
}

export async function rotateAttachmentCredentials(input: {
  readonly target: AttachmentRotationTarget;
  readonly resolver: AttachmentSecretResolver;
  readonly storeBuilder: AttachmentCredentialStoreBuilder;
  readonly now?: () => Date;
  readonly log?: (entry: AttachmentRotationLogEntry) => void;
}): Promise<AttachmentRotationResult> {
  const { target, resolver, storeBuilder } = input;
  const log = input.log ?? (() => {});
  log({ class: 'rotation_planned', role: target.role, detail: 'resolved_new_and_current' });

  const newCredential = await resolver.resolve(target.newSecretRef);
  const oldCredential = await resolver.resolve(target.currentSecretRef);

  // (b) Construct a NEW store with the NEW credentials and probe both values
  // through it: the new credential must work, the old credential must be
  // rejected by the rotated store.
  const newStore = storeBuilder.build(target.role, newCredential);
  const newProbe = await newStore.probe(target.role, newCredential);
  const oldProbe = await newStore.probe(target.role, oldCredential);

  const newWorks = newProbe.ok;
  const oldRejected = !oldProbe.ok;

  let verdict: AttachmentRotationVerdict;
  if (detailIsInconclusive(newProbe.detail)) {
    verdict = 'probe_inconclusive';
  } else if (!newWorks) {
    verdict = 'new_credential_rejected';
  } else if (detailIsInconclusive(oldProbe.detail)) {
    verdict = 'probe_inconclusive';
  } else if (!oldRejected) {
    verdict = 'old_credential_still_accepted';
  } else {
    verdict = 'rotation_verified';
  }

  const steps: AttachmentRotationStepStatus[] = [
    { step: 'activate_new', status: newWorks ? 'verified' : 'failed', detail: newProbe.detail },
    {
      step: 'revoke_old',
      status: newWorks && oldRejected ? 'verified' : 'pending',
      detail: oldRejected ? 'not_applied' : 'scheduled',
    },
    { step: 'verify_old_rejected', status: oldRejected ? 'verified' : 'failed', detail: oldProbe.detail },
  ];

  const result: AttachmentRotationResult = {
    role: target.role,
    currentSecretRef: target.currentSecretRef,
    newSecretRef: target.newSecretRef,
    newWorks,
    newDetail: newProbe.detail,
    oldRejected,
    oldDetail: oldProbe.detail,
    verdict,
    steps,
  };

  if (verdict === 'rotation_verified') {
    log({ class: 'rotation_verified', role: target.role, detail: 'new_works_old_rejected' });
  } else if (verdict === 'new_credential_rejected') {
    log({ class: 'rotation_new_rejected', role: target.role, detail: newProbe.detail });
  } else if (verdict === 'old_credential_still_accepted') {
    log({ class: 'rotation_old_accepted', role: target.role, detail: 'old_credential_still_accepted' });
  } else {
    log({ class: 'rotation_inconclusive', role: target.role, detail: 'probe_inconclusive' });
  }
  return result;
}

/** Post-revocation check: the OLD credential must be rejected by the live store. */
export async function verifyOldCredentialRejected(input: {
  readonly role: AttachmentCredentialRole;
  readonly oldSecretRef: string;
  readonly resolver: AttachmentSecretResolver;
  readonly probe: AttachmentCredentialProbe;
}): Promise<{
  readonly role: AttachmentCredentialRole;
  readonly oldRejected: boolean;
  readonly detail: AttachmentCredentialProbeDetail;
}> {
  const oldCredential = await input.resolver.resolve(input.oldSecretRef);
  const outcome = await input.probe.probe(input.role, oldCredential);
  return { role: input.role, oldRejected: !outcome.ok, detail: outcome.detail };
}
