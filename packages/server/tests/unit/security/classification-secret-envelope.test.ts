import {createLogger} from '../../../src/infrastructure/telemetry/index.js';
import {expect,test} from 'vitest';
import {createClassificationSecretProtector} from '../../../src/infrastructure/security/classification-secret-envelope.js';
const first={id:'key',version:1,key:Buffer.alloc(32,1)},second={id:'key',version:2,key:Buffer.alloc(32,2)},fingerprint=Buffer.alloc(32,3);
const binding={ownerSubjectId:'owner',profileId:'profile'};
test('randomized envelope, retained-key rotation and stable non-reversible command fingerprint',async()=>{
  const old=createClassificationSecretProtector([first],fingerprint),rotated=createClassificationSecretProtector([second,first],fingerprint);
  const a=old.protect('private-test-token',binding),b=old.protect('private-test-token',binding);
  expect(a).not.toEqual(b);expect(JSON.stringify(a)).not.toContain('private-test-token');
  expect(await rotated.withSecret(a,binding,async secret=>secret)).toBe('private-test-token');
  expect(rotated.protect('private-test-token',binding).keyVersion).toBe(2);
  expect(old.fingerprint('private-test-token')).toBe(rotated.fingerprint('private-test-token'));
});
test('tampering, swapped owner/profile, unknown key and unknown envelope version fail closed',async()=>{
  const protector=createClassificationSecretProtector([first],fingerprint),sealed=protector.protect('private-test-token',binding);
  for(const [envelope,owner] of [[sealed,{...binding,ownerSubjectId:'other'}],[sealed,{...binding,profileId:'other'}],
    [{...sealed,keyVersion:2},binding],[{...sealed,version:2},binding],[{...sealed,tag:'a'.repeat(22)},binding]] as const){
    let called=false;
    await expect(protector.withSecret(envelope as typeof sealed,owner,async()=>{called=true;})).rejects.toThrow('classification_secret_unavailable');
    expect(called).toBe(false);
  }
});

test('logger redacts write-only profile secrets and deployment key configuration',()=>{
  const lines:string[]=[];const logger=createLogger('info',{write:line=>{lines.push(line)}});
  logger.info({body:{secret:'private-test-token'},secret_envelope:{ciphertext:'encrypted-fixture'},config:{classification:{secretKeys:['root-key-fixture'],fingerprintKey:'hmac-fixture'}}},'profile operation');
  const output=lines.join('');for(const value of ['private-test-token','encrypted-fixture','root-key-fixture','hmac-fixture'])expect(output).not.toContain(value);
  expect(output).toContain('[REDACTED]');
});
