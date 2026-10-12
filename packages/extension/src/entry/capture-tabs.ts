import { loadWhenLanguageReady } from './pages.js';

await loadWhenLanguageReady(() => import('../capture/tabs-page.js'));
