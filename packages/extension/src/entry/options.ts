import { loadWhenLanguageReady } from './pages.js';

await loadWhenLanguageReady(() => import('../options.js'));
