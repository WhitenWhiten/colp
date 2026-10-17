import { initI18n, onUiLanguageChanged, uiLanguage } from './i18n.js';

/**
 * Security-critical consent copy is kept together in both shipped languages.
 * This replaces the older options-page catalog text at binding time, before
 * enable/save handlers are installed, and again after every language change.
 * Local tag disclosure must never depend on whether a Sync account is present.
 */
export function localClassificationDisclosure(language: string): { consent: string; details: string } {
  if (language.toLowerCase().replace('_', '-').startsWith('zh')) return {
    consent: '将页面、文件夹和书签信息，以及本地和已同步的标签名称发送至此服务。',
    details: '请求包含当前页面的 URL 和标题、文件夹名称及描述、各文件夹中的少量书签标题和域名，以及从本地注释和已同步书签库中选取的标签名称。即使没有连接账号或同步书签库，也可能发送此浏览器中的本地标签。Know-N 不接收请求或回复。密钥仅保存在此浏览器，不会同步。',
  };
  return {
    consent: 'Send page, folder and bookmark details, and local and synced tag names, to this service.',
    details: "Requests include the page's URL and title, folder names and descriptions, a few bookmark titles and domains from each folder, and tag names selected from both browser-local annotations and your synced library. Local tags may be sent even when no account or library is synced. Know-N does not receive the request or reply. The key stays on this browser and is never synced.",
  };
}

export function bindLocalClassificationDisclosure(root: ParentNode): void {
  const consent = root.querySelector?.<HTMLElement>('#classification-local-disclosure-option .check-line span');
  const details = root.querySelector?.<HTMLElement>('#classification-local-disclosure-option .disclosure p');
  if (!consent || !details) return;
  // Do not let the legacy HTML/catalog entry overwrite the corrected notice.
  consent.removeAttribute('data-i18n');
  details.removeAttribute('data-i18n');
  const render = (): void => {
    const copy = localClassificationDisclosure(uiLanguage());
    consent.textContent = copy.consent;
    details.textContent = copy.details;
  };
  render();
  onUiLanguageChanged(render);
  void initI18n().then(render);
}
