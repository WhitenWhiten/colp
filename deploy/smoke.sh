#!/usr/bin/env bash
# Smoke-check a running COLP Server.
#
# Usage: deploy/smoke.sh <origin>
#   origin  http(s) origin with no path, for example http://127.0.0.1:8080
#
# Fails if any of these is not HTTP 200:
#   GET /health   JSON body includes version
#   GET /ready    JSON status ready
#   GET /.well-known/collection-protocol
#                 validateManifestSemantics from @know-n/colp/semantic
#
# Includes the anonymous core+publication conformance gate.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: smoke.sh <origin>" >&2
  exit 1
fi

origin=${1%/}
if [[ ! ${origin} =~ ^https?://[^/?#]+$ ]]; then
  echo "smoke: origin must be an http(s) origin with no path: ${origin}" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "smoke: curl is required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "smoke: node is required to load @know-n/colp/semantic" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "${script_dir}/.." && pwd)
manifest_path='/.well-known/collection-protocol'
# Smoke endpoints are expected to be tiny JSON documents. Keep a compromised
# endpoint from making the deployment probe retain an unbounded response.
max_response_bytes=$((1024 * 1024))

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fetch() {
  local name=$1
  local url=$2
  local body=$3
  local status curl_status
  local headers="${body}.headers"
  # Stream through a bounded reader so chunked responses cannot bypass
  # --max-filesize (which only has a pre-download guarantee with a
  # Content-Length header). Keep one byte of look-ahead to detect overflow.
  set +e
  curl -sS --max-filesize "${max_response_bytes}" -D "${headers}" -o - --max-time 20 -- "${url}" \
    | head -c "$((max_response_bytes + 1))" > "${body}"
  curl_status=${PIPESTATUS[0]}
  set -e
  if [[ $(wc -c < "${body}") -gt ${max_response_bytes} ]]; then
    echo "smoke: ${name} response exceeds ${max_response_bytes} bytes: ${url}" >&2
    exit 1
  fi
  if [[ ${curl_status} -ne 0 ]]; then
    echo "smoke: ${name} request failed: ${url}" >&2
    exit 1
  fi
  status=$(awk '$1 ~ /^HTTP\// { code=$2 } END { print code }' "${headers}")
  if [[ ${status} != '200' ]]; then
    echo "smoke: ${name} returned HTTP ${status}: ${url}" >&2
    exit 1
  fi
}

fetch health "${origin}/health" "${tmp}/health.json"
fetch ready "${origin}/ready" "${tmp}/ready.json"
fetch manifest "${origin}${manifest_path}" "${tmp}/manifest.json"

node --input-type=module - "${tmp}/health.json" "${tmp}/ready.json" "${tmp}/manifest.json" "${repo_root}" <<'EOF'
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [healthPath, readyPath, manifestPath, repoRoot] = process.argv.slice(2);

const health = parseJson(healthPath, 'health');
if (!versionPresent(health.version)) {
  console.error('smoke: /health 200 is missing version');
  process.exit(1);
}

const ready = parseJson(readyPath, 'ready');
if (ready.status !== 'ready') {
  console.error(`smoke: /ready status is ${JSON.stringify(ready.status)}, expected "ready"`);
  process.exit(1);
}

const manifest = parseJson(manifestPath, 'manifest');
const semantic = await loadSemantic(repoRoot);
let result;
try {
  result = semantic.validateManifestSemantics(manifest);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`smoke: manifest semantic validation threw: ${message}`);
  process.exit(1);
}
if (!result || result.valid !== true) {
  console.error('smoke: manifest failed @know-n/colp/semantic validation');
  const issues = result && Array.isArray(result.issues) ? result.issues : [];
  for (const issue of issues) {
    console.error(`  ${issue.code} ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

const versionLabel = typeof health.version === 'string'
  ? health.version
  : health.version.server;
console.log(`smoke: health version=${versionLabel} ready manifest=/.well-known/collection-protocol`);

function parseJson(path, name) {
  const body = readFileSync(path, 'utf8');
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    console.error(`smoke: ${name} body is not JSON`);
    process.exit(1);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    console.error(`smoke: ${name} JSON must be an object`);
    process.exit(1);
  }
  return value;
}

function versionPresent(version) {
  if (typeof version === 'string') return version.trim() !== '';
  if (version === null || typeof version !== 'object' || Array.isArray(version)) return false;
  return typeof version.server === 'string' && version.server.trim() !== '';
}

async function loadSemantic(root) {
  const entry = `${root}/packages/node/dist/semantic/index.js`;
  try {
    if (existsSync(entry)) return await import(pathToFileURL(entry).href);
    return await import('@know-n/colp/semantic');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('smoke: cannot load @know-n/colp/semantic');
    console.error('smoke: build it from the repository root with: npm run build');
    console.error(message);
    process.exit(1);
  }
}
EOF

(cd "${repo_root}" && npm run conformance -- "${origin}")
echo "smoke: ok"
