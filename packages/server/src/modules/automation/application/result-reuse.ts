export interface ReuseIdentity { ownerId: string; inputDigest: string; contractId: string; authorityDigest: string }
export interface AcceptedResultIdentity extends ReuseIdentity { status: 'proposed' | 'accepted' | 'rejected' }
/** Current authority must be checked by the caller; stored pins never grant future access. */
export function compatibleAcceptedResult(current: ReuseIdentity, candidate: AcceptedResultIdentity): boolean {
  return candidate.status === 'accepted' && current.ownerId === candidate.ownerId && current.inputDigest === candidate.inputDigest
    && current.contractId === candidate.contractId && current.authorityDigest === candidate.authorityDigest;
}
