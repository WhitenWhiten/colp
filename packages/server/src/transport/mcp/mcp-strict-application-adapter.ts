/**
 * Strict 2026-07-28 adapter over the era-neutral MCP application facade.
 *
 * Encodes catalog list results with the existing host `createPhase4bMcpResult`
 * envelope (`resultType`, cache metadata, `_meta`). COLP read/write adapters
 * are wrapped here into protocol-neutral ports so application services never
 * synthesize wire headers or `_meta`.
 */
import {
  Mcp20260728RequestError,
  McpResourceNotFoundError,
  McpToolOutputUnavailableError,
  materializeClosedMcpToolSchema,
  resolveMcpResourceReadBudget,
  type Mcp20260728ReadToolAdapter,
  type Mcp20260728RequestContext,
  type Mcp20260728Result,
  type Mcp20260728WriteToolAdapter,
  type McpAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  canAccessPhase4bMcpReadTools,
  canCallPhase4bMcpWriteTool,
  PHASE4B_MCP_READ_TOOL_CATALOG,
  PHASE4B_MCP_READ_TOOL_NAMES,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  PHASE4B_MCP_RESOURCE_TEMPLATES_CACHE_METADATA,
  PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES,
  classifyPhase4bMcpWriteError,
  createMcpApplicationContext,
  createPhase4bMcpApplicationFacade,
  createPhase4bMcpRequestContext,
  createPhase4bMcpResult,
  isPhase4bMcpWriteErrorClass,
  toPhase4bMcpWriteRejectedResult,
  wireToolFromDescriptor,
  type McpApplicationContext,
  type McpApplicationFacade,
  type McpApplicationReadPort,
  type McpApplicationToolDescriptor,
  type McpApplicationToolResult,
  type McpApplicationWritePort,
  type Phase4bMcpApplicationFacadeOptions,
  type Phase4bMcpWriteToolName,
} from '../../modules/mcp/index.js';

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export function toMcpApplicationContextFromStrict(
  context: Mcp20260728RequestContext,
): McpApplicationContext {
  const binding = context.binding;
  const principal = binding.kind === 'anonymous'
    ? Object.freeze({
      kind: 'anonymous' as const,
      principalId: 'public' as const,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    })
    : Object.freeze({
      kind: 'authenticated' as const,
      principalId: binding.principalId,
      clientId: binding.clientId,
      credentialBindingId: binding.credentialBindingId,
      resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch,
    });
  const requestId = context.authorization.requestId;
  return createMcpApplicationContext({
    principal,
    scopes: context.scope,
    abortSignal: context.abortSignal,
    budgets: resolveMcpResourceReadBudget(context.budget),
    correlationId: typeof requestId === 'string' ? requestId : '',
    authorization: context.authorization,
  });
}

export function toNeutralReadPort(
  adapter: Mcp20260728ReadToolAdapter,
): McpApplicationReadPort {
  return Object.freeze({
    listTools: async (context: McpApplicationContext, cursor?: string) => {
      const listed = await adapter.listTools(
        toStrictListContext(context, 'tools/list'),
        cursor === undefined ? Object.freeze({}) : Object.freeze({ cursor }),
      );
      return descriptorsFromListedTools(listed, readListedToolDescriptor);
    },
    callTool: async (
      context: McpApplicationContext,
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => callColpTool(adapter, context, name, args, false),
  });
}

export function toNeutralWritePort(
  adapter: Mcp20260728WriteToolAdapter,
): McpApplicationWritePort {
  return Object.freeze({
    listTools: async (context: McpApplicationContext, cursor?: string) => {
      const listed = await adapter.listTools(
        toStrictListContext(context, 'tools/list'),
        cursor === undefined ? Object.freeze({}) : Object.freeze({ cursor }),
      );
      return descriptorsFromListedTools(listed, writeListedToolDescriptor);
    },
    callTool: async (
      context: McpApplicationContext,
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => callColpTool(adapter, context, name, args, true),
  });
}

export function createPhase4bMcpApplicationFacadeFromColpAdapters(
  options: Omit<Phase4bMcpApplicationFacadeOptions, 'readPort' | 'writePort'> & {
    readonly readToolAdapter: Mcp20260728ReadToolAdapter;
    readonly writeToolAdapter?: Mcp20260728WriteToolAdapter;
  },
): McpApplicationFacade {
  return createPhase4bMcpApplicationFacade({
    resourceIdentity: options.resourceIdentity,
    collectionProjection: options.collectionProjection,
    snapshotProjection: options.snapshotProjection,
    nodeProjection: options.nodeProjection,
    readPort: toNeutralReadPort(options.readToolAdapter),
    ...(options.writeToolAdapter === undefined
      ? {}
      : { writePort: toNeutralWritePort(options.writeToolAdapter) }),
    ...(options.ownedCollectionsQuery === undefined
      ? {}
      : { ownedCollectionsQuery: options.ownedCollectionsQuery }),
    ...(options.nodesSearch === undefined
      ? {}
      : { nodesSearch: options.nodesSearch }),
  });
}

function closedWireTool(
  tool: ReturnType<typeof wireToolFromDescriptor>,
): ReturnType<typeof wireToolFromDescriptor> {
  const closed: Record<string, unknown> = {
    ...tool,
    inputSchema: materializeClosedMcpToolSchema(tool.inputSchema as Readonly<Record<string, unknown>>),
  };
  if (tool.outputSchema !== undefined) {
    closed.outputSchema = materializeClosedMcpToolSchema(
      tool.outputSchema as Readonly<Record<string, unknown>>,
    );
  }
  return Object.freeze(closed);
}

export function encodeStrictToolList(
  tools: ReturnType<typeof wireToolFromDescriptor>[],
  writeEnabled: boolean,
): Mcp20260728Result {
  return createPhase4bMcpResult({
    method: 'tools/list',
    fields: { tools },
    cache: { ttlMs: 0, cacheScope: 'private' },
  }, writeEnabled);
}

export function encodeStrictResourceTemplates(
  resourceTemplates: readonly Readonly<Record<string, unknown>>[],
  writeEnabled: boolean,
): Mcp20260728Result {
  return createPhase4bMcpResult({
    method: 'resources/templates/list',
    fields: { resourceTemplates },
    cache: PHASE4B_MCP_RESOURCE_TEMPLATES_CACHE_METADATA,
  }, writeEnabled);
}

export async function listStrictApplicationTools(
  context: Mcp20260728RequestContext,
  facade: McpApplicationFacade,
  cursor: string | undefined,
  writeEnabled: boolean,
): Promise<Mcp20260728Result> {
  const listed = await facade.listTools(
    toMcpApplicationContextFromStrict(context),
    cursor,
  );
  // Compat-only tools (the community `known.community.*` surface) are
  // listed and callable exclusively through `/collections/-/mcp-compat`;
  // the strict catalog never advertises them.
  const strictTools = listed.tools.filter((tool) => tool.compatOnly !== true);
  return encodeStrictToolList(
    strictTools
      // CG-02 tools are registered only on the compat host.
      .filter((tool) => !tool.name.startsWith('known.moderation.'))
      .map((tool) => closedWireTool(wireToolFromDescriptor(tool))),
    writeEnabled,
  );
}

export async function listStrictApplicationResourceTemplates(
  context: Mcp20260728RequestContext,
  facade: McpApplicationFacade,
  writeEnabled: boolean,
): Promise<Mcp20260728Result> {
  const listed = await facade.listResourceTemplates(
    toMcpApplicationContextFromStrict(context),
  );
  return encodeStrictResourceTemplates(
    listed.resourceTemplates.map((template) => Object.freeze({
      uriTemplate: template.uriTemplate,
      name: template.name,
      ...(template.title === undefined ? {} : { title: template.title }),
      ...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
    })),
    writeEnabled,
  );
}

export function readCatalogCursor(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const cursor = (params as { readonly cursor?: unknown }).cursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

async function callColpTool(
  adapter: Mcp20260728ReadToolAdapter | Mcp20260728WriteToolAdapter,
  context: McpApplicationContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
  write: boolean,
): Promise<McpApplicationToolResult> {
  try {
    const result = await adapter.callTool(
      toStrictCallContext(context, name, args),
      {
        name,
        arguments: args,
        ...(write && typeof args.requestState === 'string' ? { requestState: args.requestState } : {}),
      },
    );
    return mapStrictCallResult(result);
  } catch (error) {
    return mapCallFailure(error);
  }
}

function descriptorsFromListedTools(
  result: Mcp20260728Result,
  mapTool: (tool: Readonly<Record<string, unknown>>) => McpApplicationToolDescriptor,
): readonly McpApplicationToolDescriptor[] {
  const listed = result.tools as Readonly<Record<string, unknown>>[] | undefined;
  const tools: McpApplicationToolDescriptor[] = [];
  for (const tool of Array.isArray(listed) ? listed : []) {
    tools.push(mapTool(tool));
  }
  return Object.freeze(tools);
}

function readListedToolDescriptor(
  tool: Readonly<Record<string, unknown>>,
): McpApplicationToolDescriptor {
  const name = String(tool.name);
  const catalog = PHASE4B_MCP_READ_TOOL_CATALOG.find((entry) => entry.name === name);
  if (catalog !== undefined) return catalog;
  return descriptorFromListedTool(tool, Object.freeze([]));
}

function writeListedToolDescriptor(
  tool: Readonly<Record<string, unknown>>,
): McpApplicationToolDescriptor {
  const name = String(tool.name);
  const required = PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES[name as Phase4bMcpWriteToolName] ?? Object.freeze([]);
  return descriptorFromListedTool(tool, required);
}

function descriptorFromListedTool(
  tool: Readonly<Record<string, unknown>>,
  requiredScopes: readonly string[],
): McpApplicationToolDescriptor {
  const descriptor: Record<string, unknown> = {
    name: String(tool.name),
    description: String(tool.description ?? ''),
    inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
    requiredScopes,
  };
  if (tool.outputSchema !== undefined) descriptor.outputSchema = tool.outputSchema;
  if (typeof tool.title === 'string') descriptor.title = tool.title;
  if (typeof tool.annotations === 'object' && tool.annotations !== null) {
    descriptor.annotations = tool.annotations as Readonly<Record<string, unknown>>;
  }
  return Object.freeze(descriptor) as unknown as McpApplicationToolDescriptor;
}

function mapCallFailure(error: unknown): McpApplicationToolResult {
  if (error instanceof McpToolOutputUnavailableError) {
    return Object.freeze({
      kind: 'rejected',
      stableCode: 'tool_result_unavailable',
      safeMessage: 'Tool result unavailable.',
      retryable: false,
    });
  }
  if (error instanceof McpResourceNotFoundError) {
    return Object.freeze({
      kind: 'rejected',
      stableCode: 'not_found',
      safeMessage: 'Unknown tool.',
      retryable: false,
    });
  }
  if (error instanceof Mcp20260728RequestError) {
    if (error.kind === 'internal_error') throw error;
    const dataCode = requestErrorDataCode(error);
    if (isPhase4bMcpWriteErrorClass(dataCode)) {
      return toPhase4bMcpWriteRejectedResult(classifyPhase4bMcpWriteError(error));
    }
    return Object.freeze({
      kind: 'rejected',
      stableCode: error.kind,
      safeMessage: error.message,
      retryable: false,
    });
  }
  const classified = classifyPhase4bMcpWriteError(error);
  if (classified.outcome === 'dependency_error') {
    throw error;
  }
  return toPhase4bMcpWriteRejectedResult(classified);
}

function requestErrorDataCode(error: Mcp20260728RequestError): unknown {
  const data = error.data;
  if (data === undefined || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return (data as { readonly code?: unknown }).code;
}

function mapStrictCallResult(result: Mcp20260728Result): McpApplicationToolResult {
  if (result.resultType === 'input_required') {
    const plan = readPlanProjection(result);
    return Object.freeze({
      kind: 'awaiting_approval',
      planId: plan.planId,
      approvalUri: plan.approvalUri,
      expiresAt: plan.expiresAt,
      bindingSummary: plan.bindingSummary,
    });
  }
  return Object.freeze({
    kind: 'complete',
    content: completeResultContent(result.content, result.structuredContent),
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
  });
}

function completeResultContent(content: unknown, structuredContent: unknown): unknown {
  if (Array.isArray(content) && content.length > 0) {
    return content;
  }
  if (structuredContent !== undefined) {
    return Object.freeze([
      Object.freeze({ type: 'text', text: JSON.stringify(structuredContent) }),
    ]);
  }
  return content ?? [];
}

/**
 * The production strict route invokes the COLP write adapter directly rather
 * than round-tripping through the application facade. Keep its successful
 * Tool result presentation aligned with facade/compat callers by adding the
 * same JSON text block when COLP returned structured content only.
 */
export function ensureStrictToolCallTextContent(
  result: Mcp20260728Result,
): Mcp20260728Result {
  if (result.resultType !== 'complete') return result;
  const content = completeResultContent(result.content, result.structuredContent);
  if (content === result.content) return result;
  return Object.freeze({ ...result, content });
}

/**
 * Dispatch a non-COLP tool mounted by the era-neutral application facade.
 *
 * The strict transport keeps the COLP adapters on their existing path for
 * core Read/Write tools. Host extensions (Reports and owned collections) are
 * selected from the same facade catalog used by `tools/list`; compat-only
 * descriptors are deliberately rejected here so a client cannot bypass the
 * strict catalog by guessing a tool name.
 */
export async function callStrictApplicationExtensionTool(
  context: Mcp20260728RequestContext,
  facade: McpApplicationFacade,
  name: unknown,
  params: unknown,
  writeEnabled: boolean,
): Promise<Mcp20260728Result> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Mcp20260728RequestError('invalid_params', 'Unknown tool.');
  }
  const applicationContext = toMcpApplicationContextFromStrict(context);
  const listed = await facade.listTools(applicationContext);
  context.abortSignal.throwIfAborted();
  const descriptor = listed.tools.find((tool) => tool.name === name);
  if (descriptor === undefined || descriptor.compatOnly === true
    || name.startsWith('known.moderation.')) {
    throw new Mcp20260728RequestError('invalid_params', 'Unknown tool.', { name });
  }
  const args = applicationToolArguments(params);
  const result = await facade.callTool(applicationContext, name, args);
  return encodeStrictApplicationToolResult(result, writeEnabled);
}

/** Dispatch one strict tools/call while keeping core adapters on their wire path. */
export async function dispatchStrictToolCall(
  context: Mcp20260728RequestContext,
  params: Readonly<Record<string, unknown>> | undefined,
  readToolAdapter: Mcp20260728ReadToolAdapter,
  writeToolAdapter: Mcp20260728WriteToolAdapter | undefined,
  facade: McpApplicationFacade,
  writeEnabled: boolean,
): Promise<Mcp20260728Result> {
  const name = typeof params?.name === 'string' ? params.name : undefined;
  const isCoreReadTool = name !== undefined
    && (PHASE4B_MCP_READ_TOOL_NAMES as readonly string[]).includes(name);
  const isWriteTool = name !== undefined
    && (PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES as readonly string[]).includes(name);
  const canCallWrite = isWriteTool
    && writeToolAdapter !== undefined
    && canCallPhase4bMcpWriteTool(context, name);
  if (isCoreReadTool && !canAccessPhase4bMcpReadTools(context)) throw strictUnknownTool(name);
  if (isWriteTool && !canCallWrite) throw strictUnknownTool(name);
  if (isWriteTool) {
    return ensureStrictToolCallTextContent(await writeToolAdapter!.callTool(context, params));
  }
  if (!isCoreReadTool) {
    return callStrictApplicationExtensionTool(context, facade, name, params, writeEnabled);
  }
  if (!canAccessPhase4bMcpReadTools(context)) throw strictUnknownTool(name);
  return readToolAdapter.callTool(context, params);
}

function strictUnknownTool(name: string | undefined): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', 'Unknown tool.', { name });
}

function applicationToolArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Mcp20260728RequestError('invalid_params', 'Invalid tool arguments.');
  }
  const raw = (value as { readonly arguments?: unknown }).arguments;
  if (raw === undefined) return Object.freeze({});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Mcp20260728RequestError('invalid_params', 'Invalid tool arguments.');
  }
  return raw as Readonly<Record<string, unknown>>;
}

function encodeStrictApplicationToolResult(
  result: McpApplicationToolResult,
  writeEnabled: boolean,
): Mcp20260728Result {
  if (result.kind === 'rejected') {
    throw new Mcp20260728RequestError(
      'invalid_params',
      result.safeMessage,
      { code: result.stableCode },
    );
  }
  if (result.kind === 'awaiting_approval') {
    const awaiting = Object.freeze({
      status: 'awaiting_approval',
      planId: result.planId,
      approvalUri: result.approvalUri,
      expiresAt: result.expiresAt,
    });
    return createPhase4bMcpResult({
      method: 'tools/call',
      fields: {
        content: Object.freeze([{ type: 'text', text: JSON.stringify(awaiting) }]),
        structuredContent: awaiting,
      },
    }, writeEnabled);
  }
  return createPhase4bMcpResult({
    method: 'tools/call',
    fields: {
      content: completeResultContent(result.content, result.structuredContent),
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    },
  }, writeEnabled);
}

function readPlanProjection(result: Mcp20260728Result): {
  readonly planId: string;
  readonly approvalUri: string;
  readonly expiresAt: string;
  readonly bindingSummary: string;
} {
  const candidate = (result.plan ?? result.structuredContent) as Readonly<Record<string, unknown>> | undefined;
  const planId = typeof candidate?.planId === 'string' ? candidate.planId : '';
  const approvalUri = typeof candidate?.approvalUri === 'string' ? candidate.approvalUri : '';
  const expiresAt = typeof candidate?.expiresAt === 'string' ? candidate.expiresAt : '';
  return Object.freeze({
    planId,
    approvalUri,
    expiresAt,
    bindingSummary: 'authenticated',
  });
}

function toStrictListContext(
  context: McpApplicationContext,
  method: 'tools/list' | 'tools/call',
): Mcp20260728RequestContext {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: method }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method,
      params: Object.freeze({
        _meta: Object.freeze({
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
        }),
      }),
    }),
    binding: bindingFromPrincipal(context.principal),
    scope: context.scopes,
    budget: context.budgets,
    abortSignal: context.abortSignal,
    authorization: context.authorization,
  });
}

function toStrictCallContext(
  context: McpApplicationContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Mcp20260728RequestContext {
  const collectionId = args.collectionId;
  const headers: Array<{ readonly name: string; readonly value: string }> = [
    Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
    Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
    Object.freeze({ name: 'Mcp-Name', value: name }),
  ];
  if (typeof collectionId === 'string') {
    headers.push(Object.freeze({
      name: 'Mcp-Param-X-Collection-Id',
      value: collectionId,
    }));
  }
  return createPhase4bMcpRequestContext({
    headers: Object.freeze(headers),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
        }),
        name,
        arguments: args,
      }),
    }),
    binding: bindingFromPrincipal(context.principal),
    scope: context.scopes,
    budget: context.budgets,
    abortSignal: context.abortSignal,
    authorization: context.authorization,
  });
}

function bindingFromPrincipal(principal: McpApplicationContext['principal']): McpAuthorizationBinding {
  if (principal.kind === 'anonymous') {
    return Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: principal.resourceAudience,
      securityEpoch: principal.securityEpoch,
    });
  }
  return Object.freeze({
    kind: 'authenticated',
    principalId: principal.principalId,
    clientId: principal.clientId,
    credentialBindingId: principal.credentialBindingId,
    resourceAudience: principal.resourceAudience,
    securityEpoch: principal.securityEpoch,
  });
}
