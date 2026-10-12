import type {ClassificationWire} from './generated/classification/classification-provider-cloudflare-jev.js';
import { localized, t } from './i18n.js';

/** Presets a user can pick for extension-local classification. All endpoints stay editable; the first is the default. */
export type LocalClassificationPresetId = 'cloudflare' | 'typesafe' | 'vercel' | 'custom';

export interface LocalClassificationPreset {
  readonly id: LocalClassificationPresetId;
  readonly label: string;
  readonly wire: ClassificationWire;
  /** Default endpoint; `{account}` is replaced from the Cloudflare account input. Empty means user-supplied. */
  readonly endpoint: string;
  readonly defaultModel: string;
  readonly modelCandidates: readonly string[];
  /** The Cloudflare envelope also needs its account id and gateway id. */
  readonly accountFields: boolean;
  readonly credential: 'required' | 'optional';
  readonly credentialLabel: string;
}

/**
 * Endpoints and model ids follow the provider documentation; only the Cloudflare
 * envelope nests the System One input, the other two speak the native wire.
 */
export let LOCAL_CLASSIFICATION_PRESETS: readonly LocalClassificationPreset[];
localized(() => {
  LOCAL_CLASSIFICATION_PRESETS = Object.freeze([
  {
    id: 'typesafe', label: 'TypeSafe (api.typesafe.ai)', wire: 'typesafe_systemone_v1',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-latest', modelCandidates: ['jev-latest', 'jev-preview', 'jev-1.13.0'],
    accountFields: false, credential: 'required', credentialLabel: t('classification_typesafeApiKey', 'TypeSafe API key'),
  },
  {
    id: 'cloudflare', label: 'Cloudflare AI Gateway', wire: 'cloudflare_ai_run_v1',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run',
    defaultModel: 'typesafe/jev', modelCandidates: ['typesafe/jev'],
    accountFields: true, credential: 'required', credentialLabel: t('classification_cloudflareApiToken', 'Cloudflare API token'),
  },
  {
    id: 'vercel', label: 'Vercel AI Gateway', wire: 'typesafe_systemone_v1',
    endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    defaultModel: 'typesafe-ai/jev', modelCandidates: ['typesafe-ai/jev'],
    accountFields: false, credential: 'required', credentialLabel: t('classification_aiGatewayApiKey', 'AI Gateway API key'),
  },
  {
    id: 'custom', label: t('classification_customEndpoint', 'Custom endpoint'), wire: 'typesafe_systemone_v1',
    endpoint: '', defaultModel: '', modelCandidates: [],
    accountFields: false, credential: 'optional', credentialLabel: t('classification_apiKeyOptional', 'API key (optional)'),
  },
]);
});

export function localClassificationPreset(id: string): LocalClassificationPreset {
  return LOCAL_CLASSIFICATION_PRESETS.find(preset => preset.id === id) ?? LOCAL_CLASSIFICATION_PRESETS[0]!;
}

/** Loopback, link-local and RFC1918 hosts, plus mDNS names: where a self-hosted model lives. */
export function isLocalClassificationHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/u.test(octet) || Number(octet) > 255)) return false;
  const [a, b] = octets.map(Number) as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * HTTPS anywhere; plain HTTP only for a local endpoint, where the user runs the
 * classifier themselves. Public HTTP would leak bookmark text and the token.
 */
export function classificationEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (!url.hostname || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLocalClassificationHost(url.hostname);
}

/** Only loopback can be tried without network connectivity; LAN and mDNS still need a network. */
export function classificationEndpointIsLoopback(endpoint: string): boolean {
  if (!classificationEndpointAllowed(endpoint)) return false;
  const host = new URL(endpoint).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(host);
}
