import { decodeProtectedHeader, type JWTPayload } from 'jose';

export interface McpMachineOauthBinding {
  readonly kids: ReadonlySet<string>;
  readonly bind: (input: {
    readonly kid: string;
    readonly payload: JWTPayload;
    readonly issuer: string;
    readonly resourceAudience: string;
    readonly securityEpoch: string;
  }) => Promise<string | null>;
}

export type MachineOauthBindResult =
  | { readonly kind: 'default' }
  | { readonly kind: 'bound'; readonly credentialBindingId: string }
  | { readonly kind: 'disallowed_algorithm' }
  | { readonly kind: 'invalid_token' };

export async function resolveMachineOauthBinding(input: {
  readonly token: string;
  readonly payload: JWTPayload;
  readonly issuer: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
  readonly machine?: McpMachineOauthBinding;
}): Promise<MachineOauthBindResult> {
  const machine = input.machine;
  if (!machine || machine.kids.size === 0) return { kind: 'default' };
  const header = decodeProtectedHeader(input.token);
  if (typeof header.kid !== 'string' || !machine.kids.has(header.kid)) return { kind: 'default' };
  if (header.alg !== 'ES256') return { kind: 'disallowed_algorithm' };
  try {
    const bound = await machine.bind({
      kid: header.kid,
      payload: input.payload,
      issuer: input.issuer,
      resourceAudience: input.resourceAudience,
      securityEpoch: input.securityEpoch,
    });
    if (bound === null) return { kind: 'invalid_token' };
    return { kind: 'bound', credentialBindingId: bound };
  } catch {
    return { kind: 'invalid_token' };
  }
}
