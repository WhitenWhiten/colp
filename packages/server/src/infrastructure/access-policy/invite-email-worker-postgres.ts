import type { Pool } from 'pg';
import type {
  InviteEmailClaim,
  InviteEmailDeliveryContext,
  InviteEmailDeliveryRepository,
  InviteEmailAttemptFence,
  InviteEmailErrorCategory,
} from '../../modules/access-policy/index.js';

interface InviteEmailClaimRow {
  delivery_id: string;
  invite_id: string;
  attempt_count: number;
}

interface InviteEmailContextRow {
  invite_id: string;
  email_normalized: string;
  role: 'editor' | 'viewer';
  status: InviteEmailDeliveryContext['status'];
  expires_at: Date;
  collection_title_snapshot: string;
  inviter_display_name: string | null;
  invited_account_id: string | null;
}

/** Canonical claimDue SQL: pending|retryable due or expired leased, SKIP LOCKED. */
export function inviteEmailClaimDueSql(inviteIdBound: boolean): string {
  const invitePredicate = inviteIdBound ? '\n            and invite_id = $3' : '';
  return `with candidates as (
          select delivery_id from collection_invite_deliveries
          where ((state in ('pending','retryable') and next_attempt_at <= current_timestamp)
              or (state='leased' and leased_until <= current_timestamp))${invitePredicate}
          order by next_attempt_at, delivery_id
          for update skip locked
          limit $1)
        update collection_invite_deliveries delivery
        set state='leased', attempt_count=attempt_count+1, state_revision=state_revision+1,
            leased_until=current_timestamp + ($2 * interval '1 millisecond'),
            last_error_category=null,
            updated_at=current_timestamp
        from candidates
        where delivery.delivery_id=candidates.delivery_id
          and ((delivery.state in ('pending','retryable')
                and delivery.next_attempt_at <= current_timestamp)
            or (delivery.state='leased' and delivery.leased_until <= current_timestamp))
        returning delivery.delivery_id, delivery.invite_id, delivery.attempt_count`;
}

/**
 * SC-04 invite email worker repository.
 *
 * Lease fence copies P5-29 (delivery table only):
 * - claim pending|retryable due OR expired leased
 * - live lease cannot be stolen
 * - final CAS: leased AND leased_until > now AND attempt_count match
 *
 * Suppression is a read of `notification_email_suppressions` (never a write).
 */
export function createPostgresInviteEmailDeliveryRepository(
  pool: Pool,
): InviteEmailDeliveryRepository {
  return Object.freeze({
    async claimDue(input: {
      readonly limit: number;
      readonly leaseDurationMs: number;
      readonly inviteId?: string;
    }): Promise<InviteEmailClaim | null> {
      const result = await pool.query<InviteEmailClaimRow>(
        inviteEmailClaimDueSql(input.inviteId !== undefined),
        input.inviteId !== undefined
          ? [input.limit, input.leaseDurationMs, input.inviteId]
          : [input.limit, input.leaseDurationMs],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        deliveryId: row.delivery_id,
        inviteId: row.invite_id,
        attemptCount: row.attempt_count,
      }) : null;
    },

    async loadContext(inviteId: string): Promise<InviteEmailDeliveryContext | null> {
      const result = await pool.query<InviteEmailContextRow>(
        `select invite.id as invite_id,
                invite.email_normalized,
                invite.role,
                invite.status,
                invite.expires_at,
                invite.collection_title_snapshot,
                profiles.display_name as inviter_display_name,
                invited_accounts.id as invited_account_id
           from collection_invites invite
           left join accounts inviter_accounts
             on inviter_accounts.subject_id = invite.invited_by_subject_id
           left join profiles
             on profiles.account_id = inviter_accounts.id
           left join accounts invited_accounts
             on invited_accounts.subject_id = invite.invited_subject_id
          where invite.id = $1`,
        [inviteId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        inviteId: row.invite_id,
        email: row.email_normalized,
        role: row.role,
        status: row.status,
        expiresAt: row.expires_at,
        collectionTitle: row.collection_title_snapshot,
        inviterDisplayName: row.inviter_display_name,
        invitedAccountId: row.invited_account_id,
      });
    },

    async isRecipientSuppressed(accountId: string): Promise<boolean> {
      const result = await pool.query<{ present: boolean }>(
        `select exists(
           select 1 from notification_email_suppressions
            where recipient_account_id = $1
              and source in ('bounce','complaint','unsubscribe')
         ) present`,
        [accountId],
      );
      return result.rows[0]?.present === true;
    },

    async completeDelivery(fence: InviteEmailAttemptFence, providerMessageId: string | null): Promise<boolean> {
      const result = await pool.query(
        `update collection_invite_deliveries
            set state='delivered', state_revision=state_revision+1, leased_until=null,
                delivered_at=current_timestamp, last_error_category=null,
                provider_message_id=$3, updated_at=current_timestamp
          where delivery_id=$1 and state='leased' and attempt_count=$2
            and leased_until > current_timestamp`,
        [fence.deliveryId, fence.attemptCount, providerMessageId],
      );
      return result.rowCount === 1;
    },

    async failDelivery(fence: InviteEmailAttemptFence, input: {
      readonly nextAttemptAt: Date;
      readonly errorCategory: InviteEmailErrorCategory;
      readonly deadLetter: boolean;
    }): Promise<boolean> {
      const state = input.deadLetter ? 'dead_letter' : 'retryable';
      const result = await pool.query(
        `update collection_invite_deliveries
            set state=$3, state_revision=state_revision+1, leased_until=null,
                next_attempt_at=$4, last_error_category=$5,
                dead_lettered_at=case when $3='dead_letter' then current_timestamp else dead_lettered_at end,
                updated_at=current_timestamp
          where delivery_id=$1 and state='leased' and attempt_count=$2
            and leased_until > current_timestamp`,
        [fence.deliveryId, fence.attemptCount, state, input.nextAttemptAt, input.errorCategory],
      );
      return result.rowCount === 1;
    },

    async suppressDelivery(
      fence: InviteEmailAttemptFence,
      errorCategory: InviteEmailErrorCategory | null = null,
    ): Promise<boolean> {
      const result = await pool.query(
        `update collection_invite_deliveries
            set state='suppressed', state_revision=state_revision+1, leased_until=null,
                suppressed_at=current_timestamp, last_error_category=$3,
                updated_at=current_timestamp
          where delivery_id=$1 and state='leased' and attempt_count=$2
            and leased_until > current_timestamp`,
        [fence.deliveryId, fence.attemptCount, errorCategory],
      );
      return result.rowCount === 1;
    },
  });
}
