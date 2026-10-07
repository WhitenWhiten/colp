import { createPostgresProductCommandReceiptPort } from '../../../src/infrastructure/database/product-command-receipt.js';
import { createCaptureLearning } from '../../../src/infrastructure/collections/capture-learning.js';
import { readCapturePreferenceEvidence } from '../../../src/infrastructure/collections/capture-memory.js';
import { createClassificationEvidencePort } from '../../../src/infrastructure/collections/classification-evidence-postgres.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createCaptureRuntime } from '../../../src/infrastructure/collections/capture-runtime.js';
import { createCaptureHistory } from '../../../src/infrastructure/collections/capture-history.js';
import { CAPTURE_POLICY_VERSION, CLASSIFICATION_POLICY } from '../../../src/modules/collections/index.js';
import type { CaptureFolderCalibration } from '../../../src/modules/collections/index.js';
import { seedCanonicalClassificationFixture } from '../../support/classification-database-fixture.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const calibration: CaptureFolderCalibration = { policyVersion: CAPTURE_POLICY_VERSION, providerId: 'cloudflare_jev',
  modelVersion: 'jev-1.13.0', promptVersion: CLASSIFICATION_POLICY.promptVersion, candidateVersion: CLASSIFICATION_POLICY.candidateVersion, threshold: 0.9,
  calibrationHash: 'a'.repeat(64), holdoutHash: 'b'.repeat(64), correct: 200, wrong: 0, provenance: 'human' };

describeWithPostgres('automatic capture decisions', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('automatic_capture'); await runMigrations(isolated.runtime.db, 'latest'); }, 120000);
  afterAll(async () => isolated?.close());
  async function fixture(approved = true, enabled = true, tagsEnabled = false, untagged = false) {
    // An untagged capture leaves the vocabulary's "AI" (from another bookmark) for the classifier to pick.
    const seed = untagged ? await seedCanonicalClassificationFixture(isolated.runtime, undefined, { nodeIds: [], tags: [], folderId: randomUUID() })
      : await seedCanonicalClassificationFixture(isolated.runtime);
    await sql`INSERT INTO bookmark_preferences(account_id, bookmark_insert_position, folders_first, revision, updated_at, capture_mode)
      VALUES (${seed.collectionId}, 'bottom', true, '1', now(), 'automatic')`.execute(isolated.runtime.db);
    const preview = { preview: vi.fn(async () => ({ kind: 'replay' as const, result: { status: 200,
      body: Buffer.from(JSON.stringify({ folder: { folderId: seed.folderId, decision: 'l1_root', confidence: 0.99 } })),
      stableHeaders: {}, mediaType: 'application/json', contractVersion: '1.0.0' } })) };
    const runtime = createCaptureRuntime(isolated.runtime.db, preview, { enabled, tagsEnabled, calibration: approved ? calibration : null,
      identity: { providerId: 'cloudflare_jev', model: 'typesafe/jev', modelVersion: 'jev-1.13.0' } });
    const actor = { principalId: seed.collectionId, subjectId: seed.ownerSubjectId };
    const input = { captureId: randomUUID(), nodeId: seed.nodeId, nodeEtag: '"r1"', policyVersion: CAPTURE_POLICY_VERSION,
      controlGeneration: 0, periodPoints: 10, billing: { priceVersion: 'fixture', maxPoints: 1 } };
    return { seed, preview, runtime, actor, input, commandId: randomUUID() };
  }
  test('without an approved calibration the classifier folder decision is still filed automatically', async () => {
    const f = await fixture(false);
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    expect(decision).toMatchObject({ status: 'suggested', suggestedParentId: f.seed.folderId });
    expect(f.runtime.capabilities().automaticFolderAvailable).toBe(true);
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    expect(applied).toMatchObject({ status: 'applied', parentId: f.seed.folderId });
  });
  test.each(['add', 'suggest'] as const)('tag mode %s adds or offers the classifier-selected tags with the folder', async mode => {
    const f = await fixture(false, true, true, true);
    f.preview.preview.mockResolvedValueOnce({ kind: 'replay', result: { status: 200, body: Buffer.from(JSON.stringify({
      folder: { folderId: f.seed.folderId, decision: 'l1_root', confidence: 0.99 },
      tags: { candidates: [{ tag: 'AI', noul: 0.9, selected: true }, { tag: 'ai', noul: 0.3, selected: false }], maxAutoTags: 3 } })),
      stableHeaders: {}, mediaType: 'application/json', contractVersion: '1.0.0' } });
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, { ...f.input, tagMode: mode }, 'request');
    expect(f.preview.preview).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ requested: { folder: true, tags: true } }) }));
    if (mode === 'suggest') expect(decision.suggestedTags).toEqual(['AI']); else expect(decision).not.toHaveProperty('suggestedTags');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    expect(applied).toMatchObject({ status: 'applied', parentId: f.seed.folderId, tags: mode === 'add' ? ['AI'] : [] });
    expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id', '=', f.seed.nodeId).executeTakeFirst())?.tags ?? [])
      .toEqual(mode === 'add' ? ['AI'] : []);
  });
  test('a capture without a tag mode, or with tags off, asks for no tags', async () => {
    for (const tagMode of [undefined, 'off'] as const) {
      const f = await fixture(false, true, true);
      await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, tagMode ? { ...f.input, tagMode } : f.input, 'request');
      expect(f.preview.preview).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ requested: { folder: true, tags: false } }) }));
    }
  });
  test('a disabled automatic-capture feature preserves the bookmark and spends no provider execution', async () => {
    const f = await fixture(false, false);
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    expect(decision).toMatchObject({ status: 'manual', reason: 'capture_policy_unavailable', parentId: null });
    expect(f.preview.preview).not.toHaveBeenCalled();
    expect((await isolated.runtime.db.selectFrom('nodes').select('parent_id').where('id', '=', f.seed.nodeId).executeTakeFirst())?.parent_id).toBe(f.seed.root);
  });
  test('replays one decision, applies through canonical CAS, and conceals other accounts', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    const replay = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'retry');
    expect(replay).toEqual(decision); expect(f.preview.preview).toHaveBeenCalledTimes(1);
    const command = randomUUID();
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, command, f.input.nodeEtag, 0);
    expect(applied).toMatchObject({ status: 'applied', parentId: f.seed.folderId });
    expect(await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, command, f.input.nodeEtag, 0)).toEqual(applied);
    expect(await f.runtime.get({ ...f.actor, principalId: 'other' }, f.seed.collectionId, decision.decisionId)).toBeNull();
    expect((await isolated.runtime.db.selectFrom('nodes').select('parent_id').where('id', '=', f.seed.nodeId).executeTakeFirst())?.parent_id).toBe(f.seed.folderId);
    const evidence = await isolated.runtime.db.selectFrom('collection_classification_evidence').selectAll().where('collection_id', '=', f.seed.collectionId).execute();
    expect(evidence).toHaveLength(0); // Automatic application never masquerades as explicit acceptance.
  });
  test('an intervening edit or changed control generation prevents late automatic moves', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    await expect(f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 1)).rejects.toMatchObject({ code: 'precondition_failed' });
    await sql`UPDATE nodes SET resource_revision='manual-new' WHERE id=${f.seed.nodeId}`.execute(isolated.runtime.db);
    await expect(f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0)).rejects.toMatchObject({ code: 'precondition_failed' });
  });
  test('Undo restores the original folder, retains the bookmark and replays the same receipt', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    const command = randomUUID();
    const undone = await f.runtime.undo(f.actor, f.seed.collectionId, decision.decisionId, command, applied.nodeEtag);
    expect(undone.parentId).toBe(f.seed.root); expect(undone.undoneAt).not.toBeNull();
    expect(await f.runtime.undo(f.actor, f.seed.collectionId, decision.decisionId, command, applied.nodeEtag)).toEqual(undone);
    expect((await isolated.runtime.db.selectFrom('nodes').select('deleted_at').where('id', '=', f.seed.nodeId).executeTakeFirst())?.deleted_at).toBeNull();
  });
  test('the account period cap includes other device intents before another execution starts', async () => {
    const f = await fixture();
    const input = { ...f.input, periodPoints: 1 };
    await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, input, 'request');
    const limited = await f.runtime.classify(f.actor, f.seed.collectionId, randomUUID(),
      { ...input, captureId: randomUUID(), nodeId: f.seed.otherNodeId }, 'second-device');
    expect(limited.reason).toBe('period_credit_limit'); expect(f.preview.preview).toHaveBeenCalledTimes(1);
  });
  test('explicit corrections can remove tags, preserve command receipts, and fence old Undo', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    const command = randomUUID(), selection = { parentId: f.seed.root, tags: ['manual'] };
    const corrected = await f.runtime.correct(f.actor, f.seed.collectionId, decision.decisionId, command, applied.nodeEtag, selection);
    expect(corrected).toMatchObject({ parentId: f.seed.root, tags: ['manual'], reason: 'classification_corrected' });
    expect(await f.runtime.correct(f.actor, f.seed.collectionId, decision.decisionId, command, applied.nodeEtag, selection)).toEqual(corrected);
    await expect(f.runtime.undo(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), applied.nodeEtag)).rejects.toMatchObject({ code: 'precondition_failed' });
  });
  test('feedback deduplicates events, uses monotonic CAS and never learns from timeout acceptance', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    const implicit = { eventId: randomUUID(), kind: 'implicit_positive' as const, nodeRevision: applied.nodeEtag,
      occurredAt: '2099-01-01T00:00:00Z', learningEligible: true, evidenceGeneration: 0 };
    const weak = await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, implicit);
    expect(weak).toMatchObject({ revision: 1, effectiveFeedback: 'implicit_positive', learningEligible: false });
    expect(await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, implicit)).toEqual(weak);
    const positive = { ...implicit, eventId: randomUUID(), kind: 'explicit_positive' as const, occurredAt: '2020-01-01T00:00:00Z' };
    expect(await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, positive)).toMatchObject({ revision: 2, effectiveFeedback: 'explicit_positive' });
    await expect(f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0,
      { ...implicit, eventId: randomUUID(), kind: 'explicit_negative' })).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 2,
      { ...implicit, eventId: randomUUID(), kind: 'withdrawn' })).toMatchObject({ revision: 3, effectiveFeedback: null });
    expect(await isolated.runtime.db.selectFrom('bookmark_capture_feedback').select('event_id').where('decision_id', '=', decision.decisionId).execute()).toHaveLength(3);
  });
  test('tag-only correction records its actual delta; no-op submissions do not create evidence', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    const selection = { parentId: f.seed.folderId, tags: ['chosen'], learningEligible: true, evidenceGeneration: 0 };
    const corrected = await f.runtime.correct(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), applied.nodeEtag, selection);
    const event = await isolated.runtime.db.selectFrom('bookmark_capture_feedback').selectAll().where('decision_id', '=', decision.decisionId).executeTakeFirstOrThrow();
    expect(event).toMatchObject({ kind: 'correction_applied', learning_eligible: true,
      correction_json: { beforeParentId: f.seed.folderId, afterParentId: f.seed.folderId, afterTags: ['chosen'] } });
    await f.runtime.correct(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), corrected.nodeEtag, selection);
    expect(await isolated.runtime.db.selectFrom('bookmark_capture_feedback').select('event_id').where('decision_id', '=', decision.decisionId).execute()).toHaveLength(1);
  });
  test('learning disabled at ingestion stays ineligible on replay after re-enabling', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    await isolated.runtime.db.updateTable('bookmark_preferences').set({ learn_from_corrections: false }).where('account_id', '=', f.actor.principalId).execute();
    const event = { eventId: randomUUID(), kind: 'explicit_positive' as const, nodeRevision: applied.nodeEtag,
      occurredAt: new Date().toISOString(), learningEligible: true, evidenceGeneration: 0 };
    expect((await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, event)).learningEligible).toBe(false);
    await isolated.runtime.db.updateTable('bookmark_preferences').set({ learn_from_corrections: true }).where('account_id', '=', f.actor.principalId).execute();
    expect((await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, event)).learningEligible).toBe(false);
  });
  test('history deduplicates reported tasks and derives cloud application from server receipts', async () => {
    const f = await fixture(), history = createCaptureHistory(isolated.runtime.db), started = Date.now() - 1000;
    const report = { captureId: f.input.captureId, deviceId: randomUUID(), collectionId: f.seed.collectionId, nodeId: f.seed.nodeId,
      revision: 1, startedAt: new Date(started).toISOString(), title: 'History page', url: 'https://example.org/ai', localPath: ['Browser', 'Folder'],
      source: 'action-popup' as const, disposition: 'new' as const, save: 'local-saved' as const, automaticIntent: true, sync: 'confirmed' as const, reason: null };
    const command = randomUUID(), query = { from: started - 1000, to: Date.now() + 1000, timezone: 'UTC' };
    expect(await history.report(f.actor, command, report)).toEqual({ captureId: report.captureId, revision: 1 });
    expect(await history.report(f.actor, command, report)).toEqual({ captureId: report.captureId, revision: 1 });
    expect((await history.aggregate(f.actor, query)).counts).toMatchObject({ total: 1, saved: 1, automaticApplied: 0 });
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'request');
    await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    expect((await history.aggregate(f.actor, query)).counts).toMatchObject({ total: 1, saved: 1, automaticApplied: 1 });
    expect((await history.history(f.actor, { ...query, q: 'history' })).items).toHaveLength(1);
    expect((await history.history({ ...f.actor, principalId: 'other', subjectId: 'other' }, query)).items).toEqual([]);
    await history.report(f.actor, randomUUID(), { ...report, revision: 2, reason: 'offline' });
    await history.report(f.actor, randomUUID(), report);
    expect((await history.history(f.actor, query)).items[0]?.report.revision).toBe(2);
  });
  test('retention removes old display data while preserving unfinished recovery facts', async () => {
    const f = await fixture(), history = createCaptureHistory(isolated.runtime.db), started = Date.now() - 200 * 86400000;
    const report = { captureId: randomUUID(), deviceId: randomUUID(), collectionId: f.seed.collectionId, nodeId: f.seed.nodeId,
      revision: 1, startedAt: new Date(started).toISOString(), title: 'Expired detail', url: 'https://private.example/old', localPath: ['Private folder'],
      source: 'manual-popup' as const, disposition: 'new' as const, save: 'local-saved' as const, automaticIntent: false, sync: 'confirmed' as const, reason: null };
    await history.report(f.actor, randomUUID(), report);
    const pendingId = randomUUID(); await history.report(f.actor, randomUUID(), { ...report, captureId: pendingId, save: 'unknown' });
    await history.prune!();
    const settled = await isolated.runtime.db.selectFrom('bookmark_capture_tasks').selectAll().where('capture_id', '=', report.captureId).executeTakeFirstOrThrow();
    expect(settled.report_json).toMatchObject({ title: '', url: '', localPath: [] });
    const pending = await isolated.runtime.db.selectFrom('bookmark_capture_tasks').selectAll().where('capture_id', '=', pendingId).executeTakeFirstOrThrow();
    expect(pending.report_json.url).toBe(report.url);
  });
  test('memory uses explicit directory facts, clears by generation and preserves bookmarks and history', async () => {
    const f = await fixture(), learning = createCaptureLearning(isolated.runtime.db, false);
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'memory');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    const event = { eventId: randomUUID(), kind: 'explicit_positive' as const, nodeRevision: applied.nodeEtag,
      occurredAt: new Date().toISOString(), learningEligible: true, evidenceGeneration: 0 };
    await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, event);
    const read = () => isolated.runtime.db.transaction().execute(tx => readCapturePreferenceEvidence(tx,
      { accountId: f.actor.principalId, collectionId: f.seed.collectionId, ownerSubjectId: f.actor.subjectId, url: 'https://example.org/new' }));
    expect(await read()).toMatchObject([{ folderId: f.seed.folderId, positive: 1, negative: 0 }]);
    expect((await learning.get(f.actor)).records).toHaveLength(1);
    const command = randomUUID(), cleared = await learning.clear(f.actor, command, 0);
    expect(cleared.generation).toBe(1); expect(await learning.clear(f.actor, command, 0)).toEqual(cleared);
    await expect(learning.clear(f.actor, randomUUID(), 0)).rejects.toMatchObject({ code: 'precondition_failed' });
    await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 0, event);
    expect(await read()).toEqual([]); expect((await learning.get(f.actor)).records).toEqual([]);
    expect(await f.runtime.get(f.actor, f.seed.collectionId, decision.decisionId)).not.toBeNull();
    expect((await isolated.runtime.db.selectFrom('nodes').select('deleted_at').where('id', '=', f.seed.nodeId).executeTakeFirst())?.deleted_at).toBeNull();
    await f.runtime.feedback(f.actor, f.seed.collectionId, decision.decisionId, 1, { ...event, eventId: randomUUID() });
    expect(await read()).toEqual([]); // A delayed pre-clear device cannot repopulate memory.
  });
  test('tag-only corrections contribute no folder evidence and disabled memory is empty', async () => {
    const f = await fixture(), learning = createCaptureLearning(isolated.runtime.db, false);
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'tag-memory');
    const applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0);
    await f.runtime.correct(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), applied.nodeEtag,
      { parentId: f.seed.folderId, tags: ['chosen'], learningEligible: true, evidenceGeneration: 0 });
    const read = () => isolated.runtime.db.transaction().execute(tx => readCapturePreferenceEvidence(tx,
      { accountId: f.actor.principalId, collectionId: f.seed.collectionId, ownerSubjectId: f.actor.subjectId, url: 'https://example.org/new' }));
    expect(await read()).toEqual([]);
    await isolated.runtime.db.updateTable('bookmark_preferences').set({ learn_from_corrections: false }).where('account_id', '=', f.actor.principalId).execute();
    expect(await learning.get(f.actor)).toMatchObject({ enabled: false, records: [] }); expect(await read()).toEqual([]);
  });
  test('cleared legacy evidence cannot revive when its original command is replayed', async () => {
    const f = await fixture(), learning = createCaptureLearning(isolated.runtime.db, false);
    const input = { collectionId: f.seed.collectionId, ownerSubjectId: f.actor.subjectId, nodeId: f.seed.nodeId,
      source: 'classify_accept' as const, commandId: randomUUID(), folderId: f.seed.root, addTags: [], taxonomyRevision: 'c1' };
    const append = () => isolated.runtime.db.transaction().execute(tx => createClassificationEvidencePort(tx).append(input));
    await append();
    expect(await isolated.runtime.db.selectFrom('collection_classification_evidence').select('evidence_id').where('collection_id', '=', f.seed.collectionId).execute()).toHaveLength(1);
    await learning.clear(f.actor, randomUUID(), 0); await append();
    expect(await isolated.runtime.db.selectFrom('collection_classification_evidence').select('evidence_id').where('collection_id', '=', f.seed.collectionId).execute()).toHaveLength(0);
  });

  test('approved test-only prior changes the primary suggestion for exact ties through the real runtime', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const seed = await seedCanonicalClassificationFixture(isolated.runtime, undefined, { nodeIds: ids, tags: [], folderId: randomUUID() });
    const actor = { principalId: seed.collectionId, subjectId: seed.ownerSubjectId };
    await sql`INSERT INTO bookmark_preferences(account_id,bookmark_insert_position,folders_first,revision,updated_at,capture_mode)
      VALUES (${actor.principalId},'bottom',true,'1',now(),'automatic')`.execute(isolated.runtime.db);
    // Add a competing root-level folder in this isolated taxonomy; no application is performed by this fixture.
    const competitor = `deep-${seed.collectionId}`;
    await sql`UPDATE nodes SET parent_id=${seed.root},position_token='D' WHERE id=${competitor}`.execute(isolated.runtime.db);
    await sql`UPDATE nodes SET parent_id=${seed.folderId} WHERE id=ANY(${ids}::text[])`.execute(isolated.runtime.db);
    for (const id of ids) await isolated.runtime.db.transaction().execute(tx => createClassificationEvidencePort(tx).append({
      ownerSubjectId: actor.subjectId, collectionId: seed.collectionId, nodeId: id, folderId: seed.folderId,
      source: 'classify_accept', commandId: randomUUID(), addTags: [], taxonomyRevision: 'c1' }));
    const preview = { preview: vi.fn(async () => ({ kind: 'replay' as const, result: { status: 200, stableHeaders: {},
      mediaType: 'application/json', contractVersion: '1.0.0', body: Buffer.from(JSON.stringify({ folder: {
        folderId: competitor, decision: 'l1_root', confidence: 0.99,
        probabilities: [{ folderId: competitor, probability: 0.5 }, { folderId: seed.folderId, probability: 0.5 }],
      } })) } })) };
    const runtime = createCaptureRuntime(isolated.runtime.db, preview, { enabled: true, calibration, priorEnabled: true,
      identity: { providerId: 'cloudflare_jev', model: 'typesafe/jev', modelVersion: 'jev-1.13.0' },
      priorEvaluation: { policyVersion: 'capture-explicit-tie.v1', provenance: 'explicit_user_commands',
        holdoutHash: 'c'.repeat(64), registrationHash: 'd'.repeat(64), pages: 200, baseErrors: 20, personalizedErrors: 10,
        ties: 20, correctedTies: 10, providerId: 'cloudflare_jev', modelVersion: 'jev-1.13.0', promptVersion: CLASSIFICATION_POLICY.promptVersion,
        candidateVersion: CLASSIFICATION_POLICY.candidateVersion, pairedPValue: 0.01, laterToFolderIncreasePp: 0, collectionIsolationVerified: true } });
    const decision = await runtime.classify(actor, seed.collectionId, randomUUID(), { captureId: randomUUID(), nodeId: seed.nodeId,
      nodeEtag: '"r1"', policyVersion: CAPTURE_POLICY_VERSION, controlGeneration: 0, periodPoints: 10,
      billing: { priceVersion: 'fixture', maxPoints: 1 } }, 'tie');
    expect(decision).toMatchObject({ suggestedParentId: seed.folderId, explanation: { kind: 'exact_score_tie', pages: 5 } });
    expect(preview.preview).toHaveBeenCalledTimes(1);
    await isolated.runtime.db.updateTable('bookmark_preferences').set({ learn_from_corrections: false }).where('account_id', '=', actor.principalId).execute();
    await expect(runtime.apply(actor, seed.collectionId, decision.decisionId, randomUUID(), '"r1"', 0)).rejects.toMatchObject({ code: 'precondition_failed' });
    await isolated.runtime.db.updateTable('bookmark_preferences').set({ learn_from_corrections: true }).where('account_id', '=', actor.principalId).execute();
    await createCaptureLearning(isolated.runtime.db, false).clear(actor, randomUUID(), 0);
    await expect(runtime.apply(actor, seed.collectionId, decision.decisionId, randomUUID(), '"r1"', 0)).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  test('reads a lost classification receipt without invoking the provider, then applies explicitly in manual mode', async () => {
    const f = await fixture();
    const decision = await f.runtime.classify(f.actor, f.seed.collectionId, f.commandId, f.input, 'lost-return');
    const stored = await isolated.runtime.db.selectFrom('bookmark_capture_decisions').selectAll().where('id', '=', decision.decisionId).executeTakeFirstOrThrow();
    await isolated.runtime.db.transaction().execute(async tx => {
      const receipts = createPostgresProductCommandReceiptPort(tx), binding = { principalId: f.actor.principalId,
        commandScope: 'collections:classification-preview:v1', commandId: stored.execution_command_id };
      await receipts.claim(binding, 'fixture');
      await receipts.complete(binding, 'fixture', { status: 200, body: Buffer.from(JSON.stringify({ folder: {
        folderId: f.seed.folderId, decision: 'l1_root', confidence: 0.99 } })), stableHeaders: {}, mediaType: 'application/json', contractVersion: '1.0.0' });
    });
    await isolated.runtime.db.updateTable('bookmark_capture_decisions').set({ status: 'running', suggestion_json: null }).where('id', '=', decision.decisionId).execute();
    const found = await f.runtime.find(f.actor, f.seed.collectionId, f.input.captureId);
    expect(found).toMatchObject({ status: 'suggested', suggestedParentId: f.seed.folderId });
    expect(found?.suggestedPath).toEqual(['中文库', '技术']);
    expect(await f.runtime.find({ ...f.actor, principalId: 'other' }, f.seed.collectionId, f.input.captureId)).toBeNull();
    expect(await f.runtime.find(f.actor, f.seed.collectionId, randomUUID())).toBeNull();
    expect(f.preview.preview).toHaveBeenCalledTimes(1);
    await isolated.runtime.db.updateTable('bookmark_preferences').set({ capture_mode: 'manual' }).where('account_id', '=', f.actor.principalId).execute();
    await expect(f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, randomUUID(), f.input.nodeEtag, 0)).rejects.toMatchObject({ code: 'precondition_failed' });
    const command = randomUUID(), applied = await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, command, f.input.nodeEtag, 0, true);
    expect(applied).toMatchObject({ status: 'applied', automaticApplied: false, reason: 'suggestion_applied_explicitly' });
    expect(await f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, command, f.input.nodeEtag, 0, true)).toEqual(applied);
    await expect(f.runtime.apply(f.actor, f.seed.collectionId, decision.decisionId, command, f.input.nodeEtag, 0, false)).rejects.toMatchObject({ code: 'command_id_reused' });
    expect(f.preview.preview).toHaveBeenCalledTimes(1);
  });

});
