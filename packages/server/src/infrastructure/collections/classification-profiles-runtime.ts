import type {Kysely} from 'kysely';
import {ClassificationProfileError,type ClassificationProfilesRuntime} from '../../modules/collections/index.js';
import type {DatabaseSchema} from '../database/runtime.js';
import type {ClassificationSecretProtector} from '../security/classification-secret-envelope.js';
import {createClassificationProfileCommands,listClassificationProfiles} from './classification-profile-commands.js';
import {createClassificationProfileProbes} from './classification-profile-probes.js';
export function createPostgresClassificationProfilesRuntime(db:Kysely<DatabaseSchema>,protector:ClassificationSecretProtector|null,
  options:{enabled:()=>boolean;transport?:typeof fetch;onError?:(code:string)=>void}):ClassificationProfilesRuntime{
  const unavailable=async():Promise<never>=>{throw new ClassificationProfileError('feature_temporarily_unavailable');};
  const stopping=new AbortController(),commands=protector?createClassificationProfileCommands(db,protector):null,
    probes=createClassificationProfileProbes(db,protector,{...options,signal:stopping.signal}),active=new Map<string,Promise<void>>();
  let timer:ReturnType<typeof setInterval>|undefined,polling:Promise<void>|undefined;
  const run=(id:string)=>{const existing=active.get(id);if(existing)return existing;
    const task=probes.process(id).catch(()=>options.onError?.('probe_failed')).finally(()=>{active.delete(id);});active.set(id,task);return task;};
  async function poll(){await probes.reap();for(const row of await probes.pending()){if(active.size>=2||stopping.signal.aborted)break;void run(row.id);}}
  const tick=()=>{if(!polling)polling=poll().catch(()=>options.onError?.('probe_recovery_failed')).finally(()=>{polling=undefined;});};
  return {
    list:ownerSubjectId=>listClassificationProfiles(db,ownerSubjectId),create:input=>commands?commands.mutate('create',input):unavailable(),
    update:input=>commands?commands.mutate('update',input):unavailable(),delete:input=>commands?commands.mutate('delete',input):unavailable(),
    async test(input){
      if(!protector)return unavailable();
      await probes.reap();const result=await probes.admit(input);
      if(result.kind!=='accepted')return result;
      await run(result.id);await probes.reap();const replay=await probes.admit(input);
      if(replay.kind==='accepted')throw new Error('classification_probe_receipt_missing');return replay;
    },
    start(){if(timer)return;timer=setInterval(tick,5000);timer.unref();tick();},
    async stop(){stopping.abort();if(timer)clearInterval(timer);await polling;await Promise.allSettled(active.values());await probes.reap();},
  };
}
