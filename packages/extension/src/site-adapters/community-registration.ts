import { inspectCommunityPackage } from './community-package.js';
import { communityWrapper } from './community-wrapper.js';
import { communityScriptId, communityWorldId, type CommunityInstallation } from './community-state.js';
import { sourceDigest } from './source-db.js';
export function communityRegistration(row: CommunityInstallation): chrome.userScripts.Script {
  const parsed = inspectCommunityPackage(row.approved.text);
  if (parsed.digest !== row.approved.digest || sourceDigest(parsed.package) !== sourceDigest(row.approved.package)) throw new Error('communityPackageChanged');
  return { id: communityScriptId(row), matches: [...parsed.package.manifest.matches], js: [{ code: communityWrapper({ id: row.id, generation: row.generation,
    credential: row.credential, script: parsed.package.script }) }], world: 'USER_SCRIPT', worldId: communityWorldId(row), allFrames: false, runAt: parsed.package.manifest.execution.runAt };
}
export function communityRegistrationMatches(row: CommunityInstallation, scripts: readonly chrome.userScripts.Script[]) {
  if (inspectCommunityPackage(row.approved.text).digest !== row.approved.digest) return false;
  const expected = communityRegistration(row), found = scripts.find(s => s.id === expected.id);
  return !!found && found.world === 'USER_SCRIPT' && found.worldId === expected.worldId && found.runAt === expected.runAt && !found.allFrames
    && found.js?.length === 1 && found.js[0]?.code === expected.js![0]!.code && JSON.stringify(found.matches) === JSON.stringify(expected.matches)
    && scripts.filter(s => s.worldId === expected.worldId).length === 1;
}
