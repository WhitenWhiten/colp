/**
 * LP-02 per-source preview rules (pure). A rule maps a bookmark URL straight
 * to the site's published card image, skipping the page fetch. Keep this
 * list short: every rule is a promise about someone else's URL scheme.
 */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_PATH_PREFIXES = ['shorts', 'embed', 'live'];

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/u;
/** First path segments that are GitHub product pages, not repository owners. */
const GITHUB_RESERVED_OWNERS = new Set([
  'about', 'apps', 'collections', 'codespaces', 'customer-stories', 'enterprise', 'events',
  'explore', 'features', 'issues', 'login', 'marketplace', 'new', 'notifications', 'orgs',
  'organizations', 'pricing', 'pulls', 'search', 'security', 'settings', 'signup', 'site',
  'sponsors', 'team', 'topics', 'trending', 'users',
]);

function youtubeVideoId(url: URL): string | null {
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return YOUTUBE_ID.test(id) ? id : null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? '';
    return YOUTUBE_ID.test(id) ? id : null;
  }
  const [, prefix = '', id = ''] = url.pathname.split('/');
  return YOUTUBE_PATH_PREFIXES.includes(prefix) && YOUTUBE_ID.test(id) ? id : null;
}

function githubRepository(url: URL): { owner: string; repo: string } | null {
  if (!GITHUB_HOSTS.has(url.hostname)) return null;
  const [, owner = '', rawRepo = ''] = url.pathname.split('/');
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!GITHUB_OWNER.test(owner) || GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!GITHUB_REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** The card image a known site publishes for this URL, or null. */
export function previewSourceRuleImageUrl(bookmarkUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(bookmarkUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hostname = url.hostname.toLowerCase();
  const videoId = youtubeVideoId(url);
  if (videoId !== null) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const repository = githubRepository(url);
  if (repository !== null) {
    return `https://opengraph.githubassets.com/1/${repository.owner}/${repository.repo}`;
  }
  return null;
}
