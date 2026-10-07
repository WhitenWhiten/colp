import { describe, expect, test } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '../../../src/modules/commands/index.js';
import { mappingConfig, mappingInput, nodeRefs, createSubscriptionCursorCodec, exitInput, digest } from '../../../src/modules/bookmark-subscriptions/index.js';
import { sourceNodeKey, decodeSourceNodeKey } from '../../../src/infrastructure/bookmark-subscriptions/sources.js';
import { collectionFollowCommandFingerprint } from '../../../src/modules/social/application/collection-follow-command.js';
import { bookmarkSubscriptionCorsMethods } from '../../../src/transport/classification-extension-cors.js';

describe('bookmark subscription closed contracts',()=>{
  test.each([0,21,1.5,NaN])('rejects invalid edition limit %s',limit=>expect(()=>mappingConfig('digest_series',{digestMode:'recent',editionLimit:limit})).toThrow());
  test('mode combinations and immutable/native fields cannot be silently repaired',()=>{
    const input={mappingId:randomUUID(),profileId:randomUUID(),profileLabel:'Browser',mode:'readonly',digestMode:'latest',editionLimit:1,checkIntervalMinutes:15,exitPolicy:{onUnfollow:'inherit',onUnsubscribe:'keep'}};
    expect(mappingInput('digest_series',input)).toEqual(input);
    expect(()=>mappingInput('digest_series',{...input,digestMode:'latest',editionLimit:10})).toThrow();
    expect(()=>mappingInput('digest_series',{...input,rootNativeId:'123'})).toThrow();
    expect(()=>mappingInput('collection',input)).toThrow();
    expect(()=>mappingInput('digest_series',{generation:'replacement'},input as never)).toThrow();
  });
  test('node identities are unique, closed and bounded, request digest respects input order',()=>{
    const a={sourceCollectionId:'c',nodeId:'n',editionId:null};const b={...a,nodeId:'other'};
    expect(()=>nodeRefs([a,a])).toThrow();expect(()=>nodeRefs(Array.from({length:129},(_,i)=>({...a,nodeId:'n'+i})))).toThrow();expect(()=>nodeRefs([{...a,nativeId:'private'}])).toThrow();
    expect(digest([a,b])).not.toBe(digest([b,a]));
  });
  test('content identity contains Collection and edition and never collides with synthetic nodes',()=>{
    expect(sourceNodeKey(['collection','c','n'])).toBe('["collection","c","n"]');
    expect(sourceNodeKey(['digest','s','e','c1','n'])).not.toBe(sourceNodeKey(['digest','s','e','c2','n']));
    expect(decodeSourceNodeKey(sourceNodeKey(['digest','s','e','c','n']))).toEqual({editionId:'e',sourceCollectionId:'c',nodeId:'n'});
    expect(decodeSourceNodeKey(sourceNodeKey(['synthetic','root','c']))).toBeNull();
  });
  test('cursors are account, scope and deadline bound, including tampered signatures',()=>{
    const codec=createSubscriptionCursorCodec('x'.repeat(32));const token=codec.encode({accountId:'a',scope:'mappings',filter:{status:'live'},after:'anchor',expiresAt:5000});
    expect(codec.decode(token,'a','mappings',4000).after).toBe('anchor');
    expect(()=>codec.decode(token,'b','mappings',4000)).toThrow();expect(()=>codec.decode(token,'a','actions',4000)).toThrow();expect(()=>codec.decode(token,'a','mappings',5000)).toThrow();expect(()=>codec.decode(token+'x','a','mappings',4000)).toThrow();
  });
  test('legacy Collection follow fingerprints remain byte compatible',()=>{
    const input={actor:{principalId:'a',profileId:'a',subjectId:'subject-a'},collectionId:'c',commandId:randomUUID()};
    const old=createHash('sha256').update(canonicalJson({action:'unfollow',actorPrincipalId:'a',actorProfileId:'a',collectionId:'c',contractVersion:'1.0.0'})).digest('hex');
    expect(collectionFollowCommandFingerprint('unfollow',input)).toBe(old);
    expect(collectionFollowCommandFingerprint('unfollow',{...input,subscriptionExitPreviewId:randomUUID()})).not.toBe(old);
  });
  test('CORS grants only explicit path and method combinations',()=>{
    expect(bookmarkSubscriptionCorsMethods('/api/v1/me/bookmark-subscription-mappings/id/access')).toBe('GET, OPTIONS');
    expect(bookmarkSubscriptionCorsMethods('/api/v1/me/bookmark-subscription-mappings/id/node-access-checks')).toBe('POST, OPTIONS');
    expect(bookmarkSubscriptionCorsMethods('/api/v1/me/bookmark-subscription-mappings/id/delete-everything')).toBeNull();
    expect(bookmarkSubscriptionCorsMethods('/api/v1/me/bookmark-subscription-mappings/id')).toBe('GET, PATCH, OPTIONS');
  });
  test('unfollow and unsubscribe targets cannot be interchanged',()=>{
    expect(()=>exitInput({trigger:'unfollow',target:{kind:'mapping',mappingId:randomUUID()}})).toThrow();
    expect(()=>exitInput({trigger:'unsubscribe',target:{kind:'source',sourceType:'collection',sourceId:'c'}})).toThrow();
  });
});
