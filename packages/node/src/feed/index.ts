/**
 * Feed domain library: event discrimination, cursor codec, projection,
 * release-mode assembly, client poll/merge helpers, and optional JSON Feed /
 * Atom / WebSub representations.
 *
 * Hosts own durable event-log storage, HTTP controllers, and real WebSub hub
 * network delivery. This package surface is pure protocol boundary code.
 */

export {
  STANDARD_FEED_EVENT_TYPES,
  discriminateFeedEvent,
  isStandardFeedEventType,
  type FeedEventDiscriminationErrorCode,
  type FeedEventDiscriminationResult,
  type StandardFeedEventType,
  type VerifiedFeedEvent,
} from './event-contracts.js';

export {
  advanceFeedCursor,
  createFeedCursor,
  createFeedCursorCodec,
  createFeedCursorExpiredProblem,
  createFeedCursorHmacKey,
  createFeedFilterDigest,
  verifyFeedCursor,
  type FeedCursorCodec,
  type FeedCursorContext,
  type FeedCursorExpiryResult,
  type FeedCursorHmacKey,
  type FeedCursorScope,
  type FeedCursorVerification,
} from './cursor.js';

export {
  decodeFeedQuery,
  type FeedQueryDecodeResult,
} from './query.js';

export {
  assertFeedEventBookmarkUrls,
  assertNonRedactedFeedBookmarkUrl,
  assertRedactedFeedBookmarkShape,
  projectFeedBookmarkUrl,
  projectFeedNodeBookmark,
  type FeedBookmarkProjection,
} from './bookmark-url.js';

export {
  projectFeedEvent,
  projectFeedEvents,
  type FeedProjectionErrorCode,
  type FeedProjectionOptions,
  type FeedProjectionResult,
} from './projection.js';

export {
  buildReleasePublishedFeedEvent,
  isImmutableReleaseSnapshotUrl,
  isReleaseSnapshotDigest,
  type ReleasePublishedBuildResult,
  type ReleasePublishedErrorCode,
  type ReleasePublishedEventInput,
} from './release-event.js';

export {
  MAX_FEED_ENTITY_TAG_LENGTH,
  computeFeedBackoffSeconds,
  createFeedPollController,
  type FeedPollController,
  type FeedPollDecision,
  type FeedPollLimits,
  type FeedPollResponseHint,
  type FeedPollState,
} from './client-poll.js';

export {
  MAX_FEED_COLLECTIONS_PER_FILTER_GROUP,
  MAX_FEED_COLLECTION_ID_LENGTH,
  MAX_FEED_FILTER_DIGEST_LENGTH,
  MAX_FEED_FILTER_GROUPS,
  MAX_FEED_SUBSCRIPTIONS,
  MAX_FEED_SUBSCRIPTION_ID_LENGTH,
  mergeFeedSubscriptions,
  routeMergedFeedEvents,
  type FeedMergeErrorCode,
  type FeedMergeResult,
  type FeedSubscription,
  type MergedFeedRequest,
} from './client-merge.js';

export {
  JSON_FEED_MAX_ATTACHMENTS_PER_EVENT,
  JSON_FEED_MAX_ATTACHMENT_SIZE_IN_BYTES,
  JSON_FEED_MAX_ATTACHMENT_TITLE_LENGTH,
  JSON_FEED_MAX_AUTHORS,
  JSON_FEED_MAX_AUTHOR_NAME_LENGTH,
  JSON_FEED_MAX_MIME_TYPE_LENGTH,
  JSON_FEED_MAX_TAGS,
  JSON_FEED_MAX_TAG_LENGTH,
  JSON_FEED_MAX_TITLE_LENGTH,
  JSON_FEED_MAX_URL_LENGTH,
  isFeedLike,
  mapFeedToJsonFeed,
  type JsonFeedAttachment,
  type JsonFeedAuthor,
  type JsonFeedDocument,
  type JsonFeedItem,
  type JsonFeedMapErrorCode,
  type JsonFeedMapOptions,
  type JsonFeedMapResult,
} from './json-feed.js';

export {
  mapFeedToAtom,
  type AtomEntry,
  type AtomFeedDocument,
  type AtomLink,
  type AtomMapErrorCode,
  type AtomMapOptions,
  type AtomMapResult,
} from './atom.js';

export {
  declareWebSubHubs,
  withWebSubHubs,
  type WebSubDeclareResult,
} from './websub.js';
