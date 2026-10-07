import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { MCP_COMPAT_RECOMMENDED_CLIENTS } from '../../../src/modules/mcp/index.js';
import {
  MCP_COMPAT_PATH,
  PINNED_CLAUDE_VERSION,
  PINNED_CLIENTS,
  PINNED_CODEX_VERSION,
  REFUSE_EXIT_CODE,
  assertPinnedClientVersion,
  parseReportedVersion,
  redactSecretsInText,
  redactTranscriptHeaders,
  summarizeJsonRpc,
  writeClaudeIsolatedConfig,
  writeCodexIsolatedConfig,
} from '../../../scripts/mcp-compat-real-clients.mjs';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/mcp-compat-real-clients.mjs',
);

function checkVersion(client, reported) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [
        scriptPath,
        'check-version',
        `--client=${client}`,
        `--reported=${reported}`,
      ], { encoding: 'utf8' }),
    };
  } catch (error) {
    return {
      status: error.status,
      stderr: String(error.stderr ?? error.message),
    };
  }
}

test('wrapper pins Codex 0.150.1 and Claude Code 2.1.250 only', () => {
  assert.equal(PINNED_CODEX_VERSION, '0.150.1');
  assert.equal(PINNED_CLAUDE_VERSION, '2.1.250');
  assert.equal(PINNED_CLIENTS.codex.npmSpec, '@openai/codex@0.150.1');
  assert.equal(PINNED_CLIENTS.codex.githubTag, 'rust-v0.150.1');
  assert.equal(PINNED_CLIENTS.claude.npmSpec, '@anthropic-ai/claude-code@2.1.250');
  assert.equal(MCP_COMPAT_PATH, '/collections/-/mcp-compat');
});

test('wrapper refuses Codex and Claude versions that are not the T-09 pins', () => {
  assert.equal(parseReportedVersion('codex-cli 0.150.1'), '0.150.1');
  assert.equal(parseReportedVersion('2.1.250 (Claude Code)'), '2.1.250');
  assert.equal(assertPinnedClientVersion('codex', 'codex-cli 0.150.1'), '0.150.1');
  assert.equal(assertPinnedClientVersion('claude', '2.1.250 (Claude Code)'), '2.1.250');
  assert.throws(
    () => assertPinnedClientVersion('codex', 'codex-cli 0.150.2'),
    /REFUSED: Codex CLI reported 0\.150\.2; required exact 0\.150\.1/u,
  );
  assert.throws(
    () => assertPinnedClientVersion('codex', 'codex-cli 0.149.1'),
    /REFUSED/u,
  );
  assert.throws(
    () => assertPinnedClientVersion('claude', '2.1.251 (Claude Code)'),
    /REFUSED: Claude Code reported 2\.1\.251; required exact 2\.1\.250/u,
  );
  assert.throws(
    () => assertPinnedClientVersion('codex', ''),
    /REFUSED: Codex CLI reported \(none\)/u,
  );
  const close = checkVersion('codex', 'codex-cli 0.150.10');
  assert.equal(close.status, REFUSE_EXIT_CODE);
  assert.match(close.stderr, /REFUSED/u);
  const ok = checkVersion('claude', '2.1.250');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /"ok": true/u);
});

test('inventory of a fake non-pinned binary exits refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'known-t09-fake-'));
  const fake = join(dir, 'codex');
  writeFileSync(fake, '#!/bin/sh\necho codex-cli 9.9.9\n');
  chmodSync(fake, 0o755);
  try {
    execFileSync(process.execPath, [
      scriptPath,
      'inventory',
      '--client=codex',
      `--bin=${fake}`,
    ], { encoding: 'utf8' });
    assert.fail('expected refuse');
  } catch (error) {
    assert.equal(error.status, REFUSE_EXIT_CODE);
    assert.match(String(error.stderr), /required exact 0\.150\.1/u);
  }
});

test('isolated configs point only at the given URL and contain no tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'known-t09-cfg-'));
  const url = 'http://127.0.0.1:3456/collections/-/mcp-compat';
  const codex = writeCodexIsolatedConfig(join(dir, 'codex'), url);
  const claude = writeClaudeIsolatedConfig(join(dir, 'claude'), url);
  const toml = readFileSync(codex.configPath, 'utf8');
  const json = readFileSync(claude.configPath, 'utf8');
  assert.match(toml, /\[mcp_servers\.known_compat\]/u);
  assert.match(toml, /url = "http:\/\/127\.0\.0\.1:3456\/collections\/-\/mcp-compat"/u);
  assert.doesNotMatch(toml, /Bearer |eyJ|client_secret|refresh_token/u);
  assert.doesNotMatch(toml, /mcp_2026_07_28\s*=/u);
  const parsed = JSON.parse(json);
  assert.equal(parsed.mcpServers['known-compat'].type, 'http');
  assert.equal(parsed.mcpServers['known-compat'].url, url);
  const user = JSON.parse(readFileSync(claude.userConfigPath, 'utf8'));
  assert.equal(user.mcpServers['known-compat'].url, url);
  assert.doesNotMatch(json, /Bearer |eyJ|Authorization/u);
});

test('transcript redaction strips Authorization and JWTs', () => {
  const headers = redactTranscriptHeaders({
    authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb',
    'mcp-protocol-version': '2025-11-25',
    'content-type': 'application/json',
  });
  assert.equal(headers.authorization, '[REDACTED]');
  assert.equal(headers['mcp-protocol-version'], '2025-11-25');
  const summary = summarizeJsonRpc(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  }));
  assert.equal(summary.method, 'initialize');
  assert.equal(summary.protocolVersion, '2025-06-18');
  const sse = summarizeJsonRpc(
    'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25"}}\n\n',
  );
  assert.equal(sse.protocolVersion, '2025-11-25');
  assert.equal(sse.transport, 'sse');
  assert.match(
    redactSecretsInText('{"client_secret":"abc","refresh_token":"def"}'),
    /"client_secret":"\[REDACTED\]"/u,
  );
});

test('recommendedClients stays empty until a pinned binary actually passes T-09', () => {
  assert.deepEqual(MCP_COMPAT_RECOMMENDED_CLIENTS, []);
  assert.equal(Object.isFrozen(MCP_COMPAT_RECOMMENDED_CLIENTS), true);
});
