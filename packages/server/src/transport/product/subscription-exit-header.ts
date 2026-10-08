import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { requireSessionActor } from '../session-auth.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProductHttpError } from '../product-error.js';
export function readSubscriptionExitPreview(request:FastifyRequest):{subscriptionExitPreviewId?:string} {
  const v=request.headers['known-subscription-exit-preview'];if(v===undefined)return {};
  if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v))throw new ProductHttpError({statusCode:400,code:'invalid_request',message:'Invalid subscription exit preview.'});
  return {subscriptionExitPreviewId:v};
}

/** Establish current identity before CSRF rejection; never replay a saved session header. */
export async function prepareSubscriptionExitSession(request:FastifyRequest,reply:FastifyReply,identity:IdentityUnitOfWork):Promise<void> {
  if(request.headers['known-subscription-exit-preview']===undefined)return;
  reply.header('Cache-Control','private, no-store');
  if(request.headers.authorization===undefined){
    const actor=await requireSessionActor(request,identity,{touch:false});
    if('session'in actor)reply.header('Known-Subscription-Session',actor.session.id);
  }
}
