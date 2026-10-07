/**
 * Era-neutral MCP application facade (T-01 / MCP-CQ-08).
 *
 * Depends on projections, the catalog, and protocol-neutral tool ports.
 * Strict and compat adapters convert wire headers / `_meta` outside this
 * module. Do not import Fastify, the official MCP SDK, or COLP MCP wire.
 */
import type { GetOwnedCollectionsPagePorts } from '../collections/index.js';
import type { McpApplicationContext } from './application-context.js';
import {
  canCallApplicationWriteTool,
  canListApplicationReadTools,
  canListApplicationWriteTools,
  isApplicationWriteToolName,
  type McpApplicationResourceDescriptor,
  type McpApplicationResourceTemplateDescriptor,
  type McpApplicationToolDescriptor,
} from './application-catalog.js';
import type {
  McpApplicationReadPort,
  McpApplicationWritePort,
} from './application-ports.js';
import type {
  McpApplicationResourceContents,
  McpApplicationResourceList,
  McpApplicationResourceTemplateList,
  McpApplicationToolList,
  McpApplicationToolResult,
} from './application-results.js';
import type { Phase4bMcpCollectionResourceProjection } from './collection-resources.js';
import type { Phase4bMcpNodeResourceProjection } from './node-resources.js';
import type { Phase4bMcpResourceIdentity } from './resource-identity.js';
import type { Phase4bMcpSnapshotResourceProjection } from './snapshot-resources.js';
import {
  PHASE4B_MCP_COLLECTIONS_LIST_TOOL,
  PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME,
  callOwnedCollectionsListTool,
  canListOwnedCollectionsTool,
} from './owned-collection-mcp.js';
import { COMMUNITY_MCP_TOOL_NAMES } from './community-mcp.js';

export interface McpApplicationFacade {
  readonly listTools: (
    context: McpApplicationContext,
    cursor?: string,
  ) => Promise<McpApplicationToolList>;
  readonly callTool: (
    context: McpApplicationContext,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<McpApplicationToolResult>;
  readonly listResources: (
    context: McpApplicationContext,
    cursor?: string,
  ) => Promise<McpApplicationResourceList>;
  readonly listResourceTemplates: (
    context: McpApplicationContext,
    cursor?: string,
  ) => Promise<McpApplicationResourceTemplateList>;
  readonly readResource: (
    context: McpApplicationContext,
    uri: string,
  ) => Promise<McpApplicationResourceContents>;
}

export interface Phase4bMcpApplicationFacadeOptions {
  readonly resourceIdentity: Phase4bMcpResourceIdentity;
  readonly collectionProjection: Phase4bMcpCollectionResourceProjection;
  readonly snapshotProjection: Phase4bMcpSnapshotResourceProjection;
  readonly nodeProjection: Phase4bMcpNodeResourceProjection;
  readonly readPort: McpApplicationReadPort;
  /** Optional host-extension read tools (for example Reports). */
  readonly reportReadPort?: McpApplicationReadPort;
  /** Optional host-extension write tools (for example typed report Plans). */
  readonly reportWritePort?: McpApplicationWritePort;
  /** Optional host-extension community tools (CS-01 target + vote). */
  readonly communityPort?: McpApplicationReadPort;
  /** Optional content-governance moderation tools on the compat host. */
  readonly moderationPort?: McpApplicationReadPort;
  readonly writePort?: McpApplicationWritePort;
  readonly ownedCollectionsQuery?: GetOwnedCollectionsPagePorts;
}

export function createPhase4bMcpApplicationFacade(
  options: Phase4bMcpApplicationFacadeOptions,
): McpApplicationFacade {
  const resourceIdentity = options.resourceIdentity;
  const collectionProjection = options.collectionProjection;
  const snapshotProjection = options.snapshotProjection;
  const nodeProjection = options.nodeProjection;
  const readPort = options.readPort;
  const reportReadPort = options.reportReadPort;
  const reportWritePort = options.reportWritePort;
  const communityPort = options.communityPort;
  const moderationPort = options.moderationPort;
  const writePort = options.writePort;
  const ownedCollectionsQuery = options.ownedCollectionsQuery;

  const listTools = async (
    context: McpApplicationContext,
    cursor?: string,
  ): Promise<McpApplicationToolList> => {
    const canRead = canListApplicationReadTools(context);
    const canWrite = writePort !== undefined && canListApplicationWriteTools(context);
    const reportTools = reportReadPort === undefined ? [] : await reportReadPort.listTools(context, cursor);
    const reportWriteTools = reportWritePort === undefined ? [] : await reportWritePort.listTools(context, cursor);
    const moderationTools = moderationPort === undefined ? [] : await moderationPort.listTools(context, cursor);
    const canReport = reportTools.length > 0 || reportWriteTools.length > 0;
    const communityTools = communityPort === undefined ? [] : await communityPort.listTools(context, cursor);
    const canModeration = moderationTools.length > 0;
    const canListOwned = canListOwnedCollectionsTool(context, ownedCollectionsQuery);
    if (!canRead && !canWrite && !canReport && communityTools.length === 0 && !canModeration) {
      return Object.freeze({ tools: Object.freeze([]) });
    }
    const tools: McpApplicationToolDescriptor[] = [];
    if (canRead) {
      tools.push(...await readPort.listTools(context, cursor));
    }
    if (canReport) tools.push(...reportTools);
    if (reportWriteTools.length > 0) tools.push(...reportWriteTools);
    if (communityTools.length > 0) tools.push(...communityTools);
    if (canModeration) tools.push(...moderationTools);
    if (canListOwned) {
      tools.push(PHASE4B_MCP_COLLECTIONS_LIST_TOOL);
    }
    if (canWrite && writePort !== undefined) {
      const listed = await writePort.listTools(context, cursor);
      for (const tool of listed) {
        if (canCallApplicationWriteTool(context, tool.name)) tools.push(tool);
      }
    }
    tools.sort((left, right) => (left.name < right.name ? -1 : 1));
    return Object.freeze({ tools: Object.freeze(tools) });
  };

  const callTool = async (
    context: McpApplicationContext,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpApplicationToolResult> => {
    if (name === PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME) {
      if (ownedCollectionsQuery === undefined) return unknownToolRejected();
      return callOwnedCollectionsListTool(ownedCollectionsQuery, context, args);
    }
    const isWriteTool = isApplicationWriteToolName(name);
    if (reportReadPort !== undefined && (name === 'reports.get' || name === 'reports.list' || name === 'reports.issues.list' || name === 'reports.issues.content')) {
      return reportReadPort.callTool(context, name, args);
    }
    if (reportWritePort !== undefined && name.startsWith('reports.')) {
      return reportWritePort.callTool(context, name, args);
    }
    if (communityPort !== undefined
        && (COMMUNITY_MCP_TOOL_NAMES as readonly string[]).includes(name)) {
      return communityPort.callTool(context, name, args);
    }
    if (moderationPort !== undefined && name.startsWith('known.moderation.')) {
      return moderationPort.callTool(context, name, args);
    }
    const canCallWrite = isWriteTool
      && writePort !== undefined
      && canCallApplicationWriteTool(context, name);
    if (!canListApplicationReadTools(context) && !canCallWrite) {
      return unknownToolRejected();
    }
    if (isWriteTool) {
      if (!canCallWrite || writePort === undefined) return unknownToolRejected();
      return writePort.callTool(context, name, args);
    }
    if (!canListApplicationReadTools(context)) return unknownToolRejected();
    return readPort.callTool(context, name, args);
  };

  const listResources = async (
    context: McpApplicationContext,
    cursor?: string,
  ): Promise<McpApplicationResourceList> => {
    const trusted = toTrustedReadContext(context);
    const listed = await collectionProjection.listResources(
      cursor === undefined ? Object.freeze({}) : Object.freeze({ cursor }),
      trusted,
    );
    return Object.freeze({
      resources: Object.freeze(listed.resources.map(resourceDescriptorFromProjection)),
      ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
    });
  };

  const listResourceTemplates = async (
    _context: McpApplicationContext,
    _cursor?: string,
  ): Promise<McpApplicationResourceTemplateList> => {
    const resourceTemplates = resourceIdentity.templates.map(templateDescriptorFromIdentity);
    return Object.freeze({ resourceTemplates: Object.freeze(resourceTemplates) });
  };

  const readResource = async (
    context: McpApplicationContext,
    uri: string,
  ): Promise<McpApplicationResourceContents> => {
    let resource;
    try {
      resource = resourceIdentity.parse(uri);
    } catch {
      throw new TypeError('Invalid Resource URI.');
    }
    const trusted = toTrustedReadContext(context);
    const input = Object.freeze({ resource });
    const projected = resource.kind === 'collection-snapshot'
      ? await snapshotProjection.readResource(input, trusted)
      : resource.kind === 'collection-node'
        ? await nodeProjection.readResource(input, trusted)
        : await collectionProjection.readResource(input, trusted);
    return Object.freeze({
      contents: Object.freeze(projected.contents.map(resourceContentFromProjection)),
    });
  };

  return Object.freeze({
    listTools,
    callTool,
    listResources,
    listResourceTemplates,
    readResource,
  });
}

function resourceDescriptorFromProjection(
  entry: Readonly<{
    readonly uri: string;
    readonly name: string;
    readonly mimeType: string;
    readonly description?: string;
  }>,
): McpApplicationResourceDescriptor {
  return Object.freeze({
    uri: entry.uri,
    name: entry.name,
    mimeType: entry.mimeType,
    ...(entry.description === undefined ? {} : { description: entry.description }),
  });
}

function resourceContentFromProjection(
  entry: Readonly<{ readonly mimeType: string }>,
): McpApplicationResourceContents['contents'][number] {
  const raw = entry as Readonly<Record<string, unknown>>;
  return Object.freeze({
    mimeType: String(raw.mimeType),
    ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...(typeof raw.blob === 'string' ? { blob: raw.blob } : {}),
  });
}

function templateDescriptorFromIdentity(
  template: Readonly<{
    readonly uriTemplate: string;
    readonly name: string;
    readonly title: string;
    readonly mimeType: string;
  }>,
): McpApplicationResourceTemplateDescriptor {
  return Object.freeze({
    uriTemplate: template.uriTemplate,
    name: template.name,
    title: template.title,
    mimeType: template.mimeType,
  });
}

function unknownToolRejected(): McpApplicationToolResult {
  return Object.freeze({
    kind: 'rejected',
    stableCode: 'unknown_tool',
    safeMessage: 'Unknown tool.',
    retryable: false,
  });
}

function toTrustedReadContext(context: McpApplicationContext) {
  return Object.freeze({
    binding: bindingFromPrincipal(context.principal),
    scope: context.scopes,
    budget: context.budgets,
    abortSignal: context.abortSignal,
    authorization: context.authorization,
  });
}

function bindingFromPrincipal(principal: McpApplicationContext['principal']) {
  if (principal.kind === 'anonymous') {
    return Object.freeze({
      kind: 'anonymous' as const,
      principalId: 'public' as const,
      resourceAudience: principal.resourceAudience,
      securityEpoch: principal.securityEpoch,
    });
  }
  return Object.freeze({
    kind: 'authenticated' as const,
    principalId: principal.principalId,
    clientId: principal.clientId,
    credentialBindingId: principal.credentialBindingId,
    resourceAudience: principal.resourceAudience,
    securityEpoch: principal.securityEpoch,
  });
}
