import { loadWhenLanguageReady } from './pages.js';

await loadWhenLanguageReady(() => import('../site-adapters/settings.js'));
