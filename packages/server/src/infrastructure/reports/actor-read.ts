import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ReportActorReadPort, ReportReadActor } from '../../modules/reports/index.js';
import { accountRestrictPublicationExistsSql } from '../governance/collection-control-sql.js';
import { createPostgresModerationActionMethods } from '../governance/postgres-moderation-actions.js';
import { mapDigestSeriesRow } from './repositories.js';
import { listPublishedEditions, mapDigestEditionRow } from './report-edition-public-read.js';
export function createPostgresReportActorReadPort(tx:DatabaseTransaction):ReportActorReadPort {
  const controls=createPostgresModerationActionMethods(tx);
  async function series(actor:ReportReadActor,id:string) {
    const s=await tx.selectFrom('digest_series as s').innerJoin('accounts as owner','owner.subject_id','s.owner_subject_id')
      .leftJoin('digest_members as m',j=>j.onRef('m.series_id','=','s.id').on('m.subject_id','=',actor.subjectId).on('m.revoked_at','is',null))
      .selectAll('s').select(['m.role as member_role',sql.raw<boolean>(accountRestrictPublicationExistsSql('owner.id')).as('owner_restricted')])
      .where('s.id','=',id).where('s.deleted_at','is',null).where('s.state','=','active').where('owner.status','=','active').where('owner.deleted_at','is',null).executeTakeFirst();
    if(!s)return null;
    const account=await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).where('subject_id','=',actor.subjectId).where('status','=','active').where('deleted_at','is',null).executeTakeFirst();if(!account)return null;
    const member=s.owner_subject_id===actor.subjectId||s.member_role!=null;
    const hidden=((await controls.digestSeriesControls([id])).get(id)?.hidePublic??false)||s.owner_restricted;
    if(!member&&(!['public','unlisted'].includes(s.visibility)||!s.slug||hidden))return null;
    const followed=!!await tx.selectFrom('digest_follows').select('series_id').where('series_id','=',id).where('follower_profile_id','=',actor.accountId).where('unfollowed_at','is',null).executeTakeFirst();
    return {s:mapDigestSeriesRow(s),member,memberRole:s.member_role,hidden,followed};
  }
  return {series,async hiddenPublishedEditionIds(ids){if(ids.length>100)throw new RangeError('Edition batch exceeds limit');const facts=await controls.digestEditionControls([...ids]);return new Set([...facts].filter(([,f])=>f.hidePublic).map(([id])=>id));},publishedCandidates:(id,limit,after)=>listPublishedEditions(tx,id,limit,after),async publishedEdition(actor,seriesId,id){
    const s=await series(actor,seriesId);if(!s)return null;
    const e=await tx.selectFrom('digest_editions').selectAll().where('id','=',id).where('series_id','=',seriesId).where('state','=','published').where('published_at','is not',null).executeTakeFirst();if(!e)return null;
    if(!s.member&&(await controls.digestEditionControls([id])).get(id)?.hidePublic)return null;
    return mapDigestEditionRow(e);
  }};
}
