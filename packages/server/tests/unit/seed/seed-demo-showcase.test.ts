import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import { seedCollectionId, seedNodeId } from '../../../src/infrastructure/seed/seed-opaque-id.js';
import {
  SEED_SHOWCASE_CLASSIFY_ACCEPTED_LEGACY,
  SEED_SHOWCASE_CLASSIFY_SKIPPED_LEGACY,
  SEED_SHOWCASE_EXPECTED_ROWS,
  SEED_SHOWCASE_EXPORT_JOB_IDS,
  SEED_SHOWCASE_FLAGSHIP_LEGACY,
  SEED_SHOWCASE_FLAGSHIP_NODE_001_LEGACY,
  SEED_SHOWCASE_ORGANIZE_PLAN_IDS,
  SEED_SHOWCASE_PUBLIC_ACTIVITY_EVENT_IDS,
  SEED_SHOWCASE_PUBLIC_ACTIVITY_IDS,
  SEED_SHOWCASE_REPLICA_FAILED_LEGACY,
  SEED_SHOWCASE_REPLICA_READY_LEGACY,
  SEED_SHOWCASE_RESTORE_RECEIPT_ID,
  SEED_SHOWCASE_TREE_VERSION_IDS,
  SEED_SHOWCASE_REPORT_EXPECTED_ROWS,
  SEED_SHOWCASE_REPORT_FLAGSHIP_LATEST_EDITION_ID,
  SEED_SHOWCASE_REPORT_FLAGSHIP_SERIES_ID,
  SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG,
  SEED_SHOWCASE_REPORT_PUBLIC_SLUGS,
  SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS,
  SEED_SHOWCASE_HIDDEN_COLLECTION_SLUG,
  SEED_SHOWCASE_DELISTED_COLLECTION_SLUG,
  seedDemoHiddenCollectionPath,
  seedDemoDelistedCollectionPath,
  seedDemoMyReportsPath,
  seedDemoOfficialCasesPath,
  seedDemoFlagshipCollectionId,
  seedDemoFlagshipNode001Id,
  seedDemoLibraryCollaboratorsPath,
  seedDemoLibraryEditorPath,
  seedDemoLibraryHistoryPath,
  seedDemoReaderPath,
  seedDemoReportIssuePath,
  seedDemoReportSeriesPath,
  seedPublicActivityRecheckKey,
  seedQuotedEtag,
} from '../../../src/infrastructure/seed/seed-demo-showcase.js';

const here = dirname(fileURLToPath(import.meta.url));
const frontendLocators = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'Known-Frontend',
  'web',
  'src',
  'lib',
  'seed-demo-locators.ts',
);
const dataSql = join(here, '..', '..', '..', 'seed', 'demo', 'data.sql');

describe('seed demo showcase locators', () => {
  test('flagship locators match seedOpaqueId and stay pinned in the frontend DemoHub module', () => {
    const collectionId = seedDemoFlagshipCollectionId();
    const nodeId = seedDemoFlagshipNode001Id();
    assert.equal(collectionId, seedCollectionId(SEED_SHOWCASE_FLAGSHIP_LEGACY));
    assert.equal(nodeId, seedNodeId(SEED_SHOWCASE_FLAGSHIP_NODE_001_LEGACY));
    assert.equal(collectionId, 'col-uQ8qw6gOg1ExVpqEEg');
    assert.equal(nodeId, 'nd-col-Lo7a4NCymz9jOHw');
    assert.equal(seedDemoLibraryEditorPath(), `/library/${collectionId}/edit`);
    assert.equal(seedDemoLibraryHistoryPath(), `/library/${collectionId}/history`);
    assert.equal(seedDemoLibraryCollaboratorsPath(), `/library/${collectionId}/collaborators`);
    assert.equal(
      seedDemoReaderPath(),
      `/read/${nodeId}?collectionId=${collectionId}&subjectType=node&slug=llm-learning-path`,
    );

    const locators = readFileSync(frontendLocators, 'utf8');
    assert.match(locators, new RegExp(collectionId, 'u'));
    assert.match(locators, new RegExp(nodeId, 'u'));
    assert.match(locators, /seedCollectionId\('col-u01-01'\)/u);
    assert.match(locators, /seedNodeId\('nd-col-u01-01-001'\)/u);
    assert.match(locators, /ai-weekly-field-notes/u);
    assert.match(locators, /seed-rpt-edition-ai-2026-36/u);
  });

  test('quoted etag and public-activity recheck key match read-path contracts', () => {
    assert.equal(seedQuotedEtag('seed-ver-01'), '"seed-ver-01"');
    assert.equal(seedQuotedEtag('seed-ver-01').length >= 3, true);
    assert.throws(() => seedQuotedEtag(''), /1\.\.254/u);

    const collectionId = seedCollectionId(SEED_SHOWCASE_FLAGSHIP_LEGACY);
    assert.equal(
      seedPublicActivityRecheckKey(collectionId),
      `publication.collection:${collectionId}`,
    );
    assert.throws(() => seedPublicActivityRecheckKey(''), /required/u);
  });

  test('data.sql Wave 14 inserts use the showcase ID prefixes and expected row counts', () => {
    const sql = readFileSync(dataSql, 'utf8');
    for (const id of SEED_SHOWCASE_EXPORT_JOB_IDS) assert.match(sql, new RegExp(id, 'u'));
    for (const id of SEED_SHOWCASE_ORGANIZE_PLAN_IDS) assert.match(sql, new RegExp(id, 'u'));
    for (const id of SEED_SHOWCASE_TREE_VERSION_IDS) assert.match(sql, new RegExp(id, 'u'));
    assert.match(sql, new RegExp(SEED_SHOWCASE_RESTORE_RECEIPT_ID, 'u'));
    for (const id of SEED_SHOWCASE_PUBLIC_ACTIVITY_IDS) assert.match(sql, new RegExp(id, 'u'));
    for (const id of SEED_SHOWCASE_PUBLIC_ACTIVITY_EVENT_IDS) assert.match(sql, new RegExp(id, 'u'));
    for (const id of SEED_SHOWCASE_CLASSIFY_SKIPPED_LEGACY) {
      assert.match(sql, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
    assert.match(sql, new RegExp(SEED_SHOWCASE_CLASSIFY_ACCEPTED_LEGACY.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    for (const id of [
      ...SEED_SHOWCASE_REPLICA_READY_LEGACY,
      ...SEED_SHOWCASE_REPLICA_FAILED_LEGACY,
    ]) {
      assert.match(sql, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }

    assert.match(sql, /INSERT INTO collection_export_jobs/u);
    assert.match(sql, /INSERT INTO collection_classify_inbox_decision/u);
    assert.match(sql, /INSERT INTO collection_organize_plans/u);
    assert.match(sql, /INSERT INTO collection_tree_versions/u);
    assert.match(sql, /INSERT INTO collection_version_restore_receipts/u);
    assert.match(sql, /INSERT INTO collection_readable_replicas/u);
    assert.match(sql, /INSERT INTO social_public_activity/u);
    assert.ok(!/INSERT\s+INTO\s+bookmark_icons\b/iu.test(sql));
    assert.ok(!/INSERT\s+INTO\s+collection_invite_deliveries\b/iu.test(sql));
    assert.ok(!/INSERT\s+INTO\s+sync_/iu.test(sql));

    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.collection_export_jobs, 3);
    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.collection_classify_inbox_decision, 3);
    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.collection_organize_plans, 2);
    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.collection_tree_versions, 3);
    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.collection_version_restore_receipts, 1);
    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.collection_readable_replicas, 4);
    assert.equal(SEED_SHOWCASE_EXPECTED_ROWS.social_public_activity, 6);
  });

  test('data.sql Wave 16 News Digest inserts use showcase slugs and expected row counts', () => {
    const sql = readFileSync(dataSql, 'utf8');
    assert.match(sql, new RegExp(SEED_SHOWCASE_REPORT_FLAGSHIP_SERIES_ID, 'u'));
    assert.match(sql, new RegExp(SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG, 'u'));
    assert.match(sql, new RegExp(SEED_SHOWCASE_REPORT_FLAGSHIP_LATEST_EDITION_ID, 'u'));
    for (const slug of SEED_SHOWCASE_REPORT_PUBLIC_SLUGS) {
      assert.match(sql, new RegExp(`'${slug}'`, 'u'));
    }
    assert.match(sql, /INSERT INTO digest_series/u);
    assert.match(sql, /INSERT INTO digest_editions/u);
    assert.match(sql, /INSERT INTO digest_follows/u);
    assert.ok(!/INSERT\s+INTO\s+digest_audit_events\b/iu.test(sql));
    assert.equal(seedDemoReportSeriesPath(), `/reports/${SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG}`);
    assert.equal(
      seedDemoReportIssuePath(),
      `/reports/${SEED_SHOWCASE_REPORT_FLAGSHIP_SLUG}/issues/${SEED_SHOWCASE_REPORT_FLAGSHIP_LATEST_EDITION_ID}`,
    );
    assert.equal(SEED_SHOWCASE_REPORT_EXPECTED_ROWS.digest_series, 8);
    assert.equal(SEED_SHOWCASE_REPORT_EXPECTED_ROWS.digest_editions, 33);
    assert.equal(SEED_SHOWCASE_REPORT_EXPECTED_ROWS.digest_members, 16);
    assert.equal(SEED_SHOWCASE_REPORT_EXPECTED_ROWS.digest_follows, 40);
    assert.equal(SEED_SHOWCASE_REPORT_EXPECTED_ROWS.digest_schedules, 3);
    assert.equal(SEED_SHOWCASE_REPORT_EXPECTED_ROWS.digest_runs, 6);
  });

  test('data.sql Wave 17 community and governance inserts use showcase prefixes and expected row counts', () => {
    const sql = readFileSync(dataSql, 'utf8');
    assert.match(sql, /INSERT INTO community_votes/u);
    assert.match(sql, /INSERT INTO community_vote_targets/u);
    assert.match(sql, /INSERT INTO community_comments/u);
    assert.match(sql, /INSERT INTO community_comment_curations/u);
    assert.match(sql, /INSERT INTO community_comment_settings/u);
    assert.match(sql, /INSERT INTO catalog_preferences/u);
    assert.match(sql, /INSERT INTO moderation_roles/u);
    assert.match(sql, /INSERT INTO moderation_cases/u);
    assert.match(sql, /INSERT INTO moderation_actions/u);
    assert.match(sql, /INSERT INTO moderation_appeals/u);
    assert.match(sql, /seed-cmt-01/u);
    assert.match(sql, /seed-cmt-30/u);
    assert.match(sql, /KnowNSeedLongComment/u);
    assert.match(sql, /seed-mod-case-01/u);
    assert.match(sql, /seed-mod-act-01/u);
    assert.match(sql, /seed-ntf-cr-01/u);
    assert.match(
      sql,
      /UPDATE notification_preferences\s+SET enabled = false,\s+state_revision = state_revision \+ 1,\s+updated_at = updated_at \+ interval '1 second'/u,
    );
    assert.match(sql, new RegExp(SEED_SHOWCASE_HIDDEN_COLLECTION_SLUG, 'u'));
    assert.match(sql, new RegExp(SEED_SHOWCASE_DELISTED_COLLECTION_SLUG, 'u'));
    assert.ok(!/INSERT\s+INTO\s+community_rank_snapshots\b/iu.test(sql));
    assert.ok(!/INSERT\s+INTO\s+community_rank_entries\b/iu.test(sql));
    assert.equal(seedDemoHiddenCollectionPath(), `/c/${SEED_SHOWCASE_HIDDEN_COLLECTION_SLUG}`);
    assert.equal(seedDemoDelistedCollectionPath(), `/c/${SEED_SHOWCASE_DELISTED_COLLECTION_SLUG}`);
    assert.equal(seedDemoMyReportsPath(), '/moderation/reports');
    assert.equal(seedDemoOfficialCasesPath(), '/admin/moderation/cases');
    assert.equal(SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS.community_votes, 96);
    assert.equal(SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS.community_vote_targets, 19);
    assert.equal(SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS.community_comments, 30);
    assert.equal(SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS.moderation_cases, 14);
    assert.equal(SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS.moderation_actions, 10);
    assert.equal(SEED_SHOWCASE_COMMUNITY_EXPECTED_ROWS.moderation_appeals, 3);
  });
});
