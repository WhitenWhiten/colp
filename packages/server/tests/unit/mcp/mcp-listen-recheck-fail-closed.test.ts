import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { mapOAuthEvidenceToAuthenticatedBinding } from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  McpOauthVerificationError,
  createPhase4bMcpChangeSignalSource,
} from '../../../src/modules/mcp/index.js';
import {
  AUDIENCE,
  CLIENT_ID,
  SUBJECT,
  apps,
  mcpEnv,
  mcpHttpPost,
  modernBody,
  startApi,
  withMcpTestHost,
} from '../../support/phase4b-mcp-transport-scaffold.js';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

const binding = mapOAuthEvidenceToAuthenticatedBinding(Object.freeze({
  credentialKind: 'oauth',
  principalId: SUBJECT,
  clientId: CLIENT_ID,
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
}));

interface SseEvent {
  readonly method?: string;
}

function createSseReader(response: Response): {
  next(): Promise<SseEvent | null>;
  close(): Promise<void>;
} {
  const body = response.body;
  if (body === null) throw new Error('SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  return {
    async next(): Promise<SseEvent | null> {
      for (;;) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data !== undefined) return JSON.parse(data.slice('data: '.length)) as SseEvent;
          continue;
        }
        if (done) return null;
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          continue;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function withTimeout<Value>(promise: Promise<Value>, ms: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for SSE close')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('a verifier dependency failure during the listen recheck denies and closes the stream', async () => {
  let dependencyDown = false;
  const verifier = {
    async verify(input: { readonly authorization?: string | readonly string[] | undefined }) {
      if (input.authorization !== 'Bearer valid-token') {
        throw new McpOauthVerificationError('invalid_token');
      }
      if (dependencyDown) throw new McpOauthVerificationError('jwks_fetch_failed');
      return { binding } as never;
    },
  };
  const source = createPhase4bMcpChangeSignalSource();
  const server = await startApi(mcpEnv(), { oauthVerifier: verifier, changeSignalSource: source });
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer valid-token',
    }, server.config.publication.origin),
    modernBody('subscriptions/listen', 'dependency-failure', {
      notifications: { resourcesListChanged: true },
    }),
  );
  assert.equal(response.status, 200);
  const reader = createSseReader(response);
  try {
    assert.equal((await withTimeout(reader.next(), 2_000))?.method, 'notifications/subscriptions/acknowledged');
    dependencyDown = true;
    source.publish({ type: 'resource-list-changed' });
    assert.equal(await withTimeout(reader.next(), 2_000), null);
    assert.equal(source.listenerCount(), 0);
  } finally {
    await reader.close();
  }
});
