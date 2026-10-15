import { t, tn } from '../i18n.js';
import { el } from '../library-dom.js';
import type { AutomationStateView } from './messages.js';

/**
 * How a page you save finds its folder (browser rules follow-up U3): the five steps in the order the
 * worker takes them (design 01 §7.5), each with what it does here right now. Nothing here is a control;
 * a step that is set up elsewhere links there.
 */
interface Step { readonly title: string; readonly state: string; readonly tone?: 'muted' | 'warning'; readonly link?: { readonly label: string; readonly href: string } }

function accountStep(view: AutomationStateView): Step {
  const title = t('automation_flowAccount', 'Your account’s rules');
  if (view.account === 'signedOut') return { title, state: t('automation_flowSignIn', 'Sign in to use them'), tone: 'muted' };
  if (view.state === 'paused') return { title, state: t('automation_flowPaused', 'Paused'), tone: 'warning' };
  if (view.state === 'expired') return { title, state: t('automation_flowOutOfDate', 'Out of date'), tone: 'warning' };
  return view.state === 'active' && view.rules.length
    ? { title, state: tn('automation_flowOn', view.rules.length, '$1 on', '$1 on') }
    : { title, state: t('automation_flowNone', 'None yet'), tone: 'muted' };
}

function browserStep(view: AutomationStateView): Step {
  const title = t('automation_browserRules', 'Rules in this browser');
  if (view.account === 'signedIn' && view.state === 'paused') return { title, state: t('automation_flowPaused', 'Paused'), tone: 'warning' };
  const on = view.browserRules.filter((rule) => rule.enabled && !rule.folderMissing).length;
  if (on) return { title, state: tn('automation_flowOn', on, '$1 on', '$1 on') };
  return { title, state: view.browserRules.length ? t('automation_flowAllOff', 'All off') : t('automation_flowNone', 'None yet'), tone: 'muted' };
}

/** The AI files a page only in Automatic mode; in Manual mode the form decides, perhaps with a suggestion. */
function aiStep(view: AutomationStateView): Step {
  const title = t('automation_flowAi', 'AI');
  const { mode, ai, suggestInForm } = view.saving;
  if (mode === 'manual') {
    return { title, state: ai && suggestInForm ? t('automation_flowAiSuggests', 'Suggests in the form')
      : t('automation_flowAiManual', 'You choose in the form'), tone: 'muted',
    link: { label: t('automation_flowManual', 'Manual mode'), href: '#saving' } };
  }
  if (!ai) return { title, state: t('automation_flowAiOff', 'Off'), tone: 'muted', link: { label: t('automation_flowSetUp', 'Set up'), href: '#ai' } };
  return { title, state: ai === 'own' ? t('automation_flowAiOwn', 'Your AI service picks one') : t('automation_flowAiKnowN', 'Know-N picks one') };
}

export function flowStrip(view: AutomationStateView): HTMLElement {
  const steps: Step[] = [
    { title: t('automation_flowChosen', 'A folder you pick'), state: t('automation_flowAlwaysWins', 'Always wins') },
    accountStep(view),
    browserStep(view),
    aiStep(view),
    { title: t('automation_flowOtherwise', 'Otherwise'), state: t('automation_flowStays', 'Stays where you saved it') },
  ];
  const section = el('section', undefined, 'set-group automation-flow');
  section.setAttribute('aria-labelledby', 'automation-flow-heading');
  const head = el('div', undefined, 'set-group-head');
  const heading = el('h2', t('automation_flowTitle', 'How a page you save finds its folder'));
  heading.id = 'automation-flow-heading';
  head.append(heading);
  const list = el('ol', undefined, 'automation-flow-steps');
  steps.forEach((step, index) => {
    const item = el('li', undefined, 'automation-flow-step');
    item.append(el('span', String(index + 1), 'automation-flow-n'));
    const text = el('div', undefined, 'automation-flow-text');
    const state = el('p', step.state, 'automation-flow-state');
    if (step.tone) state.dataset.tone = step.tone;
    if (step.link) {
      const link = el('a', step.link.label); link.href = step.link.href;
      state.append(' · ', link);
    }
    text.append(el('p', step.title, 'automation-flow-name'), state);
    item.append(text);
    list.append(item);
  });
  section.append(head, list);
  return section;
}
