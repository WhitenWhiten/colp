export const SOCIAL_COLLECTION_CHANGE_EVENT_TYPE = 'social.collection-change' as const;
export const SOCIAL_COLLECTION_CHANGE_EVENT_VERSION = 2 as const;
export const SOCIAL_COLLECTION_CHANGE_HANDLER_NAME = 'social.publish-collection-change' as const;
export const SOCIAL_COLLECTION_CHANGE_HANDLER_MODE = 'projection_latest_only' as const;
export const SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME = 'social.publish-public-activity' as const;

export type SocialProducerDiscoverability = 'public_candidate' | 'remove';

export interface SocialCollectionChangePayload {
  readonly collectionId: string;
  readonly ownerProfileId: string;
  readonly publicationRevision: string;
  readonly discoverabilityRecheckKey: string;
  readonly producerDiscoverability: SocialProducerDiscoverability;
}

export interface RoutedSocialCollectionChange {
  readonly eventType: typeof SOCIAL_COLLECTION_CHANGE_EVENT_TYPE;
  readonly eventVersion: typeof SOCIAL_COLLECTION_CHANGE_EVENT_VERSION;
  readonly handlerName: typeof SOCIAL_COLLECTION_CHANGE_HANDLER_NAME;
  readonly handlerMode: typeof SOCIAL_COLLECTION_CHANGE_HANDLER_MODE;
  readonly aggregateType: 'collection';
  readonly aggregateId: string;
  readonly aggregateScope: string;
  readonly aggregateRevision: string;
  readonly commitOrdinal: bigint;
  readonly payload: SocialCollectionChangePayload;
}

export interface SocialCollectionChangeRouteFaultInjector {
  beforeMap?(): void | Promise<void>;
  afterMap?(route: RoutedSocialCollectionChange): void | Promise<void>;
  beforeAppend?(route: RoutedSocialCollectionChange): void | Promise<void>;
  afterAppend?(route: RoutedSocialCollectionChange): void | Promise<void>;
}
