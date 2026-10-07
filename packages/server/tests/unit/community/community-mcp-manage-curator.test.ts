import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_CURATION_SCOPE,
  COMMUNITY_COMMENT_SETTINGS_SCOPE,
  type CommunityTarget,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME,
  COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME,
} from '../../../src/modules/mcp/community-mcp.js';
import {
  ACCOUNT,
  COLLECTION,
  COLLECTION_TARGET,
  COMMAND_ID,
  COMMENT_ETAG,
  NOW,
  STALE_CURATION_ETAG,
  STALE_SETTINGS_ETAG,
  SUBJECT,
  VIRTUAL_CURATION_ETAG,
  VIRTUAL_SETTINGS_ETAG,
  commentManagePorts,
  configureArgs,
  context,
  curateArgs,
  errorBody,
  port,
  structured,
} from './community-mcp-manage-helpers.js';

/* ——— known.community.comment.curate ——— */

test('known.community.comment.curate writes the overlay through the manage ports', async () => {
  const { ports, effects } = commentManagePorts({ canCurate: true });
  const tool = port({ manage: ports });
  const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME, curateArgs);
  const curation = structured(result) as {
    commentId: string; hidden: boolean; reason: string | null;
    revision: string; updatedAt: string;
  };
  assert.equal(result.isError, undefined);
  assert.deepEqual(curation, {
    commentId: 'comment-1', hidden: true, reason: 'spam',
    revision: '2', updatedAt: NOW.toISOString(),
  });

  // Curator authority and the stored overlay row both key on the context
  // subject/principal — never on argument fields.
  assert.equal(effects.lockedAccountId, ACCOUNT);
  assert.equal(effects.canCurateSubjectId, SUBJECT);
  assert.deepEqual(effects.claims, [
    { principalId: ACCOUNT, commandScope: COMMUNITY_COMMENT_CURATION_SCOPE, commandId: COMMAND_ID },
  ]);
  assert.deepEqual(effects.audits, [
    { eventType: 'community.comment_curation_updated', principalId: ACCOUNT },
  ]);
  assert.equal(effects.curationUpserts.length, 1);
  const stored = effects.curationUpserts[0]!;
  assert.equal(stored.commentId, 'comment-1');
  assert.equal(stored.hidden, true);
  assert.equal(stored.reason, 'spam');
  // The virtual default is revision '1'; the first stored row is 2.
  assert.equal(stored.revision, 2n);
  assert.equal(stored.updatedByAccountId, ACCOUNT);
  assert.equal(stored.updatedAt.getTime(), NOW.getTime());
});

test('known.community.comment.curate rejects authority, shape, and ETag violations', async () => {
  const tool = port({ manage: commentManagePorts({ canCurate: true }).ports });
  for (const [args, code] of [
    // The closed body is unwrapped before the path is examined.
    [{}, 'invalid_request'],
    [{ ...curateArgs, extra: 1 }, 'invalid_query'],
    [{ ...curateArgs, viewer: 'subject-owner' }, 'invalid_query'],
    [{ ...curateArgs, path: { commentId: 'bad id!' } }, 'invalid_request'],
    [{ path: curateArgs.path, commandId: COMMAND_ID, ifMatch: VIRTUAL_CURATION_ETAG }, 'invalid_request'],
    [{ ...curateArgs, body: { hidden: true } }, 'invalid_request'],
    [{ ...curateArgs, body: { reason: 'spam' } }, 'invalid_request'],
    [{ ...curateArgs, body: { hidden: 'yes', reason: 'spam' } }, 'invalid_request'],
    [{ ...curateArgs, body: { hidden: true, reason: '' } }, 'invalid_request'],
    [{ ...curateArgs, body: { hidden: true, reason: 'x'.repeat(1_001) } }, 'invalid_request'],
    [{ ...curateArgs, body: { ...curateArgs.body, extra: 1 } }, 'invalid_request'],
    [{ path: curateArgs.path, body: curateArgs.body, ifMatch: VIRTUAL_CURATION_ETAG }, 'invalid_request'],
    [{ ...curateArgs, commandId: COMMAND_ID.toUpperCase() }, 'invalid_request'],
    [{ path: curateArgs.path, body: curateArgs.body, commandId: COMMAND_ID }, 'invalid_request'],
    [{ ...curateArgs, ifMatch: 'not-an-etag' }, 'invalid_request'],
    // The curation tag is its own authority: comment/settings tags are
    // well-formed yet wrong, so the compare lands on 412.
    [{ ...curateArgs, ifMatch: STALE_CURATION_ETAG }, 'precondition_failed'],
    [{ ...curateArgs, ifMatch: COMMENT_ETAG }, 'precondition_failed'],
    [{ ...curateArgs, ifMatch: VIRTUAL_SETTINGS_ETAG }, 'precondition_failed'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME, args);
    assert.equal(errorBody(result).code, code, JSON.stringify(args));
  }

  // Authorship alone never curates: a non-curator subject is 403-shaped.
  const forbidden = port({ manage: commentManagePorts({ canCurate: false }).ports });
  assert.equal(errorBody(await forbidden.callTool(context(),
    COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME, curateArgs)).code, 'insufficient_permission');
  const missing = port({ manage: commentManagePorts({ canCurate: true, comment: null }).ports });
  assert.equal(errorBody(await missing.callTool(context(),
    COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME, curateArgs)).code, 'resource_not_found');
});

/* ——— known.community.comments.configure ——— */

test('known.community.comments.configure locks the area through the manage ports', async () => {
  const { ports, effects } = commentManagePorts({ canCurate: true });
  const tool = port({ manage: ports });
  const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME, configureArgs);
  const settings = structured(result) as {
    target: CommunityTarget; locked: boolean; reason: string | null;
    revision: string; updatedAt: string;
  };
  assert.equal(result.isError, undefined);
  assert.deepEqual(settings, {
    target: COLLECTION_TARGET, locked: true, reason: 'cleanup',
    revision: '2', updatedAt: NOW.toISOString(),
  });

  // Identity is the context subject/principal; the body carries only the
  // target + lock write, never an actor field.
  assert.equal(effects.lockedAccountId, ACCOUNT);
  assert.equal(effects.canCurateSubjectId, SUBJECT);
  assert.deepEqual(effects.claims, [
    { principalId: ACCOUNT, commandScope: COMMUNITY_COMMENT_SETTINGS_SCOPE, commandId: COMMAND_ID },
  ]);
  assert.deepEqual(effects.audits, [
    { eventType: 'community.comment_settings_updated', principalId: ACCOUNT },
  ]);
  assert.equal(effects.settingsUpserts.length, 1);
  const stored = effects.settingsUpserts[0]!;
  // The stored row keys the generation-independent target identity.
  assert.deepEqual(stored.target, {
    kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null,
  });
  assert.equal(stored.locked, true);
  assert.equal(stored.reason, 'cleanup');
  // The virtual default is revision '1'; the first stored row is 2.
  assert.equal(stored.revision, 2n);
  assert.equal(stored.updatedByAccountId, ACCOUNT);
  assert.equal(stored.updatedAt.getTime(), NOW.getTime());
});

test('known.community.comments.configure rejects authority, shape, and ETag violations', async () => {
  const tool = port({ manage: commentManagePorts({ canCurate: true }).ports });
  for (const [args, code] of [
    [{}, 'invalid_request'],
    [{ ...configureArgs, extra: 1 }, 'invalid_query'],
    // configure takes no path — the target rides in the closed body.
    [{ ...configureArgs, path: { commentId: 'comment-1' } }, 'invalid_query'],
    [{ ...configureArgs, actor: 'account-evil' }, 'invalid_query'],
    [{ ...configureArgs, body: 'x' }, 'invalid_request'],
    [{ body: { locked: true, reason: 'cleanup' }, commandId: COMMAND_ID, ifMatch: VIRTUAL_SETTINGS_ETAG }, 'invalid_request'],
    [{ body: { target: COLLECTION_TARGET, reason: 'cleanup' }, commandId: COMMAND_ID, ifMatch: VIRTUAL_SETTINGS_ETAG }, 'invalid_request'],
    [{ body: { target: COLLECTION_TARGET, locked: true }, commandId: COMMAND_ID, ifMatch: VIRTUAL_SETTINGS_ETAG }, 'invalid_request'],
    [{ ...configureArgs, body: { ...configureArgs.body, extra: 1 } }, 'invalid_request'],
    [{ ...configureArgs, body: { ...configureArgs.body, locked: 'yes' } }, 'invalid_request'],
    [{ ...configureArgs, body: { ...configureArgs.body, reason: '' } }, 'invalid_request'],
    [{ ...configureArgs, body: { ...configureArgs.body, target: { kind: 'collection', id: COLLECTION } } }, 'invalid_request'],
    [{ ...configureArgs, body: { ...configureArgs.body, target: { ...COLLECTION_TARGET, generation: 'gen-2' } } }, 'invalid_request'],
    [{ body: configureArgs.body, ifMatch: VIRTUAL_SETTINGS_ETAG }, 'invalid_request'],
    [{ ...configureArgs, commandId: 'not-a-uuid' }, 'invalid_request'],
    [{ body: configureArgs.body, commandId: COMMAND_ID }, 'invalid_request'],
    [{ ...configureArgs, ifMatch: 'not-an-etag' }, 'invalid_request'],
    // The settings tag is its own authority: comment/curation tags are
    // well-formed yet wrong, so the compare lands on 412.
    [{ ...configureArgs, ifMatch: STALE_SETTINGS_ETAG }, 'precondition_failed'],
    [{ ...configureArgs, ifMatch: COMMENT_ETAG }, 'precondition_failed'],
    [{ ...configureArgs, ifMatch: VIRTUAL_CURATION_ETAG }, 'precondition_failed'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME, args);
    assert.equal(errorBody(result).code, code, JSON.stringify(args));
  }

  const forbidden = port({ manage: commentManagePorts({ canCurate: false }).ports });
  assert.equal(errorBody(await forbidden.callTool(context(),
    COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME, configureArgs)).code, 'insufficient_permission');
  const concealed = port({ manage: commentManagePorts({ canCurate: true, resolvedNull: true }).ports });
  assert.equal(errorBody(await concealed.callTool(context(),
    COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME, configureArgs)).code, 'resource_not_found');
});
