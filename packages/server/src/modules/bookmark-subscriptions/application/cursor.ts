import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from './validation.js';
export interface SubscriptionCursor { accountId:string; scope:string; filter:Record<string,string>; after:string; expiresAt:number }
export function createSubscriptionCursorCodec(key:string|Uint8Array) {
  if(Buffer.byteLength(key)<32)throw new Error('Subscription cursors require a 256-bit secret.');
  const mac=(s:string)=>createHmac('sha256',key).update('bookmark-subscriptions:v1:'+s).digest();
  return {encode(v:SubscriptionCursor):string {const s=Buffer.from(JSON.stringify(v)).toString('base64url');return s+'.'+mac(s).toString('base64url');},decode(token:string,accountId:string,scope:string,now=Date.now()):SubscriptionCursor {
    try {if(token.length>8192)throw new Error();const [s,m,...rest]=token.split('.');if(!s||!m||rest.length)throw new Error();const actual=Buffer.from(m,'base64url'),expected=mac(s);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();const v=JSON.parse(Buffer.from(s,'base64url').toString()) as SubscriptionCursor;if(v.accountId!==accountId||v.scope!==scope||!Number.isFinite(v.expiresAt)||v.expiresAt<=now||typeof v.after!=='string'||!v.filter||typeof v.filter!=='object')throw new Error();return v;}catch {return fail('invalid_cursor');}
  }};
}
