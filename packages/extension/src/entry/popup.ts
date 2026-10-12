import { loadWhenLanguageReady } from './pages.js';

await loadWhenLanguageReady(() => import('../popup.js'));
