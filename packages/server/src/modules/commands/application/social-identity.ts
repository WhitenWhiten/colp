/** Shared social/notifications identity text bound (OpenAPI ProfileStableId stays 22). */
export const SOCIAL_IDENTITY_MAX_LENGTH = 256 as const;

export function isSocialIdentityText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SOCIAL_IDENTITY_MAX_LENGTH
    && value.trim() === value;
}
