/**
 * COLP-MCP-10: compile-time proof that the Read application client never
 * receives a token store handle and that the gateway port owns transport +
 * OAuth composition.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves the compile-time contract.
 */
import type {
  McpReadClientGatewayPort,
  McpReadClientOptions,
} from '../../src/mcp/read-client.js';
import type {
  OAuthClientCredentialVaultPort,
  OAuthClientTokenStorePort,
} from '../../src/security/index.js';

// The gateway port exposes only `callTool`; a token store handle is not part
// of the port surface and cannot be assigned to it.
const gateway: McpReadClientGatewayPort = { callTool: async () => undefined };

// @ts-expect-error McpReadClientGatewayPort has no tokenStore member
gateway.tokenStore;

// @ts-expect-error McpReadClientGatewayPort has no tokens member
gateway.tokens;

declare const options: McpReadClientOptions;

// @ts-expect-error McpReadClientOptions has no tokenStore member
options.tokenStore;

// @ts-expect-error McpReadClientOptions has no tokens member
options.tokens;

// @ts-expect-error McpReadClientOptions has no oauthClient member
options.oauthClient;

// The host-side OAuth abstraction (vault + token store) is typed and usable by
// the gateway owner, but it is deliberately absent from the client options.
declare const vault: OAuthClientCredentialVaultPort;
declare const tokenStore: OAuthClientTokenStorePort;
export const gatewayOwnsOAuthComposition: {
  readonly vault: typeof vault;
  readonly tokenStore: typeof tokenStore;
} = { vault, tokenStore };

// @ts-expect-error the client options are not the gateway's OAuth composition
const notClientOptions: McpReadClientOptions = { ...gatewayOwnsOAuthComposition };

void gateway;
void options;
void notClientOptions;
