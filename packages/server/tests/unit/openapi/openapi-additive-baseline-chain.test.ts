import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

function runNodeScript(script: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(backendRoot, script), ...args], { cwd: backendRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

test('immutable Product minor client baselines remain additive', async () => {
  const oldBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.2.0.yaml');
  const newBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.3.0.yaml');
  const latestBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.4.0.yaml');
  const readingProgressBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.5.0.yaml');
  const searchAuthorityBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.6.0.yaml');
  const searchProductBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.7.0.yaml');
  const ownedCollectionsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.8.0.yaml');
  const profileMutationBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.9.0.yaml');
  const syncCenterBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.10.0.yaml');
  const followBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.11.0.yaml');
  const feedBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.12.0.yaml');
  const notificationBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.13.0.yaml');
  const approvalBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.14.0.yaml');
  const attachmentBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.15.0.yaml');
  const insightsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.16.0.yaml');
  const dashboardBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.17.0.yaml');
  const collaborationBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.18.0.yaml');
  const sharedListBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.19.0.yaml');
  const bookmarkCountBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.20.0.yaml');
  const occupancyBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.21.0.yaml');
  const faviconBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.22.0.yaml');
  const exploreBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.23.0.yaml');
  const feedJoinBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.24.0.yaml');
  const inboxLocatorBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.25.0.yaml');
  const activityBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.26.0.yaml');
  const exploreSortBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.27.0.yaml');
  const linkHealthBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.28.0.yaml');
  const linkHealthChecksBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.29.0.yaml');
  const closedSummaryBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.30.0.yaml');
  const publicViewCountBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.31.0.yaml');
  const sharedLinkHealthBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.32.0.yaml');
  const exportJobsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.33.0.yaml');
  const membersCursorBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.34.0.yaml');
  const classifyInboxBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.35.0.yaml');
  const classifyInboxSkipBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.36.0.yaml');
  const classifyInboxAcceptBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.37.0.yaml');
  const organizePlansBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.38.0.yaml');
  const organizePlanApplyBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.39.0.yaml');
  const collectionVersionsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.40.0.yaml');
  const collectionVersionRestoreBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.41.0.yaml');
  const readableReplicaGetBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.42.0.yaml');
  const readableReplicaEnqueueBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.43.0.yaml');
  const memberAvatarBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.44.0.yaml');
  const collectionFollowBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.45.0.yaml');
  const followedCollectionsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.46.0.yaml');
  const followedAvailabilityBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.47.0.yaml');
  const libraryOrderBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.48.0.yaml');
  const publicReportsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.50.0.yaml');
  const reportsFollowBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.51.0.yaml');
  const reportsTimelineSafeBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.54.0.yaml');
  const reportsScheduleClosedBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.55.0.yaml');
  const reportsSourceSlugBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.56.0.yaml');
  const syncTrashBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.57.0.yaml');
  const syncTrashBatchBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.58.0.yaml');
  const linkHealthReviewBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.59.0.yaml');
  const publicNodeMarksBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.60.0.yaml');
  const curatorNoteBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.61.0.yaml');
  const preFaviconRevertBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.63.0.yaml');
  const faviconRevertBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.64.0.yaml');
  const receiptReplayBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.66.0.yaml');
  const digestTombstoneBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.67.0.yaml');
  const exploreTombstoneBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.68.0.yaml');
  const feedTombstoneBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.69.0.yaml');
  const credentialRestrictionBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.70.0.yaml');
  const classificationSettingsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.71.0.yaml');
  const classificationPreviewBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.72.0.yaml');
  const classificationChoicesBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.73.0.yaml');
  const classificationTagsBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.74.0.yaml');
  const product175Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.75.0.yaml');
  const product176Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.76.0.yaml');
  const product177Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.77.0.yaml');
  const classificationCreditPreviewBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.78.0.yaml');
  const classificationCreditRunBaseline = join(backendRoot, 'openapi/baselines/product-v1.1.79.0.yaml');
  const product180Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.80.0.yaml');
  const product181Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.81.0.yaml');
  const product182Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.82.0.yaml');
  const product183Baseline = join(backendRoot, 'openapi/baselines/product-v1.1.83.0.yaml');
  const oldClientAgainstNewServer = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', oldBaseline,
    '--candidate', newBaseline,
  ]);
  assert.equal(oldClientAgainstNewServer.status, 0, oldClientAgainstNewServer.stderr || oldClientAgainstNewServer.stdout);

  const previousClientAgainstLatest = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', newBaseline, '--candidate', latestBaseline,
  ]);
  assert.equal(previousClientAgainstLatest.status, 0, previousClientAgainstLatest.stderr || previousClientAgainstLatest.stdout);

  const savedResourceClientAgainstReadingProgress = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', latestBaseline, '--candidate', readingProgressBaseline,
  ]);
  assert.equal(savedResourceClientAgainstReadingProgress.status, 0,
    savedResourceClientAgainstReadingProgress.stderr || savedResourceClientAgainstReadingProgress.stdout);

  const readingProgressClientAgainstSearchAuthority = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', readingProgressBaseline, '--candidate', searchAuthorityBaseline,
  ]);
  assert.equal(readingProgressClientAgainstSearchAuthority.status, 0,
    readingProgressClientAgainstSearchAuthority.stderr || readingProgressClientAgainstSearchAuthority.stdout);

  const searchAuthorityClientAgainstSearchProduct = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', searchAuthorityBaseline, '--candidate', searchProductBaseline,
  ]);
  assert.equal(searchAuthorityClientAgainstSearchProduct.status, 0,
    searchAuthorityClientAgainstSearchProduct.stderr || searchAuthorityClientAgainstSearchProduct.stdout);

  const searchProductClientAgainstOwnedCollections = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', searchProductBaseline, '--candidate', ownedCollectionsBaseline,
  ]);
  assert.equal(searchProductClientAgainstOwnedCollections.status, 0,
    searchProductClientAgainstOwnedCollections.stderr || searchProductClientAgainstOwnedCollections.stdout);

  const ownedCollectionsClientAgainstProfileMutation = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', ownedCollectionsBaseline, '--candidate', profileMutationBaseline,
  ]);
  assert.equal(ownedCollectionsClientAgainstProfileMutation.status, 0,
    ownedCollectionsClientAgainstProfileMutation.stderr || ownedCollectionsClientAgainstProfileMutation.stdout);

  const syncCenterClientAgainstFollow = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', syncCenterBaseline, '--candidate', followBaseline,
  ]);
  assert.equal(syncCenterClientAgainstFollow.status, 0,
    syncCenterClientAgainstFollow.stderr || syncCenterClientAgainstFollow.stdout);

  const followClientAgainstFeed = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', followBaseline, '--candidate', feedBaseline,
  ]);
  assert.equal(followClientAgainstFeed.status, 0,
    followClientAgainstFeed.stderr || followClientAgainstFeed.stdout);

  const feedClientAgainstNotifications = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', feedBaseline, '--candidate', notificationBaseline,
  ]);
  assert.equal(feedClientAgainstNotifications.status, 0,
    feedClientAgainstNotifications.stderr || feedClientAgainstNotifications.stdout);

  const notificationClientAgainstApprovals = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', notificationBaseline, '--candidate', approvalBaseline,
  ]);
  assert.equal(notificationClientAgainstApprovals.status, 0,
    notificationClientAgainstApprovals.stderr || notificationClientAgainstApprovals.stdout);

  const approvalClientAgainstAttachments = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', approvalBaseline, '--candidate', attachmentBaseline,
  ]);
  assert.equal(approvalClientAgainstAttachments.status, 0,
    approvalClientAgainstAttachments.stderr || approvalClientAgainstAttachments.stdout);

  const attachmentClientAgainstInsights = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', attachmentBaseline, '--candidate', insightsBaseline,
  ]);
  assert.equal(attachmentClientAgainstInsights.status, 0,
    attachmentClientAgainstInsights.stderr || attachmentClientAgainstInsights.stdout);

  const insightsClientAgainstDashboard = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', insightsBaseline, '--candidate', dashboardBaseline,
  ]);
  assert.equal(insightsClientAgainstDashboard.status, 0,
    insightsClientAgainstDashboard.stderr || insightsClientAgainstDashboard.stdout);

  const dashboardClientAgainstCollaboration = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', dashboardBaseline, '--candidate', collaborationBaseline,
  ]);
  assert.equal(dashboardClientAgainstCollaboration.status, 0,
    dashboardClientAgainstCollaboration.stderr || dashboardClientAgainstCollaboration.stdout);

  const collaborationClientAgainstSharedList = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', collaborationBaseline, '--candidate', sharedListBaseline,
  ]);
  assert.equal(collaborationClientAgainstSharedList.status, 0,
    collaborationClientAgainstSharedList.stderr || collaborationClientAgainstSharedList.stdout);

  const sharedListClientAgainstBookmarkCount = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', sharedListBaseline, '--candidate', bookmarkCountBaseline,
  ]);
  assert.equal(sharedListClientAgainstBookmarkCount.status, 0,
    sharedListClientAgainstBookmarkCount.stderr || sharedListClientAgainstBookmarkCount.stdout);

  const bookmarkCountClientAgainstOccupancy = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', bookmarkCountBaseline, '--candidate', occupancyBaseline,
  ]);
  assert.equal(bookmarkCountClientAgainstOccupancy.status, 0,
    bookmarkCountClientAgainstOccupancy.stderr || bookmarkCountClientAgainstOccupancy.stdout);

  const occupancyClientAgainstFavicon = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', occupancyBaseline, '--candidate', faviconBaseline,
  ]);
  assert.equal(occupancyClientAgainstFavicon.status, 0,
    occupancyClientAgainstFavicon.stderr || occupancyClientAgainstFavicon.stdout);

  const faviconClientAgainstExplore = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', faviconBaseline, '--candidate', exploreBaseline,
  ]);
  assert.equal(faviconClientAgainstExplore.status, 0,
    faviconClientAgainstExplore.stderr || faviconClientAgainstExplore.stdout);

  const exploreClientAgainstFeedJoin = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', exploreBaseline, '--candidate', feedJoinBaseline,
  ]);
  assert.equal(exploreClientAgainstFeedJoin.status, 0,
    exploreClientAgainstFeedJoin.stderr || exploreClientAgainstFeedJoin.stdout);

  const feedJoinClientAgainstInboxLocators = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', feedJoinBaseline, '--candidate', inboxLocatorBaseline,
  ]);
  assert.equal(feedJoinClientAgainstInboxLocators.status, 0,
    feedJoinClientAgainstInboxLocators.stderr || feedJoinClientAgainstInboxLocators.stdout);

  const inboxLocatorClientAgainstActivity = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', inboxLocatorBaseline, '--candidate', activityBaseline,
  ]);
  assert.equal(inboxLocatorClientAgainstActivity.status, 0,
    inboxLocatorClientAgainstActivity.stderr || inboxLocatorClientAgainstActivity.stdout);

  const activityClientAgainstExploreSort = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', activityBaseline, '--candidate', exploreSortBaseline,
  ]);
  assert.equal(activityClientAgainstExploreSort.status, 0,
    activityClientAgainstExploreSort.stderr || activityClientAgainstExploreSort.stdout);

  const exploreSortClientAgainstLinkHealth = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', exploreSortBaseline, '--candidate', linkHealthBaseline,
  ]);
  assert.equal(exploreSortClientAgainstLinkHealth.status, 0,
    exploreSortClientAgainstLinkHealth.stderr || exploreSortClientAgainstLinkHealth.stdout);

  const linkHealthClientAgainstChecks = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', linkHealthBaseline, '--candidate', linkHealthChecksBaseline,
  ]);
  assert.equal(linkHealthClientAgainstChecks.status, 0,
    linkHealthClientAgainstChecks.stderr || linkHealthClientAgainstChecks.stdout);

  const linkHealthChecksClientAgainstClosedSummary = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', linkHealthChecksBaseline, '--candidate', closedSummaryBaseline,
  ]);
  assert.equal(linkHealthChecksClientAgainstClosedSummary.status, 0,
    linkHealthChecksClientAgainstClosedSummary.stderr || linkHealthChecksClientAgainstClosedSummary.stdout);

  const closedSummaryClientAgainstPublicViewCount = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', closedSummaryBaseline, '--candidate', publicViewCountBaseline,
  ]);
  assert.equal(closedSummaryClientAgainstPublicViewCount.status, 0,
    closedSummaryClientAgainstPublicViewCount.stderr || closedSummaryClientAgainstPublicViewCount.stdout);

  const publicViewCountClientAgainstSharedLinkHealth = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', publicViewCountBaseline, '--candidate', sharedLinkHealthBaseline,
  ]);
  assert.equal(publicViewCountClientAgainstSharedLinkHealth.status, 0,
    publicViewCountClientAgainstSharedLinkHealth.stderr || publicViewCountClientAgainstSharedLinkHealth.stdout);

  const sharedLinkHealthClientAgainstExportJobs = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', sharedLinkHealthBaseline, '--candidate', exportJobsBaseline,
  ]);
  assert.equal(sharedLinkHealthClientAgainstExportJobs.status, 0,
    sharedLinkHealthClientAgainstExportJobs.stderr || sharedLinkHealthClientAgainstExportJobs.stdout);

  const exportJobsClientAgainstMembersCursor = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', exportJobsBaseline, '--candidate', membersCursorBaseline,
  ]);
  assert.equal(exportJobsClientAgainstMembersCursor.status, 0,
    exportJobsClientAgainstMembersCursor.stderr || exportJobsClientAgainstMembersCursor.stdout);

  const membersCursorClientAgainstClassifyInbox = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', membersCursorBaseline, '--candidate', classifyInboxBaseline,
  ]);
  assert.equal(membersCursorClientAgainstClassifyInbox.status, 0,
    membersCursorClientAgainstClassifyInbox.stderr || membersCursorClientAgainstClassifyInbox.stdout);

  const classifyInboxClientAgainstSkip = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classifyInboxBaseline, '--candidate', classifyInboxSkipBaseline,
  ]);
  assert.equal(classifyInboxClientAgainstSkip.status, 0,
    classifyInboxClientAgainstSkip.stderr || classifyInboxClientAgainstSkip.stdout);

  const classifyInboxSkipClientAgainstAccept = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classifyInboxSkipBaseline, '--candidate', classifyInboxAcceptBaseline,
  ]);
  assert.equal(classifyInboxSkipClientAgainstAccept.status, 0,
    classifyInboxSkipClientAgainstAccept.stderr || classifyInboxSkipClientAgainstAccept.stdout);

  const classifyInboxAcceptClientAgainstOrganizePlans = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classifyInboxAcceptBaseline, '--candidate', organizePlansBaseline,
  ]);
  assert.equal(classifyInboxAcceptClientAgainstOrganizePlans.status, 0,
    classifyInboxAcceptClientAgainstOrganizePlans.stderr || classifyInboxAcceptClientAgainstOrganizePlans.stdout);

  const organizePlansClientAgainstApply = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', organizePlansBaseline, '--candidate', organizePlanApplyBaseline,
  ]);
  assert.equal(organizePlansClientAgainstApply.status, 0,
    organizePlansClientAgainstApply.stderr || organizePlansClientAgainstApply.stdout);

  const organizePlanApplyClientAgainstCollectionVersions = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', organizePlanApplyBaseline, '--candidate', collectionVersionsBaseline,
  ]);
  assert.equal(organizePlanApplyClientAgainstCollectionVersions.status, 0,
    organizePlanApplyClientAgainstCollectionVersions.stderr || organizePlanApplyClientAgainstCollectionVersions.stdout);

  const collectionVersionsClientAgainstRestore = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', collectionVersionsBaseline, '--candidate', collectionVersionRestoreBaseline,
  ]);
  assert.equal(collectionVersionsClientAgainstRestore.status, 0,
    collectionVersionsClientAgainstRestore.stderr || collectionVersionsClientAgainstRestore.stdout);

  const collectionVersionRestoreClientAgainstReadableReplica = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', collectionVersionRestoreBaseline, '--candidate', readableReplicaGetBaseline,
  ]);
  assert.equal(collectionVersionRestoreClientAgainstReadableReplica.status, 0,
    collectionVersionRestoreClientAgainstReadableReplica.stderr || collectionVersionRestoreClientAgainstReadableReplica.stdout);

  const readableReplicaGetClientAgainstEnqueue = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', readableReplicaGetBaseline, '--candidate', readableReplicaEnqueueBaseline,
  ]);
  assert.equal(readableReplicaGetClientAgainstEnqueue.status, 0,
    readableReplicaGetClientAgainstEnqueue.stderr || readableReplicaGetClientAgainstEnqueue.stdout);

  const readableReplicaEnqueueClientAgainstMemberAvatar = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', readableReplicaEnqueueBaseline, '--candidate', memberAvatarBaseline,
  ]);
  assert.equal(readableReplicaEnqueueClientAgainstMemberAvatar.status, 0,
    readableReplicaEnqueueClientAgainstMemberAvatar.stderr || readableReplicaEnqueueClientAgainstMemberAvatar.stdout);

  const memberAvatarClientAgainstCollectionFollow = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', memberAvatarBaseline, '--candidate', collectionFollowBaseline,
  ]);
  assert.equal(memberAvatarClientAgainstCollectionFollow.status, 0,
    memberAvatarClientAgainstCollectionFollow.stderr || memberAvatarClientAgainstCollectionFollow.stdout);

  const collectionFollowClientAgainstFollowedCollections = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', collectionFollowBaseline, '--candidate', followedCollectionsBaseline,
  ]);
  assert.equal(collectionFollowClientAgainstFollowedCollections.status, 0,
    collectionFollowClientAgainstFollowedCollections.stderr
    || collectionFollowClientAgainstFollowedCollections.stdout);

  const followedCollectionsClientAgainstAvailability = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', followedCollectionsBaseline, '--candidate', followedAvailabilityBaseline,
  ]);
  assert.equal(followedCollectionsClientAgainstAvailability.status, 0,
    followedCollectionsClientAgainstAvailability.stderr
    || followedCollectionsClientAgainstAvailability.stdout);

  const availabilityClientAgainstLibraryOrder = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', followedAvailabilityBaseline, '--candidate', libraryOrderBaseline,
  ]);
  assert.equal(availabilityClientAgainstLibraryOrder.status, 0,
    availabilityClientAgainstLibraryOrder.stderr
    || availabilityClientAgainstLibraryOrder.stdout);

  const publicReportsClientAgainstFollow = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', publicReportsBaseline, '--candidate', reportsFollowBaseline,
  ]);
  assert.equal(publicReportsClientAgainstFollow.status, 0,
    publicReportsClientAgainstFollow.stderr || publicReportsClientAgainstFollow.stdout);

  // 1.53.0 is the first corrected report compatibility snapshot: the earlier
  // 1.49–1.52 snapshots were generated while the feature was still gated and
  // omitted required CSRF/receipt/error headers. Do not bless those draft
  // shapes as an old-client contract; the current candidate must still match
  // the corrected immutable baseline byte-for-byte semantically. 1.55.0 is a
  // deliberate schema correction: 1.54.0's allOf response shape was not
  // valid with its closed request component, so it is retained as historical
  // evidence rather than treated as an additive client baseline.
  const timelineToScheduleCorrection = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', reportsTimelineSafeBaseline,
    '--candidate', reportsScheduleClosedBaseline,
  ]);
  assert.notEqual(timelineToScheduleCorrection.status, 0,
    'the closed schedule correction must not silently rewrite immutable 1.54.0');
  assert.match(
    timelineToScheduleCorrection.stderr + timelineToScheduleCorrection.stdout,
    /ReportSchedule/u,
  );
  // 1.56.0 is purely additive: the optional public source Collection slug on
  // report issues must not disturb the immutable 1.55.0 client contract.
  const scheduleClosedClientAgainstSourceSlug = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', reportsScheduleClosedBaseline,
    '--candidate', reportsSourceSlugBaseline,
  ]);
  assert.equal(scheduleClosedClientAgainstSourceSlug.status, 0,
    scheduleClosedClientAgainstSourceSlug.stderr || scheduleClosedClientAgainstSourceSlug.stdout);

  // 1.57.0 is purely additive: private Sync Center trash list/item/restore.
  const sourceSlugClientAgainstSyncTrash = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', reportsSourceSlugBaseline,
    '--candidate', syncTrashBaseline,
  ]);
  assert.equal(sourceSlugClientAgainstSyncTrash.status, 0,
    sourceSlugClientAgainstSyncTrash.stderr || sourceSlugClientAgainstSyncTrash.stdout);

  // 1.58.0 is purely additive: bulk restore, subtree restore, and empty-trash.
  const syncTrashClientAgainstBatch = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', syncTrashBaseline,
    '--candidate', syncTrashBatchBaseline,
  ]);
  assert.equal(syncTrashClientAgainstBatch.status, 0,
    syncTrashClientAgainstBatch.stderr || syncTrashClientAgainstBatch.stdout);

  // 1.59.0 is purely additive: optional link-health errorClass and private
  // duplicate_of review fields on LinkHealthItem.
  const batchClientAgainstReview = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', syncTrashBatchBaseline,
    '--candidate', linkHealthReviewBaseline,
  ]);
  assert.equal(batchClientAgainstReview.status, 0,
    batchClientAgainstReview.stderr || batchClientAgainstReview.stdout);

  // 1.60.0 is purely additive: optional PublicCollectionNode tldr/note public
  // curation marks must not disturb the immutable 1.59.0 client contract.
  const reviewClientAgainstPublicNodeMarks = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', linkHealthReviewBaseline,
    '--candidate', publicNodeMarksBaseline,
  ]);
  assert.equal(reviewClientAgainstPublicNodeMarks.status, 0,
    reviewClientAgainstPublicNodeMarks.stderr || reviewClientAgainstPublicNodeMarks.stdout);

  // 1.61.0 is purely additive: optional curatorNote on ExploreCollectionItem
  // and PublicCollectionSummary must not disturb the immutable 1.60.0 client
  // contract.
  const publicNodeMarksClientAgainstCuratorNote = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', publicNodeMarksBaseline,
    '--candidate', curatorNoteBaseline,
  ]);
  assert.equal(publicNodeMarksClientAgainstCuratorNote.status, 0,
    publicNodeMarksClientAgainstCuratorNote.stderr || publicNodeMarksClientAgainstCuratorNote.stdout);

  // 1.66.0 is purely additive relative to 1.65.0; the receipt-replay ETag
  // parity pin snapshot verified additive.
  const curatorNoteClientAgainstReceiptReplay = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', curatorNoteBaseline,
    '--candidate', receiptReplayBaseline,
  ]);
  assert.equal(curatorNoteClientAgainstReceiptReplay.status, 0,
    curatorNoteClientAgainstReceiptReplay.stderr || curatorNoteClientAgainstReceiptReplay.stdout);

  // 1.67.0 (#21 digest tombstones) is a deliberate non-additive freeze: the
  // moderation tombstone contract reshapes report responses (state gains
  // 'hidden', optional hiddenPublic), so the gate MUST flag it — a zero
  // status here would mean the checker silently tolerated a shape change.
  const preTombstoneClientAgainstDigestTombstones = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', receiptReplayBaseline,
    '--candidate', digestTombstoneBaseline,
  ]);
  assert.equal(preTombstoneClientAgainstDigestTombstones.status, 1,
    'the deliberate #21 digest tombstone freeze (1.67.0) must be flagged as breaking');

  // 1.68.0 (#21 Explore tombstones) is a deliberate non-additive freeze:
  // ExploreCollectionItem.publicationSlug becomes nullable and optional
  // hiddenPublic marks the row. Same flagging requirement as 1.67.0.
  const digestTombstoneClientAgainstExploreTombstones = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', digestTombstoneBaseline,
    '--candidate', exploreTombstoneBaseline,
  ]);
  assert.equal(digestTombstoneClientAgainstExploreTombstones.status, 1,
    'the deliberate #21 Explore tombstone freeze (1.68.0) must be flagged as breaking');

  // 1.63.0 -> 1.64.0 removed the favicon-ordering preview routes before the
  // feature shipped; that boundary is the other accepted non-additive freeze
  // and is intentionally left unasserted here (its diff is path removal).

  // 1.69.0 (#21 Feed tombstones) is purely additive: FeedItemDto only
  // gains the optional hiddenPublic marker (collectionTitle/publicationSlug
  // were already nullable), so the gate must report additive.
  const exploreTombstoneClientAgainstFeedTombstones = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', exploreTombstoneBaseline,
    '--candidate', feedTombstoneBaseline,
  ]);
  assert.equal(exploreTombstoneClientAgainstFeedTombstones.status, 0,
    exploreTombstoneClientAgainstFeedTombstones.stderr || exploreTombstoneClientAgainstFeedTombstones.stdout);

  // 1.70.0 is a deliberate non-additive freeze: browser credential parent and
  // child management was withdrawn from Product and moved to operator-only
  // provisioning. The boundary must stay visible to the breaking checker;
  // 1.70.0 is then the compatibility anchor for later additive releases.
  const feedTombstoneClientAgainstCredentialRestriction = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', feedTombstoneBaseline,
    '--candidate', credentialRestrictionBaseline,
  ]);
  assert.equal(feedTombstoneClientAgainstCredentialRestriction.status, 1,
    'the intentional 1.70.0 credential contract withdrawal must be flagged as breaking');

  const credentialRestrictionClientAgainstClassificationSettings = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', credentialRestrictionBaseline,
    '--candidate', classificationSettingsBaseline,
  ]);
  assert.equal(credentialRestrictionClientAgainstClassificationSettings.status, 0,
    credentialRestrictionClientAgainstClassificationSettings.stderr
    || credentialRestrictionClientAgainstClassificationSettings.stdout);

  const classificationSettingsClientAgainstPreview = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classificationSettingsBaseline,
    '--candidate', classificationPreviewBaseline,
  ]);
  assert.equal(classificationSettingsClientAgainstPreview.status, 0,
    classificationSettingsClientAgainstPreview.stderr || classificationSettingsClientAgainstPreview.stdout);

  const classificationPreviewClientAgainstChoices = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classificationPreviewBaseline,
    '--candidate', classificationChoicesBaseline,
  ]);
  assert.equal(classificationPreviewClientAgainstChoices.status, 0,
    classificationPreviewClientAgainstChoices.stderr || classificationPreviewClientAgainstChoices.stdout);

  const classificationChoicesClientAgainstTags = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classificationChoicesBaseline,
    '--candidate', classificationTagsBaseline,
  ]);
  assert.equal(classificationChoicesClientAgainstTags.status, 0,
    classificationChoicesClientAgainstTags.stderr || classificationChoicesClientAgainstTags.stdout);

  for (const [baseline, candidate] of [
    [classificationTagsBaseline, product175Baseline],
    [product175Baseline, product176Baseline],
    [product176Baseline, product177Baseline],
    [classificationCreditRunBaseline, product180Baseline],
    [product180Baseline, product181Baseline],
    [product181Baseline, product182Baseline],
  ]) {
    const result = await runNodeScript('scripts/check-openapi-breaking.mjs', [
      '--baseline', baseline,
      '--candidate', candidate,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  // 1.78.0 wraps ClassificationPreviewResponse in a legacy/credit union.
  const previewUnion = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', product177Baseline,
    '--candidate', classificationCreditPreviewBaseline,
  ]);
  assert.equal(previewUnion.status, 1,
    'the intentional 1.78.0 classification credit preview union must be flagged as breaking');

  // 1.79.0 applies the same credit union to ClassificationRun.
  const runUnion = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', classificationCreditPreviewBaseline,
    '--candidate', classificationCreditRunBaseline,
  ]);
  assert.equal(runUnion.status, 1,
    'the intentional 1.79.0 classification credit run union must be flagged as breaking');

  // 1.83.0 completes X-Request-Id / cache-policy on credit error envelopes.
  const headerCompletion = await runNodeScript('scripts/check-openapi-breaking.mjs', [
    '--baseline', product182Baseline,
    '--candidate', product183Baseline,
  ]);
  assert.equal(headerCompletion.status, 0,
    headerCompletion.stderr || headerCompletion.stdout);
}, 120_000);
