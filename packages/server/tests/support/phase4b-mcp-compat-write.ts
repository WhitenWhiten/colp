/**
 * Shared T-06 write/OAuth helpers for `/collections/-/mcp-compat` inject tests.
 */
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  createMcpOauthVerifier,
  createPhase4bMcpRequestContext,
  type McpOauthVerifier,
} from '../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from './phase4b-mcp-read-tools-fixture.js';
import {
  createInMemoryWriteToolFixture,
  type InMemoryWriteToolFixture,
} from './phase4b-mcp-write-tools-fixture.js';
import {
  AUDIENCE,
  createKeyFixture,
  mintCredential,
  staticJwksProvider,
  verifierOptions,
} from './phase4b-mcp-transport-scaffold.js';
import {
  startCompatApp,
  type CompatAdmissionServer,
} from './phase4b-mcp-compat-admission.js';
import { COMPAT_WRITE_SCOPES } from './phase4b-mcp-compat-write-auth.js';

export {
  assertAwaitingApproval,
  assertNoMrtrOrElicitation,
  assertRejectedWrite,
  listedTool,
  listedToolNames,
} from './phase4b-mcp-compat-write-assertions.js';
export {
  COMPAT_READ_SCOPES,
  COMPAT_REVISION,
  COMPAT_WRITE_SCOPES,
  mintCompatWriteToken,
} from './phase4b-mcp-compat-write-auth.js';

export function nodeCreateArguments(title = 'T06 bookmark'): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: 'collection-1',
    parentId: 'root-1',
    node: Object.freeze({
      kind: 'bookmark',
      title,
      url: 'https://example.test/t06',
      description: null,
      tags: Object.freeze(['t06']),
      visibility: 'private',
    }),
    reason: 'create bookmark',
    confirmApply: true,
  });
}

export function planArguments(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operations: Object.freeze([{
      type: 'set_visibility',
      collectionId: 'collection-1',
      baseRevision: 'resource-r1',
      input: Object.freeze({ visibility: 'protected' }),
    }]),
    reason: 'publish this node',
    dryRun: true,
  });
}

export function commitArguments(
  planId: string,
  idempotencyKey = 'idem-t06',
): Readonly<Record<string, unknown>> {
  return Object.freeze({ planId, idempotencyKey });
}

export async function signedCompatWriteClient(
  scopes: readonly string[] = COMPAT_WRITE_SCOPES,
): Promise<{
  readonly key: Awaited<ReturnType<typeof createKeyFixture>>;
  readonly verifier: McpOauthVerifier;
  readonly token: string;
  readonly strictToken: string;
}> {
  const key = await createKeyFixture('compat-t06');
  const compatAudience = `${AUDIENCE}-compat`;
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...scopes],
    jwks: staticJwksProvider([key.jwk]),
    audience: [AUDIENCE, compatAudience],
  }));
  const shared = {
    key: key.privateKey,
    kid: key.kid,
    scope: scopes,
    jti: 't06-write-jti-1',
  };
  const token = await mintCredential({ ...shared, audience: compatAudience });
  const strictToken = await mintCredential({ ...shared, audience: AUDIENCE });
  return { key, verifier, token, strictToken };
}

export function startCompatWriteApp(input: {
  readonly writeFixture: InMemoryWriteToolFixture;
  readonly verifier: McpOauthVerifier;
}): CompatAdmissionServer {
  const readSurface = emptyReadToolAdapterBundle();
  return startCompatApp({
    writeEnabled: true,
    mcpReadTransport: {
      readToolAdapter: readSurface.adapter,
      readToolParamDeclarations: readSurface.paramDeclarations,
      oauthVerifier: input.verifier,
      writeToolAdapter: input.writeFixture.bundle.adapter,
      writeToolParamDeclarations: input.writeFixture.bundle.paramDeclarations,
    },
  });
}

export function writeApprovalContext(
  binding: McpAuthenticatedAuthorizationBinding,
  scope: readonly string[] = COMPAT_WRITE_SCOPES,
) {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'changes.plan' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({}),
        }),
        name: 'changes.plan',
      }),
    }),
    binding,
    scope,
    authorization: Object.freeze({ accountSubjectId: binding.principalId }),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

export async function verifiedWriteBinding(auth: {
  readonly verifier: McpOauthVerifier;
  readonly token: string;
}): Promise<McpAuthenticatedAuthorizationBinding> {
  const verified = await auth.verifier.verify({ authorization: `Bearer ${auth.token}` });
  return verified.binding;
}

export function createWriteFixture(): InMemoryWriteToolFixture {
  return createInMemoryWriteToolFixture();
}
