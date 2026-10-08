import type { CanonicalDomainEvent } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendReportSourceInvalidation,type ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import type { routeCanonicalDomainEvent } from './canonical-outbox-router.js';
import { appendClassificationAutoTagJob } from './classification-auto-tag-producer.js';

export async function appendCanonicalSecondaryOutbox(tx:DatabaseTransaction,event:CanonicalDomainEvent,routed:Awaited<ReturnType<typeof routeCanonicalDomainEvent>>,options:{
  readonly reportSourceInvalidation?:ReportSourceInvalidationOutboxPort;readonly outboxIdGenerator?:()=>string;
}){
  await appendReportSourceInvalidation(options.reportSourceInvalidation,tx,event,routed);
  await appendClassificationAutoTagJob(tx,event);
}
