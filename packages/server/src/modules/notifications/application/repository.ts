export type NotificationType = 'collection_change' | 'follow_activity';
export type NotificationSubjectType = 'collection' | 'profile';
export type NotificationState = 'unread' | 'read';
export type NotificationDeliveryChannel = 'email';
export type NotificationDeliveryState =
  | 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';

export interface NotificationPreferences {
  readonly recipientAccountId: string;
  readonly inAppEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly inAppStateRevision: bigint;
  readonly emailStateRevision: bigint;
  readonly inAppUpdatedAt: Date;
  readonly emailUpdatedAt: Date;
}

export interface NotificationInput {
  readonly notificationId: string;
  readonly recipientAccountId: string;
  readonly sourceEventId: string;
  readonly notificationType: NotificationType;
  readonly actorProfileId: string | null;
  readonly subjectType: NotificationSubjectType;
  readonly subjectId: string;
  readonly occurredAt: Date;
}

export interface NotificationRecord extends NotificationInput {
  readonly state: NotificationState;
  readonly readAt: Date | null;
  readonly stateRevision: bigint;
  readonly retainUntil: Date;
  readonly createdAt: Date;
}

export interface SavedNotification {
  readonly notification: NotificationRecord;
  readonly inserted: boolean;
}

export interface NotificationDeliveryInput {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly recipientAccountId: string;
  readonly channel: NotificationDeliveryChannel;
}

export interface NotificationDeliveryRecord extends NotificationDeliveryInput {
  readonly state: NotificationDeliveryState;
  readonly attemptCount: number;
  readonly stateRevision: bigint;
  readonly nextAttemptAt: Date;
  readonly leasedUntil: Date | null;
  readonly deliveredAt: Date | null;
  readonly suppressedAt: Date | null;
  readonly deadLetteredAt: Date | null;
  readonly providerMessageId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SavedNotificationDelivery {
  readonly delivery: NotificationDeliveryRecord;
  readonly inserted: boolean;
}

export interface NotificationStateCas {
  readonly recipientAccountId: string;
  readonly notificationId: string;
  readonly expectedStateRevision: bigint;
}

export interface NotificationDeliveryStateCas {
  readonly recipientAccountId: string;
  readonly deliveryId: string;
  readonly expectedState: NotificationDeliveryState;
  readonly expectedStateRevision: bigint;
  readonly nextState: Exclude<NotificationDeliveryState, 'pending'>;
  readonly errorCategory?: 'unknown_future_version' | 'invalid_contract' | 'retry_exhausted'
    | 'dependency' | 'provider_unavailable' | 'other';
}

export interface PurgeExpiredNotificationsInput {
  readonly cutoff: Date;
  readonly limit: number;
  readonly recipientAccountId?: string;
}

export interface PurgedNotifications {
  readonly deletedCount: number;
  readonly notificationIds: readonly string[];
}

export interface PurgeExpiredDeliveriesInput {
  readonly cutoff: Date;
  readonly limit: number;
  readonly recipientAccountId?: string;
}

export interface PurgedDeliveries {
  readonly deletedCount: number;
  readonly deliveryIds: readonly string[];
}

/** P5-16 persistence only. Later tasks own all orchestration and external surfaces. */
export interface NotificationAuthorityRepository {
  getPreferences(recipientAccountId: string): Promise<NotificationPreferences>;
  saveNotification(input: NotificationInput): Promise<SavedNotification>;
  saveDelivery(input: NotificationDeliveryInput): Promise<SavedNotificationDelivery>;
  markRead(input: NotificationStateCas): Promise<NotificationRecord | null>;
  transitionDelivery(
    input: NotificationDeliveryStateCas,
  ): Promise<NotificationDeliveryRecord | null>;
  purgeExpiredNotifications(
    input: PurgeExpiredNotificationsInput,
  ): Promise<PurgedNotifications>;
  purgeExpiredDeliveries(input: PurgeExpiredDeliveriesInput): Promise<PurgedDeliveries>;
}
