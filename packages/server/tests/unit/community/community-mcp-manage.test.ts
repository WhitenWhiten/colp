import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_DELETE_SCOPE,
  COMMUNITY_COMMENT_EDIT_SCOPE,
  COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME,
  COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME,
  COMMUNITY_MCP_TARGET_TOOL_NAME,
  COMMUNITY_MCP_VOTE_TOOL_NAME,
} from '../../../src/modules/mcp/community-mcp.js';
import {
  ACCOUNT,
  COMMAND_ID,
  COMMENT_ETAG,
  NOW,
  STALE_COMMENT_ETAG,
  VIRTUAL_CURATION_ETAG,
  VIRTUAL_SETTINGS_ETAG,
  commentManagePorts,
  configureArgs,
  context,
  curateArgs,
  deleteArgs,
  editArgs,
  errorBody,
  port,
  record,
  structured,
} from './community-mcp-manage-helpers.js';

/* ——— listing and scopes ——— */

test('manage tools list only when the manage port is composed; never anonymously', async () => {
  const manageToolNames = [
    COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME,
    COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME, COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME,
  ];
  const ready = await port({ manage: commentManagePorts().ports })
    .listTools(context(), undefined);
  assert.deepEqual(ready.map((tool) => tool.name).sort(),
    [...manageToolNames, COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME].sort());

  // No manage port composed: none of the four tools advertise, and a direct
  // call surfaces the not-configured product envelope, never a crash.
  const bare = port();
  assert.deepEqual((await bare.listTools(context(), undefined)).map((tool) => tool.name).sort(),
    [COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME].sort());
  const unconfigured = await bare.callTool(context(), COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs);
  assert.equal(errorBody(unconfigured).code, 'internal_error');

  // Write tools never list for anonymous callers or read-only bindings.
  for (const ctx of [
    context({ authenticated: false }),
    context({ scopes: ['product:read'] }),
  ]) {
    const names = (await port({ manage: commentManagePorts().ports }).listTools(ctx, undefined))
      .map((tool) => tool.name);
    assert.ok(!names.some((name) => manageToolNames.includes(name)), JSON.stringify(names));
    assert.ok(!names.includes(COMMUNITY_MCP_VOTE_TOOL_NAME));
  }

  const disabled = await port({ enabled: false, manage: commentManagePorts().ports })
    .listTools(context(), undefined);
  assert.deepEqual(disabled, []);
});

test('manage tools require an authenticated product:write binding', async () => {
  const tool = port({ manage: commentManagePorts().ports });
  const calls = [
    [COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs],
    [COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME, deleteArgs],
    [COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME, curateArgs],
    [COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME, configureArgs],
  ] as const;
  for (const ctx of [
    context({ authenticated: false }),
    context({ scopes: ['product:read'] }),
    context({ scopes: [] }),
  ]) {
    for (const [name, args] of calls) {
      const denied = await tool.callTool(ctx, name, args);
      assert.deepEqual(denied, { kind: 'rejected', stableCode: 'insufficient_scope',
        safeMessage: 'Insufficient scope.', retryable: false }, name);
    }
  }
});

/* ——— known.community.comment.edit ——— */

test('known.community.comment.edit reaches the manage ports with context identity', async () => {
  const { ports, effects } = commentManagePorts();
  const tool = port({ manage: ports });
  const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs);
  const edited = structured(result) as {
    id: string; body: string | null; state: string; revision: string;
    canEdit: boolean; canDelete: boolean; canCurate: boolean;
  };
  assert.equal(result.isError, undefined);
  assert.equal(edited.id, 'comment-1');
  assert.equal(edited.body, 'edited body');
  assert.equal(edited.state, 'visible');
  assert.equal(edited.revision, '2');
  assert.equal(edited.canEdit, true);
  assert.equal(edited.canDelete, true);
  assert.equal(edited.canCurate, false);

  // The actor came from the MCP context (account lock + receipt binding +
  // audit principal), never from tool arguments.
  assert.equal(effects.lockedAccountId, ACCOUNT);
  assert.deepEqual(effects.claims, [
    { principalId: ACCOUNT, commandScope: COMMUNITY_COMMENT_EDIT_SCOPE, commandId: COMMAND_ID },
  ]);
  assert.deepEqual(effects.audits, [
    { eventType: 'community.comment_edited', principalId: ACCOUNT },
  ]);
  // Argument mapping: path commentId, closed edit body, comment ETag CAS on
  // the locked row's durable revision.
  assert.equal(effects.updates.length, 1);
  assert.equal(effects.updates[0]!.commentId, 'comment-1');
  assert.equal(effects.updates[0]!.expectedRevision, 1n);
  assert.deepEqual(effects.updates[0]!.write, { body: 'edited body', state: 'visible' });
  assert.equal(effects.updates[0]!.updatedAt.getTime(), NOW.getTime());

  // Identity hints inside the arguments reject on the closed shapes.
  for (const [args, code] of [
    [{ ...editArgs, actor: 'account-evil' }, 'invalid_query'],
    [{ ...editArgs, viewer: 'account-evil' }, 'invalid_query'],
    [{ ...editArgs, principal: 'account-evil' }, 'invalid_query'],
    [{ ...editArgs, body: { ...editArgs.body, actor: 'account-evil' } }, 'invalid_request'],
    [{ ...editArgs, path: { ...editArgs.path, actor: 'account-evil' } }, 'invalid_query'],
  ] as const) {
    const rejected = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, args);
    assert.equal(errorBody(rejected).code, code, JSON.stringify(args));
  }
});

test('known.community.comment.edit rejects closed-shape, ETag, and domain violations', async () => {
  const tool = port({ manage: commentManagePorts().ports });
  for (const [args, code] of [
    [{}, 'invalid_query'],
    [{ path: 'comment-1' }, 'invalid_query'],
    [{ ...editArgs, extra: 1 }, 'invalid_query'],
    [{ ...editArgs, path: {} }, 'invalid_request'],
    [{ ...editArgs, path: { commentId: 'bad id!' } }, 'invalid_request'],
    [{ path: editArgs.path, commandId: COMMAND_ID, ifMatch: COMMENT_ETAG }, 'invalid_request'],
    [{ ...editArgs, body: 'edited body' }, 'invalid_request'],
    [{ ...editArgs, body: { body: '' } }, 'invalid_request'],
    [{ ...editArgs, body: { body: 'x'.repeat(4_001) } }, 'invalid_request'],
    [{ ...editArgs, body: { extra: 1 } }, 'invalid_request'],
    [{ path: editArgs.path, body: editArgs.body, commandId: COMMAND_ID }, 'invalid_request'],
    [{ ...editArgs, ifMatch: 'not-an-etag' }, 'invalid_request'],
    [{ ...editArgs, ifMatch: 'weak' }, 'invalid_request'],
    [{ path: editArgs.path, body: editArgs.body, ifMatch: COMMENT_ETAG }, 'invalid_request'],
    [{ ...editArgs, commandId: 'not-a-uuid' }, 'invalid_request'],
    [{ ...editArgs, commandId: COMMAND_ID.toUpperCase() }, 'invalid_request'],
    // A well-formed tag from the wrong authority or a stale revision is a
    // 412, never a 400 — the current tag travels for refresh_and_retry.
    [{ ...editArgs, ifMatch: STALE_COMMENT_ETAG }, 'precondition_failed'],
    [{ ...editArgs, ifMatch: VIRTUAL_CURATION_ETAG }, 'precondition_failed'],
    [{ ...editArgs, ifMatch: VIRTUAL_SETTINGS_ETAG }, 'precondition_failed'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, args);
    assert.equal(errorBody(result).code, code, JSON.stringify(args));
  }

  // Concealment and editability map to the same product codes as HTTP.
  const missing = port({ manage: commentManagePorts({ comment: null }).ports });
  assert.equal(errorBody(await missing.callTool(context(),
    COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs)).code, 'resource_not_found');
  const hidden = port({ manage: commentManagePorts({ comment: record({ curationHidden: true }) }).ports });
  assert.equal(errorBody(await hidden.callTool(context(),
    COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs)).code, 'invalid_request');
  const notAuthor = port({ manage: commentManagePorts({ comment: record({ authorAccountId: 'account-other' }) }).ports });
  assert.equal(errorBody(await notAuthor.callTool(context(),
    COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs)).code, 'insufficient_permission');
});

test('known.community.comment.edit maps receipt outcomes to product envelopes', async () => {
  const replay = {
    kind: 'replay' as const, status: 200,
    body: Buffer.from('{"id":"comment-1","state":"visible","revision":"2"}'),
    stableHeaders: { 'cache-control': 'private, no-store', etag: COMMENT_ETAG },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
  };
  for (const [claim, expected] of [
    [{ kind: 'replay' as const, result: replay }, 'id'],
    [{ kind: 'reused' as const }, 'command_id_reused'],
    [{ kind: 'in_progress' as const, retryAfterSeconds: 2 }, 'command_in_progress'],
    [{ kind: 'expired' as const, resultDigest: null }, 'command_result_expired'],
  ] as const) {
    const tool = port({ manage: commentManagePorts({ claim }).ports });
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME, editArgs);
    if (expected === 'id') {
      assert.equal((structured(result) as { id: string }).id, 'comment-1');
    } else {
      assert.equal(errorBody(result).code, expected);
    }
  }
});

/* ——— known.community.comment.delete ——— */

test('known.community.comment.delete tombstones through the manage ports with context identity', async () => {
  const { ports, effects } = commentManagePorts();
  const tool = port({ manage: ports });
  const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME, deleteArgs);
  const deleted = structured(result) as {
    id: string; body: string | null; state: string; revision: string;
    canEdit: boolean; canDelete: boolean;
  };
  assert.equal(result.isError, undefined);
  assert.equal(deleted.id, 'comment-1');
  // The tombstone never serves a body; the reply tree is untouched.
  assert.equal(deleted.body, null);
  assert.equal(deleted.state, 'deleted');
  assert.equal(deleted.revision, '2');
  assert.equal(deleted.canEdit, false);
  assert.equal(deleted.canDelete, false);

  assert.equal(effects.lockedAccountId, ACCOUNT);
  assert.deepEqual(effects.claims, [
    { principalId: ACCOUNT, commandScope: COMMUNITY_COMMENT_DELETE_SCOPE, commandId: COMMAND_ID },
  ]);
  assert.deepEqual(effects.audits, [
    { eventType: 'community.comment_deleted', principalId: ACCOUNT },
  ]);
  assert.equal(effects.updates.length, 1);
  assert.equal(effects.updates[0]!.commentId, 'comment-1');
  assert.equal(effects.updates[0]!.expectedRevision, 1n);
  assert.deepEqual(effects.updates[0]!.write, { body: null, state: 'deleted' });
});

test('known.community.comment.delete rejects closed-shape, ETag, and domain violations', async () => {
  const tool = port({ manage: commentManagePorts().ports });
  for (const [args, code] of [
    [{}, 'invalid_query'],
    [{ ...deleteArgs, extra: 1 }, 'invalid_query'],
    // delete takes no body — the closed argument shape rejects one.
    [{ ...deleteArgs, body: {} }, 'invalid_query'],
    [{ ...deleteArgs, actor: 'account-evil' }, 'invalid_query'],
    [{ ...deleteArgs, path: { commentId: 'bad id!' } }, 'invalid_request'],
    [{ path: deleteArgs.path, ifMatch: COMMENT_ETAG }, 'invalid_request'],
    [{ ...deleteArgs, commandId: 'not-a-uuid' }, 'invalid_request'],
    [{ path: deleteArgs.path, commandId: COMMAND_ID }, 'invalid_request'],
    [{ ...deleteArgs, ifMatch: 'not-an-etag' }, 'invalid_request'],
    [{ ...deleteArgs, ifMatch: STALE_COMMENT_ETAG }, 'precondition_failed'],
    [{ ...deleteArgs, ifMatch: VIRTUAL_CURATION_ETAG }, 'precondition_failed'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME, args);
    assert.equal(errorBody(result).code, code, JSON.stringify(args));
  }

  const missing = port({ manage: commentManagePorts({ comment: null }).ports });
  assert.equal(errorBody(await missing.callTool(context(),
    COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME, deleteArgs)).code, 'resource_not_found');
  const notAuthor = port({ manage: commentManagePorts({ comment: record({ authorAccountId: 'account-other' }) }).ports });
  assert.equal(errorBody(await notAuthor.callTool(context(),
    COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME, deleteArgs)).code, 'insufficient_permission');
  const alreadyDeleted = port({ manage: commentManagePorts({ comment: record({ state: 'deleted', body: null }) }).ports });
  assert.equal(errorBody(await alreadyDeleted.callTool(context(),
    COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME, deleteArgs)).code, 'invalid_request');
});
