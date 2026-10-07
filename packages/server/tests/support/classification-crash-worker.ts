import { createPostgresClassificationRunRuntime } from '../../src/infrastructure/collections/classification-run-runtime.js';
import { createDatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createPostgresClassificationRuntime } from '../../src/infrastructure/collections/classification-runtime.js';
import { createCloudflareJevClassificationProvider, createCloudflareUpstream } from '../../src/infrastructure/collections/classification-provider-cloudflare-jev.js';
import { classificationHttpHarness } from './classification-http-harness.js';

// Real HTTP/DB worker killed by the integration test after a persisted L2 dispatch.
process.once('message', async (input: {databaseUrl:string;principalId:string;subjectId:string;holdFirst?:boolean;batch?:boolean}) => {
  try {
    const db=createDatabaseRuntime(input.databaseUrl,{maxConnections:3,applicationName:'classification-crash-test'});
    const transport:typeof fetch=async(_url,init)=>{
      const questions=JSON.parse(String(init?.body)).input.questions;
      if(input.holdFirst||questions.specific){
        process.send?.({kind:'dispatch'});
        return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
      }
      const keys=Object.keys(questions.folder.criteria),chosen='f0';
      return Response.json({success:true,result:{model:'jev-1.13.0',answers:{folder:{choice:chosen,confidence:0.95,
        probabilities:Object.fromEntries(keys.map(k=>[k,k===chosen?0.95:0.05]))}},usage:{input_tokens:100,output_tokens:10}}});
    };
    const provider=createCloudflareJevClassificationProvider(createCloudflareUpstream({accountId:'a'.repeat(32),gatewayId:'test',accessKey:'test-only',expectedModelVersion:'jev-1.13.0'}),transport);
    const runtime=createPostgresClassificationRuntime(db.db,provider,{enabled:true,tagsEnabled:false,onError:()=>{},cancelBackend:pid=>db.cancelBackend(pid)});
    const runs=input.batch?createPostgresClassificationRunRuntime(db.db,provider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}}):undefined;
    const app=classificationHttpHarness(runtime,{...input,runs});
    app.addHook('onReady',async()=>{runtime.start();runs?.start();});
    app.addHook('onClose',async()=>{await runs?.stop();await runtime.stop();await db.close();});
    const address=await app.listen({host:'127.0.0.1',port:0});
    process.send?.({kind:'ready',address});
  }catch{process.send?.({kind:'failed'});process.exitCode=1;process.disconnect();}
});
