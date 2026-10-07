import type { CanonicalDomainEvent } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendReportSourceInvalidation,type ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { appendSocialCollectionChangeOutbox,type SocialCollectionChangeRouteFaultInjector } from '../outbox/social-collection-change.js';
import type { routeCanonicalDomainEvent } from './canonical-outbox-router.js';
import { appendClassificationAutoTagJob } from './classification-auto-tag-producer.js';

export async function appendCanonicalSecondaryOutbox(tx:DatabaseTransaction,event:CanonicalDomainEvent,routed:Awaited<ReturnType<typeof routeCanonicalDomainEvent>>,options:{
  readonly reportSourceInvalidation?:ReportSourceInvalidationOutboxPort;readonly outboxIdGenerator?:()=>string;
  readonly socialRouteFaultInjector?:SocialCollectionChangeRouteFaultInjector;
}){
  await appendReportSourceInvalidation(options.reportSourceInvalidation,tx,event,routed);
  await appendSocialCollectionChangeOutbox(tx,event.domainEventId,event.collectionId,event.commitOrdinal,
    {outboxIdGenerator:options.outboxIdGenerator,faultInjector:options.socialRouteFaultInjector});
  await appendClassificationAutoTagJob(tx,event);
}
