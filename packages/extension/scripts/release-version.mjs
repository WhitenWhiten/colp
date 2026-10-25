// GitHub RCs use version_name for their full SemVer; Chrome requires a numeric version.
export function checkReleaseVersion(version, manifest) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/u.exec(version);
  if (!match || match.slice(1, 4).some((part) => Number(part) > 65535)
    || (match[4] && Number(match[4]) >= 65535)
    || match.slice(1, 4).every((part) => Number(part) === 0)) {
    throw new Error(`version must be X.Y.Z or X.Y.Z-rc.N with Chrome-compatible components: ${version}`);
  }
  const base = match.slice(1, 4).join('.');
  // Reserve 65535 for the final release so it sorts after every RC in Chrome.
  // Plain X.Y.Z is also accepted for existing stable versions without RCs.
  const versions = match[4] ? [`${base}.${match[4]}`] : [base, `${base}.65535`];
  if (!versions.includes(manifest.version)) {
    throw new Error(`manifest.base.json is ${manifest.version}, expected ${versions.join(' or ')}`);
  }
  if ((manifest.version_name ?? manifest.version) !== version) {
    throw new Error(`manifest.base.json display version must match package.json ${version}`);
  }
}
