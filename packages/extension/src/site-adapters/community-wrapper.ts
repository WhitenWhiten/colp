import type { CommunityManifest } from './community-definition.js';
/** Generated code runs exclusively through userScripts in one named USER_SCRIPT world, after the host's page runtime file. */
export function communityWrapper(input: { manifest: CommunityManifest; credential: string; script: string }) {
  const boot = JSON.stringify({ manifest: input.manifest, credential: input.credential });
  return `(()=>{'use strict';
const start=globalThis.__knownCommunityAdapter;delete globalThis.__knownCommunityAdapter;if(typeof start!=='function')return;
start(${boot},function(sdk){
${input.script}
});
})()`;
}
