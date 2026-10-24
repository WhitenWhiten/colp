/**
 * The confirmation strip every Reset shows before it touches anything: the question, a danger button that does it and a
 * quiet one that does not. It sits just above the feedback line of its card, takes focus, answers Escape as "no", and puts
 * focus back on the button that opened it. Nothing is sent until the person has pressed the danger button.
 */
export function askResetConfirmation(hostButton: HTMLButtonElement, feedbackElement: HTMLElement, question: string,
  labels: { readonly confirm: string; readonly keep: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const strip = document.createElement('div'); strip.className = 'rebuild-confirm';
    const copy = document.createElement('p'); copy.className = 'rebuild-confirm-copy'; copy.textContent = question;
    const actions = document.createElement('div'); actions.className = 'row-actions';
    const confirmButton = document.createElement('button'); confirmButton.type = 'button';
    confirmButton.className = 'btn btn-danger btn-sm'; confirmButton.textContent = labels.confirm;
    const keepButton = document.createElement('button'); keepButton.type = 'button';
    keepButton.className = 'btn btn-ghost btn-sm'; keepButton.textContent = labels.keep;
    const settle = (proceed: boolean) => { strip.remove(); if (!proceed) hostButton.focus(); resolve(proceed); };
    confirmButton.addEventListener('click', () => settle(true));
    keepButton.addEventListener('click', () => settle(false));
    strip.addEventListener('keydown', (event) => { if (event.key === 'Escape') settle(false); });
    actions.append(confirmButton, keepButton); strip.append(copy, actions); feedbackElement.before(strip);
    confirmButton.focus();
  });
}
