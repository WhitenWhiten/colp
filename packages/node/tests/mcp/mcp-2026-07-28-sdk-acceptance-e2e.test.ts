/**
 * COLP-MCP-15: source-bound acceptance end-to-end contract for the accepted
 * MCP 2026-07-28 SDK.
 *
 * Uses the COLP-MCP-03 independent reference client (`@modelcontextprotocol/
 * client`) over the test-only fixture host (`@modelcontextprotocol/server`):
 * - discovery, Read, listen and Write/MRTR (Plan/Approval) round trips;
 * - import boundary: root MCP-free, `/mcp` and `/mcp/2026-07-28` only,
 *   deep imports blocked, fixture host absent from the packed tarball;
 * - restored `supportedProfiles` without disturbing COLP Sync Session.
 *
 * This suite is part of the owned Vitest run (and therefore of the accepted
 * SDK artifact's report digest). Legacy-negative samples (GET/DELETE 405,
 * `initialize`, `notifications/initialized`, `resources/subscribe`,
 * `Mcp-Session-Id`, `Last-Event-ID`) are locked by
 * tests/mcp/mcp-2026-07-28-reference-harness-contract.test.ts (COLP-MCP-03).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { supportedProfiles } from '../../src/index.js';
import * as mcpApi from '../../src/mcp/index.js';
import * as mcpVersionedApi from '../../src/mcp/2026-07-28/index.js';
import {
  MCP_PROTOCOL_VERSION,
  supportedMcpProtocolVersions,
} from '../../src/mcp/protocol-version.js';
import * as syncApi from '../../src/sync/index.js';
import type {
  SyncSessionBinding,
  SyncSessionRecord,
  SyncSessionStore,
} from '../../src/sync/index.js';
import {
  createFixtureHost,
  FIXTURE_WRITE_APPROVED_STATE_PREFIX,
  FIXTURE_WRITE_TOOL_NAME,
} from '../fixtures/mcp-2026-07-28/fixture-host/index.js';
import {
  createReferenceMcpClient,
  type ReferenceMcpClient,
} from '../fixtures/mcp-2026-07-28/reference-client/index.js';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(import.meta.dirname, '..', '..');
const distPresent = existsSync(join(packageRoot, 'dist', 'mcp', 'index.js'));
const endpoint = 'http://fixture.invalid/mcp';

function withTimeout<Value>(
  promise: Promise<Value>,
  ms: number,
  message: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function connectClient(host: ReturnType<typeof createFixtureHost>): Promise<ReferenceMcpClient> {
  const client = createReferenceMcpClient({
    url: endpoint,
    fetchBridge: async (input, init) => host.fetch(new Request(input, init)),
  });
  await client.connect();
  return client;
}

describe('COLP-MCP-15 accepted MCP 2026-07-28 SDK end-to-end', () => {
  it('round-trips discovery, Read, listen and Write/MRTR with Plan/Approval', async () => {
    const host = createFixtureHost();
    const client = await connectClient(host);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

      const discover = client.getDiscoverResult();
      expect(discover?.supportedVersions).toContain('2026-07-28');
      expect((await client.discover()).supportedVersions).toContain('2026-07-28');

      const read = await client.request(
        { method: 'resources/read', params: { uri: 'fixture://ping' } },
        undefined,
      );
      expect(read).toMatchObject({ contents: [{ uri: 'fixture://ping', text: 'pong' }] });

      const subscription = await withTimeout(
        client.listen({}),
        3000,
        'listen ack timed out',
      );
      expect(subscription.honoredFilter).toBeDefined();
      await subscription.close();
      await expect(subscription.closed).resolves.toBeDefined();

      // Modern Write / MRTR: the first leg returns input_required with a
      // server-minted requestState (Plan created, approval pending).
      const first = await client.request(
        { method: 'tools/call', params: { name: FIXTURE_WRITE_TOOL_NAME, arguments: { note: 'hello' } } },
        { allowInputRequired: true, timeout: 5000 },
      );
      const firstResult = first as {
        resultType?: string;
        requestState?: string;
        inputRequests?: Record<string, unknown>;
      };
      expect(firstResult.resultType).toBe('input_required');
      expect(firstResult.requestState).toMatch(
        new RegExp(`^${FIXTURE_WRITE_APPROVED_STATE_PREFIX}`),
      );
      expect(firstResult.inputRequests).toEqual({});

      // Out-of-band approval happened between the legs; the retry echoes the
      // requestState (and may carry an explicit approval response) and
      // resumes the same plan to completion.
      const state = firstResult.requestState!;
      const retry = await client.request(
        {
          method: 'tools/call',
          params: {
            name: FIXTURE_WRITE_TOOL_NAME,
            arguments: { note: 'hello' },
            requestState: state,
            inputResponses: { approval: { action: 'accept', content: { approved: true } } },
          },
        },
        { allowInputRequired: true, timeout: 5000 },
      );
      expect(retry).toMatchObject({ content: [{ type: 'text', text: 'applied:hello' }] });

      const listenRecord = host.stats.requests.find(
        (record) => record.method === 'subscriptions/listen',
      );
      expect(listenRecord?.responseContentType).toMatch(/text\/event-stream/u);
      const writeRecord = host.stats.requests.find(
        (record) => record.method === 'tools/call',
      );
      expect(writeRecord?.envelopeProtocolVersion).toBe('2026-07-28');
    } finally {
      await client.close();
      await host.close();
    }
  });

  it('keeps the import boundary: only /mcp entries, root MCP-free, deep imports blocked', async () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
    expect(mcpApi.MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(mcpVersionedApi.MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(mcpVersionedApi.supportedMcpProtocolVersions).toEqual(['2026-07-28']);

    const root = (await import('../../src/index.js')) as Record<string, unknown>;
    expect(root.MCP_PROTOCOL_VERSION).toBeUndefined();
    expect(root.createMcp20260728RequestContext).toBeUndefined();

    const packageJson = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports)).toContain('./mcp');
    expect(Object.keys(packageJson.exports)).toContain('./mcp/2026-07-28');
    expect(Object.keys(packageJson.exports)).toContain('./sync');
    for (const blocked of [
      './mcp/index',
      './mcp/index.js',
      './mcp/2026-07-28/index',
      './mcp/2026-07-28/index.js',
      './mcp/2026-07-28/write',
      './mcp/shared/authorization',
      './mcp/2026-07-28/request-context',
    ]) {
      expect(Object.hasOwn(packageJson.exports, blocked), blocked).toBe(false);
    }
  });

  it.skipIf(!distPresent)(
    'when dist/ exists, pack includes MCP dist artifacts and never the fixture host or reference client',
    async () => {
      const { stdout, stderr } = await execFileAsync(npmExecutable, ['pack', '--dry-run'], {
        cwd: packageRoot,
        shell: process.platform === 'win32',
      });
      const output = `${stdout}\n${stderr}`;
      for (const artifact of [
        'dist/mcp/index.js',
        'dist/mcp/index.cjs',
        'dist/mcp/index.d.ts',
        'dist/mcp/index.d.cts',
        'dist/mcp/2026-07-28/index.js',
        'dist/mcp/2026-07-28/index.cjs',
        'dist/mcp/2026-07-28/index.d.ts',
        'dist/mcp/2026-07-28/index.d.cts',
      ]) {
        expect(output, artifact).toContain(artifact);
      }
      expect(output).not.toContain('fixture-host');
      expect(output).not.toContain('reference-client');
      expect(output).not.toContain('tests/fixtures/mcp-2026-07-28');
    },
    120_000,
  );

  it('restores mcp-read/mcp-write claims without disturbing COLP Sync Session', async () => {
    expect(supportedProfiles).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
    // COLP Sync Session symbols are legal and stay importable; the absence
    // scanner must never flag SyncSession* as Legacy MCP Session material.
    const syncTypes: [SyncSessionBinding, SyncSessionRecord, SyncSessionStore] | undefined =
      undefined;
    void syncTypes;
    expect(typeof syncApi.createSyncSession).toBe('function');
    expect(Object.isFrozen(supportedProfiles)).toBe(true);
  });
});
