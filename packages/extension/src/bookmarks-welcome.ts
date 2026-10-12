import { createIcon } from './icons.js';
import { t } from './i18n.js';

/** Marks where an inline element goes inside a translated sentence, whatever the word order. */
const SLOT = '';

function sentence(copy: string, inline: Node): (string | Node)[] {
  const at = copy.indexOf(SLOT);
  return at < 0 ? [copy] : [copy.slice(0, at), inline, copy.slice(at + 1)];
}

/**
 * First-run steps: Know-N is installed (done), pin it to the toolbar, choose how
 * saving works. The Extensions hint and the Saving link sit inside their
 * sentences, so the whole sentence stays one translatable string.
 */
export function paintWelcomeSteps(list: HTMLElement): void {
  const step = (done: boolean, ...content: (string | Node)[]) => {
    const item = document.createElement('li');
    if (done) item.dataset.done = '';
    const text = document.createElement('span');
    text.append(...content);
    item.append(text);
    return item;
  };
  const extensions = document.createElement('span');
  extensions.className = 'pin-hint';
  const label = document.createElement('span');
  label.textContent = t('welcome_extensionsMenu', 'Extensions');
  extensions.append(createIcon('more-vertical', 14), label);
  const saving = document.createElement('a');
  saving.href = '#saving';
  saving.textContent = t('welcome_manualOrAutomatic', 'Manual or Automatic');
  list.replaceChildren(
    step(true, t('welcome_installed', 'Know-N is installed')),
    step(false, ...sentence(t('welcome_pinStep', 'Pin Know-N to your toolbar from the $1 menu', SLOT), extensions)),
    step(false, ...sentence(t('welcome_savingStep', 'Choose how saving works: $1', SLOT), saving)),
  );
}
