/**
 * Account MCP security boundary.
 *
 * Built-in tokens are judged by `known_account_epoch` equality. Issuers that
 * do not send that claim use `iat < floor(security_epoch_bumped_at)` with no
 * JWT skew. The same second is not revoked; this does not order milliseconds.
 * A missing row, an inactive account, or a failed read is revoked.
 */
export interface McpAccountSecurityBoundary {
  readonly status: string;
  readonly securityEpoch: string;
  readonly bumpedAt: Date | null;
}

export type McpAccountSecurityBoundaryReader = (
  accountId: string,
) => Promise<McpAccountSecurityBoundary | null>;

const CANONICAL_EPOCH = /^(?:0|[1-9][0-9]{0,18})$/u;

export function isMcpAccountSecurityBoundaryRevoked(input: {
  readonly boundary: McpAccountSecurityBoundary | null;
  readonly issuedAtSeconds: number;
  readonly knownAccountEpoch: string | undefined;
}): boolean {
  const boundary = input.boundary;
  if (boundary === null || boundary.status !== 'active') return true;
  if (input.knownAccountEpoch !== undefined) {
    return !epochClaimMatches(boundary.securityEpoch, input.knownAccountEpoch);
  }
  if (!Number.isSafeInteger(input.issuedAtSeconds)) return true;
  const bumpedAt = boundary.bumpedAt;
  if (bumpedAt === null) {
    try {
      return BigInt(boundary.securityEpoch) !== 0n;
    } catch {
      return true;
    }
  }
  if (!(bumpedAt instanceof Date) || Number.isNaN(bumpedAt.getTime())) return true;
  return input.issuedAtSeconds < Math.floor(bumpedAt.getTime() / 1_000);
}

export async function mcpAccountSecurityBoundaryVerdict(input: {
  readonly requireAccountEpoch: boolean;
  readonly readAccountSecurityBoundary?: McpAccountSecurityBoundaryReader;
  readonly account: { readonly id: string; readonly securityEpoch?: string };
  readonly knownAccountEpoch: unknown;
  readonly issuedAtSeconds: number;
}): Promise<'ok' | 'revoked'> {
  if (input.requireAccountEpoch && (
    typeof input.account.securityEpoch !== 'string'
    || typeof input.knownAccountEpoch !== 'string'
    || input.knownAccountEpoch !== input.account.securityEpoch
  )) {
    return 'revoked';
  }
  const read = input.readAccountSecurityBoundary;
  if (read === undefined) return 'ok';
  try {
    const boundary = await read(input.account.id);
    const knownAccountEpoch = typeof input.knownAccountEpoch === 'string'
      ? input.knownAccountEpoch
      : undefined;
    return isMcpAccountSecurityBoundaryRevoked({
      boundary,
      issuedAtSeconds: input.issuedAtSeconds,
      knownAccountEpoch,
    }) ? 'revoked' : 'ok';
  } catch {
    return 'revoked';
  }
}

function epochClaimMatches(stored: string, claim: string): boolean {
  if (!CANONICAL_EPOCH.test(claim)) return false;
  try {
    return BigInt(stored) === BigInt(claim);
  } catch {
    return false;
  }
}
