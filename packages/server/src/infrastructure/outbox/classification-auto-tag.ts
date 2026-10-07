import { defineClosedPayloadValidator,type EventPayloadRegistration } from './envelope.js';
import { OutboxDeliveryError,OutboxContinuationRequested,type OutboxHandlerContext,type OutboxRoute } from './router.js';
export const CLASSIFICATION_AUTO_TAG_EVENT='classification.auto-tag.requested';
export const CLASSIFICATION_AUTO_TAG_HANDLER='classification_auto_tag';
const validate=defineClosedPayloadValidator({jobId:value=>typeof value==='string'&&value.length>0&&value.length<=128});
export const classificationAutoTagEnvelopeRegistration:EventPayloadRegistration={eventType:CLASSIFICATION_AUTO_TAG_EVENT,eventVersion:1,validatePayload:validate};
export function createClassificationAutoTagOutboxRoute(process:(jobId:string,context:OutboxHandlerContext)=>Promise<'complete'|'retry'|'recompute'|'failed'>):OutboxRoute {
  return {handlerName:CLASSIFICATION_AUTO_TAG_HANDLER,handlerMode:'delivery_each_event',eventType:CLASSIFICATION_AUTO_TAG_EVENT,eventVersion:1,
    sideEffectDurability:'durable',routeClass:'projection',async handle(context){
      context.signal.throwIfAborted();
      if(!validate(context.envelope.payload)||!context.attempt)throw new OutboxDeliveryError('permanent','invalid_classification_auto_tag_envelope');
      const result=await process(context.envelope.payload.jobId as string,context);
      if(result==='retry')throw new OutboxDeliveryError('retryable','classification_auto_execution_pending');
      if(result==='recompute')throw new OutboxContinuationRequested();
      if(result==='failed')throw new OutboxDeliveryError('permanent','classification_auto_tag_failed');
    }};
}
