/**
 * T-05/T-06 legacy catalog/result mapping for `/collections/-/mcp-compat`.
 *
 * Registers real tool schemas from facade descriptors and maps resources
 * through one facade cursor stream. Write CallToolResult mapping lives in
 * `mcp-compat-write-adapter.ts`. Does not copy schemas or templates. 07-28
 * wire keys stay off this era's payloads.
 */
import {
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  McpToolOutputUnavailableError,
} from '@know-n/colp/mcp';
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import {
  type McpApplicationContext,
  type McpApplicationFacade,
  type McpApplicationToolResult,
  classifyPhase4bMcpWriteError,
  toPhase4bMcpWriteRejectedResult,
} from '../../modules/mcp/index.js';
import type { McpCompatExecutionObserver } from './mcp-compat-execution-observer.js';
import {
  compatListedToolInputSchema,
  compatListedToolOutputSchema,
  legacyCallToolExecutionClass,
  mapLegacyCallToolResult,
} from './mcp-compat-write-adapter.js';

export { mapLegacyCallToolResult } from './mcp-compat-write-adapter.js';

export async function installMcpCompatReadCatalog(input: {
  readonly server: McpServer;
  readonly facade: McpApplicationFacade;
  readonly applicationContext: McpApplicationContext;
  readonly abortController: AbortController;
  readonly observer: McpCompatExecutionObserver;
  /** Skip tools/list + registerTool; still install tools/call and resources. */
  readonly skipToolList?: boolean;
}): Promise<void> {
  const dispatchCall = async (
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    const unbind = bindSdkAbort(signal, input.abortController);
    try {
      const result = await input.facade.callTool(
        input.applicationContext,
        name,
        asArgumentRecord(args),
      );
      input.observer.observeExecution(legacyCallToolExecutionClass(result));
      return mapLegacyCallToolResult(result);
    } catch (error) {
      input.observer.observeExecution(executionClassFromToolFailure(error));
      return mapLegacyCallToolResult(mapToolFailure(error));
    } finally {
      unbind();
    }
  };
  if (input.skipToolList !== true) {
    const listed = await input.facade.listTools(input.applicationContext);
    for (const tool of listed.tools) {
      const outputSchema = compatListedToolOutputSchema(tool);
      input.server.registerTool(
        tool.name,
        {
          description: tool.description,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          inputSchema: compatListedToolInputSchema(tool),
          ...(outputSchema === undefined ? {} : { outputSchema }),
        },
        async (args, toolCtx) => dispatchCall(tool.name, args, toolCtx.mcpReq.signal),
      );
    }
  }
  // SDK tools/call throws `Tool ${name} not found` for unregistered names.
  // Overwrite so unknown tools go through the facade's stable `Unknown tool.`
  // result instead of leaking the client-supplied name.
  input.server.server.setRequestHandler('tools/call', async (request, ctx) => {
    return dispatchCall(
      String(request.params?.name ?? ''),
      request.params?.arguments,
      ctx.mcpReq.signal,
    );
  });
  installCompatResourceHandlers(input);
}

function installCompatResourceHandlers(input: {
  readonly server: McpServer;
  readonly facade: McpApplicationFacade;
  readonly applicationContext: McpApplicationContext;
  readonly abortController: AbortController;
  readonly observer: McpCompatExecutionObserver;
}): void {
  const protocol = input.server.server;
  protocol.setRequestHandler('resources/list', async (request, ctx) => {
    const unbind = bindSdkAbort(ctx.mcpReq.signal, input.abortController);
    try {
      const listed = await input.facade.listResources(
        input.applicationContext,
        readCursorParam(request.params),
      );
      input.observer.observeExecution('ok');
      return {
        resources: listed.resources.map(mapLegacyResource),
        ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
      };
    } catch (error) {
      input.observer.observeExecution(executionClassFromReadFault(error));
      throw mapCompatReadError(error);
    } finally {
      unbind();
    }
  });
  protocol.setRequestHandler('resources/templates/list', async (request, ctx) => {
    const unbind = bindSdkAbort(ctx.mcpReq.signal, input.abortController);
    try {
      const listed = await input.facade.listResourceTemplates(
        input.applicationContext,
        readCursorParam(request.params),
      );
      input.observer.observeExecution('ok');
      return {
        resourceTemplates: listed.resourceTemplates.map(mapLegacyTemplate),
        ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
      };
    } catch (error) {
      input.observer.observeExecution(executionClassFromReadFault(error));
      throw mapCompatReadError(error);
    } finally {
      unbind();
    }
  });
  protocol.setRequestHandler('resources/read', async (request, ctx) => {
    const unbind = bindSdkAbort(ctx.mcpReq.signal, input.abortController);
    const uri = readUriParam(request.params);
    try {
      if (uri.length === 0) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid Resource URI.');
      }
      const read = await input.facade.readResource(input.applicationContext, uri);
      input.observer.observeExecution('ok');
      return { contents: mapCompatResourceContents(uri, read.contents) };
    } catch (error) {
      input.observer.observeExecution(executionClassFromReadFault(error));
      throw mapCompatReadError(error);
    } finally {
      unbind();
    }
  });
}

function mapLegacyResource(entry: {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly title?: string;
  readonly description?: string;
}): { uri: string; name: string; mimeType: string; title?: string; description?: string } {
  return {
    uri: entry.uri,
    name: entry.name,
    mimeType: entry.mimeType,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  };
}

function mapLegacyTemplate(entry: {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}): {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
} {
  return {
    uriTemplate: entry.uriTemplate,
    name: entry.name,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
  };
}

function mapCompatResourceContents(
  uri: string,
  contents: Awaited<ReturnType<McpApplicationFacade['readResource']>>['contents'],
): Array<{ uri: string; mimeType?: string; text: string } | { uri: string; mimeType?: string; blob: string }> {
  return contents.map((entry) => {
    const uriValue = entry.uri ?? uri;
    if (typeof entry.blob === 'string') {
      return {
        uri: uriValue,
        blob: entry.blob,
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
      };
    }
    return {
      uri: uriValue,
      text: entry.text ?? '',
      ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
    };
  });
}

function executionClassFromToolFailure(error: unknown): 'rejected' | 'dependency_error' | 'cancelled' {
  if (isCancelledError(error)) return 'cancelled';
  if (error instanceof McpToolOutputUnavailableError) return 'rejected';
  if (error instanceof McpResourceNotFoundError) return 'rejected';
  return classifyPhase4bMcpWriteError(error).outcome;
}

function executionClassFromReadFault(error: unknown): 'rejected' | 'dependency_error' | 'cancelled' {
  if (isCancelledError(error)) return 'cancelled';
  if (error instanceof ProtocolError) {
    return error.code === ProtocolErrorCode.InternalError ? 'dependency_error' : 'rejected';
  }
  if (error instanceof McpResourceNotFoundError) return 'rejected';
  if (error instanceof McpToolOutputUnavailableError) return 'rejected';
  if (error instanceof McpReadRequestContextError) return 'rejected';
  if (error instanceof TypeError && error.message === 'Invalid Resource URI.') return 'rejected';
  return 'dependency_error';
}

function mapToolFailure(error: unknown): McpApplicationToolResult {
  if (isCancelledError(error)) {
    return Object.freeze({
      kind: 'rejected',
      stableCode: 'cancelled',
      safeMessage: 'Request cancelled.',
      retryable: true,
    });
  }
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
  const classified = classifyPhase4bMcpWriteError(error);
  if (classified.outcome !== 'dependency_error') {
    return toPhase4bMcpWriteRejectedResult(classified);
  }
  return Object.freeze({
    kind: 'rejected',
    stableCode: 'internal_error',
    safeMessage: 'Internal error.',
    retryable: false,
  });
}

function mapCompatReadError(error: unknown): Error {
  if (error instanceof ProtocolError) return error;
  if (isCancelledError(error)) {
    return new ProtocolError(ProtocolErrorCode.InternalError, 'Request cancelled.');
  }
  if (error instanceof McpResourceNotFoundError) {
    return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Resource not found.');
  }
  if (error instanceof McpToolOutputUnavailableError) {
    return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Resource result unavailable.');
  }
  if (error instanceof McpReadRequestContextError) {
    return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid resource list cursor.');
  }
  if (error instanceof TypeError && error.message === 'Invalid Resource URI.') {
    return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid Resource URI.');
  }
  return new ProtocolError(ProtocolErrorCode.InternalError, 'Internal error.');
}

function isCancelledError(error: unknown): boolean {
  if (error instanceof McpReadRequestAbortedError) return true;
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'aborted');
}

function bindSdkAbort(signal: AbortSignal, abortController: AbortController): () => void {
  const onSdkAbort = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Client disconnected', 'AbortError'),
      );
    }
  };
  if (signal.aborted) onSdkAbort();
  else signal.addEventListener('abort', onSdkAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onSdkAbort);
  };
}

function asArgumentRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({});
  }
  return value as Readonly<Record<string, unknown>>;
}

function readCursorParam(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const cursor = (params as { readonly cursor?: unknown }).cursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

function readUriParam(params: unknown): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return '';
  const uri = (params as { readonly uri?: unknown }).uri;
  return typeof uri === 'string' ? uri : '';
}
