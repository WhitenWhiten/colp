import {createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes} from 'node:crypto';

export interface ClassificationSecretKey {readonly id:string;readonly version:number;readonly key:Buffer}
export interface ClassificationSecretBinding {readonly ownerSubjectId:string;readonly profileId:string}
export interface ClassificationSecretEnvelope {
  readonly version:1;readonly keyId:string;readonly keyVersion:number;
  readonly nonce:string;readonly ciphertext:string;readonly tag:string;
  readonly wrapNonce:string;readonly wrappedKey:string;readonly wrapTag:string;
}
export class ClassificationSecretUnavailable extends Error {
  constructor(){super('classification_secret_unavailable');this.name='ClassificationSecretUnavailable';}
}
const fail=():never=>{throw new ClassificationSecretUnavailable();};
const context='known.classification-provider-secret.v1';
function derive(key:Buffer,purpose:string){return Buffer.from(hkdfSync('sha256',key,Buffer.from(context),purpose,32));}
function decode(value:string,length?:number){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/u.test(value))return fail();
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value||(length!==undefined&&bytes.length!==length))return fail();
  return bytes;
}
function aad(binding:ClassificationSecretBinding,keyId:string,keyVersion:number){return Buffer.from(JSON.stringify([context,1,keyId,keyVersion,binding.ownerSubjectId,binding.profileId]));}
function encrypt(key:Buffer,plain:Buffer,additional:Buffer){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(additional);
  return {nonce:nonce.toString('base64url'),ciphertext:Buffer.concat([cipher.update(plain),cipher.final()]).toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
}
function decrypt(key:Buffer,nonce:string,ciphertext:string,tag:string,additional:Buffer){
  const decipher=createDecipheriv('aes-256-gcm',key,decode(nonce,12));decipher.setAAD(additional);decipher.setAuthTag(decode(tag,16));
  return Buffer.concat([decipher.update(decode(ciphertext)),decipher.final()]);
}
export function createClassificationSecretProtector(keys:readonly ClassificationSecretKey[],fingerprintKey:Buffer){
  if(!keys.length||keys.length>8||fingerprintKey.length!==32)return fail();
  const ring=new Map<string,Buffer>();
  for(const key of keys){
    if(!/^[a-zA-Z0-9_-]{1,64}$/u.test(key.id)||!Number.isSafeInteger(key.version)||key.version<1||key.key.length!==32)return fail();
    const identity=`${key.id}:${key.version}`;if(ring.has(identity))return fail();ring.set(identity,derive(key.key,'envelope-wrapping'));
  }
  const active=keys[0]!,fingerprint=derive(fingerprintKey,'command-fingerprint');
  return {
    fingerprint(secret:string){return createHmac('sha256',fingerprint).update(secret).digest('hex');},
    protect(secret:string,binding:ClassificationSecretBinding):ClassificationSecretEnvelope {
      if(!secret||Buffer.byteLength(secret)>4096||/[\r\n\0]/u.test(secret))return fail();
      const plain=Buffer.from(secret),dek=randomBytes(32),additional=aad(binding,active.id,active.version);
      try{
        const sealed=encrypt(dek,plain,additional),wrapped=encrypt(ring.get(`${active.id}:${active.version}`)!,dek,additional);
        return {version:1,keyId:active.id,keyVersion:active.version,...sealed,wrapNonce:wrapped.nonce,wrappedKey:wrapped.ciphertext,wrapTag:wrapped.tag};
      }finally{plain.fill(0);dek.fill(0);}
    },
    async withSecret<T>(envelope:ClassificationSecretEnvelope,binding:ClassificationSecretBinding,work:(secret:string)=>Promise<T>):Promise<T>{
      let dek:Buffer|undefined,plain:Buffer|undefined;
      try{
        if(envelope.version!==1)return fail();
        const key=ring.get(`${envelope.keyId}:${envelope.keyVersion}`);if(!key)return fail();
        const additional=aad(binding,envelope.keyId,envelope.keyVersion);
        dek=decrypt(key,envelope.wrapNonce,envelope.wrappedKey,envelope.wrapTag,additional);
        if(dek.length!==32)return fail();
        plain=decrypt(dek,envelope.nonce,envelope.ciphertext,envelope.tag,additional);
        if(!plain.length||plain.length>4096)return fail();
      }catch{return fail();}finally{dek?.fill(0);}
      try{return await work(plain.toString('utf8'));}finally{plain.fill(0);}
    },
  };
}
export type ClassificationSecretProtector=ReturnType<typeof createClassificationSecretProtector>;
