import { inspectCommunityPackage } from './community-package.js';
import { communityWrapper } from './community-wrapper.js';
import { COMMUNITY_RUNTIME_SCRIPT } from './community-definition.js';
import { communityScriptId, communityWorldId, type CommunityInstallation } from './community-state.js';
import { sourceDigest } from './source-db.js';
/** The host's page runtime, then the package's reviewed script wrapped with this generation's credential. */
export function communityScripts(row: CommunityInstallation): chrome.userScripts.ScriptSource[] {
  const parsed = inspectCommunityPackage(row.approved.text);
  if (parsed.digest !== row.approved.digest || sourceDigest(parsed.package) !== sourceDigest(row.approved.package)) throw new Error('communityPackageChanged');
  return [{ file: COMMUNITY_RUNTIME_SCRIPT }, { code: communityWrapper({ manifest: parsed.package.manifest, credential: row.credential, script: parsed.package.script }) }];
}
export function communityRegistration(row: CommunityInstallation): chrome.userScripts.Script {
  const manifest = row.approved.package.manifest;
  return { id: communityScriptId(row), matches: [...manifest.matches], js: communityScripts(row), world: 'USER_SCRIPT', worldId: communityWorldId(row), allFrames: false, runAt: manifest.execution.runAt };
}
export function communityRegistrationMatches(row: CommunityInstallation, scripts: readonly chrome.userScripts.Script[]) {
  const expected = communityRegistration(row), found = scripts.find(s => s.id === expected.id);
  return !!found && found.world === 'USER_SCRIPT' && found.worldId === expected.worldId && found.runAt === expected.runAt && !found.allFrames
    && JSON.stringify(found.js) === JSON.stringify(expected.js) && JSON.stringify(found.matches) === JSON.stringify(expected.matches)
    && scripts.filter(s => s.worldId === expected.worldId).length === 1;
}
