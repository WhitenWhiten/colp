import {
  isOrganizePlanExpired,
  OrganizePlanInputError,
  toOrganizePlanDto,
  type OrganizePlanDto,
  type OrganizePlanReadPort,
} from './create-collection-organize-plan.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface GetCollectionOrganizePlanInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly collectionId: string;
  readonly planId: string;
}

export async function getCollectionOrganizePlan(
  reads: OrganizePlanReadPort,
  input: GetCollectionOrganizePlanInput,
  clock: { now(): Date | Promise<Date> } = { now: () => new Date() },
): Promise<OrganizePlanDto | null> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new OrganizePlanInputError('The organize-plan actor is invalid.');
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)) return null;
  if (typeof input.planId !== 'string' || !OPAQUE_ID.test(input.planId)) return null;
  const row = await reads.getById(input.actor.principalId, input.collectionId, input.planId);
  if (!row) return null;
  const now = await Promise.resolve(clock.now());
  if (isOrganizePlanExpired(row, now)) return null;
  return toOrganizePlanDto(row);
}
