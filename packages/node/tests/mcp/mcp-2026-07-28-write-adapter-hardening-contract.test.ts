/**
 * COLP-MCP-13: Modern MCP 2026-07-28 Write adapter hardening (tests-first).
 *
 * Guards on the thin adapter layer: authenticated-binding enforcement,
 * server-minted `requestState` integrity (tamper / expiry / cross-principal /
 * malformed), `inputResponses` structural validation, secret redaction,
 * abort propagation, unknown-outcome rejection and Legacy-Session absence on
 * the new Write surface.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { McpWriteRequestAbortedError } from '../../src/mcp/write-tools.js';
import {
  normalizeMcp20260728Error,
  type Mcp20260728Result,
} from '../../src/mcp/2026-07-28/results.js';
import {
  anonymousContext,
  commitInput,
  harness,
  lowRiskDescriptor,
  planRequest,
  firstPlanResult,
} from './mcp-2026-07-28-write-adapter-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

function resultPlan(result: Mcp20260728Result): Readonly<Record<string, unknown>> {
  const plan = result.plan;
  expect(typeof plan).toBe('object');
  expect(plan).not.toBeNull();
  return plan as Readonly<Record<string, unknown>>;
}

describe('MCP 2026-07-28 Modern Write adapter — binding enforcement [evidence:mcp.mrtr-contract]', () => {
  it('rejects anonymous bindings on every write entry', async () => {
    const { adapter } = harness();
    const context = anonymousContext();
    for (const input of [
      { name: 'changes.plan', arguments: planRequest() },
      { name: 'changes.commit', arguments: commitInput('plan-anon', 'idem-anon') },
      { name: 'changes.cancel', arguments: { planId: 'plan-anon' } },
      { name: 'custom.write', arguments: { mode: 'private' } },
    ]) {
      const error = await adapter.callTool(context, input)
        .then(() => undefined, (caught: unknown) => caught);
      expect(error, input.name).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
      expect(error, input.name).toMatchObject({ data: { code: 'anonymous_write_forbidden' } });
    }
    const listError = await adapter.listTools(context, {})
      .then(() => undefined, (caught: unknown) => caught);
    // tools/list is a Read operation; the authenticated gate still applies for
    // consistency, but it must fail stably when the binding is anonymous.
    expect(listError).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  });
});

describe('MCP 2026-07-28 Modern Write adapter — requestState integrity [evidence:mcp.mrtr-contract]', () => {
  it('rejects a tampered requestState', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    // Deterministically invalidate the MAC by appending a known byte to the
    // minted state. A plain single-character substitution is not enough:
    // base64url decoding ignores the low bits of the final character, so
    // substituting e.g. `w`/`x`/`y`/`z` can decode to the same MAC bytes and
    // be silently accepted. Appending guarantees the MAC segment length and
    // bytes differ, so `invalid_request_state` must be raised.
    const tampered = `${state}A`;
    expect(tampered).not.toBe(state);

    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: tampered,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'invalid_request_state' } });
  });

  it('rejects an expired requestState after the configured TTL', async () => {
    let nowMs = 1_000;
    const { adapter, context } = harness({
      requestStateTtlSeconds: 60,
      requestStateClock: () => nowMs,
    });
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    nowMs = 1_000 + 61_000;

    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'request_state_expired' } });
  });

  it('rejects a requestState minted for a different principal (binding bound)', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    const otherContext = harness({ binding: authenticatedBinding({ principalId: 'other-principal' }) }).context;

    const error = await adapter.callTool(otherContext, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'request_state_binding_mismatch' } });
  });

  it('rejects a non-string requestState as malformed input', async () => {
    const { adapter, context } = harness();
    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: 42 as never,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  });

  it('rejects a requestState minted for a different method', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;
    // Reuse the changes.plan requestState on changes.commit -> method mismatch.
    const error = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId),
      requestState: first.requestState as string,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'request_state_mismatch' } });
  });
});

describe('MCP 2026-07-28 Modern Write adapter — inputResponses validation [evidence:mcp.mrtr-contract]', () => {
  it('accepts a retry without inputResponses', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const result = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
    });
    expect(result.resultType).toBe('input_required');
  });

  it('accepts an empty inputResponses map and ignores it', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const result = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
      inputResponses: {},
    });
    expect(result.resultType).toBe('input_required');
  });

  it('accepts well-formed elicit/roots/sampling inputResponses entries it did not request', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const result = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
      inputResponses: {
        approval: { action: 'accept', content: { ok: true } },
        roots: { roots: [] },
        sample: { role: 'assistant', content: { type: 'text', text: 'ok' } },
      },
    });
    expect(result.resultType).toBe('input_required');
    expect(resultPlan(result).planId).toBe(resultPlan(first).planId);
  });

  it('rejects malformed inputResponses entries', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
      inputResponses: { approval: { bogus: true } },
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'invalid_input_responses' } });
  });

  it('rejects a non-object inputResponses map', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
      inputResponses: 'nope' as never,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  });
});

describe('MCP 2026-07-28 Modern Write adapter — redaction / abort / output safety [evidence:mcp.mrtr-contract]', () => {
  it('never returns plaintext secrets through the Plan/Commit key redaction path', async () => {
    const secretValue = 'colp_live_adapter_secret';
    const revealUriForKey = vi.fn((keyId: string) =>
      `https://alice.example/collections/keys/${keyId}/reveal`);
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-adapter-key',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-adapter-key',
        cursor: 'cur-adapter-key',
        warnings: Object.freeze([]) as readonly [],
        transform: Object.freeze({
          keyId: 'key-adapter-1',
          secretAvailable: true,
          revealUri: 'https://alice.example/collections/keys/key-adapter-1/reveal',
          apiKey: secretValue,
        }),
      })]),
    };
    const { adapter, context } = harness({ executor, revealUriForKey });
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;
    await adapter.recordOutOfBandApproval(planId, context);

    const result = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-secret-1'),
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(secretValue);
    expect(json).not.toContain('"apiKey"');
    expect(normalizeMcp20260728Error(new Error('irrelevant'))).toEqual({
      code: -32603,
      message: 'Internal error',
    });
  });

  it('rejects a request aborted before the call with McpWriteRequestAbortedError', async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, context } = harness();
    const abortedContext = { ...context, abortSignal: controller.signal } as never;

    const error = await adapter.callTool(abortedContext, {
      name: 'changes.plan',
      arguments: planRequest(),
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpWriteRequestAbortedError);
    expect(error).toMatchObject({ code: 'request_aborted' });
    expect(normalizeMcp20260728Error(error)).toEqual({ code: -32603, message: 'Internal error' });
  });

  it('hides an aborted mid-flight write result', async () => {
    const controller = new AbortController();
    let resolveInvoke!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolvePromise) => { resolveInvoke = resolvePromise; });
    const invoke = vi.fn(() => pending);
    const { adapter, context } = harness({
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({ invoke }),
      },
    });
    const abortedContext = { ...context, abortSignal: controller.signal } as never;

    const operation = adapter.callTool(abortedContext, {
      name: 'custom.write',
      arguments: { mode: 'private' },
    });
    controller.abort();
    resolveInvoke({ ok: true });

    await expect(operation).rejects.toBeInstanceOf(McpWriteRequestAbortedError);
  });
});

describe('MCP 2026-07-28 Modern Write adapter — Legacy-Session absence [evidence:mcp.mrtr-contract]', () => {
  it('keeps Session identifiers and the internal Write Gateway out of the Modern Write surface', () => {
    const writeSource = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'src', 'mcp', '2026-07-28', 'write.ts'),
      'utf8',
    );
    expect(writeSource).not.toMatch(/\bsessionId\b/u);
    expect(writeSource).not.toMatch(/\bMcpSessionBinding\b/u);
    expect(writeSource).not.toMatch(/\bMcpPlanBinding\b/u);
    expect(writeSource).toMatch(/\bMcpAuthenticatedAuthorizationBinding\b/u);

    const mcpIndexSource = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'src', 'mcp', 'index.ts'),
      'utf8',
    );
    // The internal Write Gateway module stays internal; /mcp only re-exports
    // the Modern Write adapter through the versioned adapter module.
    expect(mcpIndexSource).not.toContain("from './write-tools.js'");
    expect(mcpIndexSource).not.toContain("from './write-mount.js'");
    expect(mcpIndexSource).not.toMatch(/\bMcpTrustedWriteRequestContext\b/u);
    expect(mcpIndexSource).not.toMatch(/\bsessionId\b/u);
  });
});


