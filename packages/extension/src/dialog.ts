/* The one recipe for script-built modal dialogs: a heading that names the
   dialog, a body for copy and fields, and a right-aligned action row, all
   styled by .capture-dialog in options.css. Appending copy and buttons straight
   into a bare <dialog> renders an unspaced wall of text with touching buttons. */
export interface DialogParts { dialog: HTMLDialogElement; body: HTMLDivElement; actions: HTMLDivElement }

export function createDialog(title: string, className?: string): DialogParts {
  const dialog = document.createElement('dialog'), heading = document.createElement('h3');
  const body = document.createElement('div'), actions = document.createElement('div');
  dialog.className = className ? `capture-dialog ${className}` : 'capture-dialog';
  heading.id = `dialog-title-${crypto.randomUUID()}`; heading.textContent = title; dialog.setAttribute('aria-labelledby', heading.id);
  body.className = 'capture-dialog-body'; actions.className = 'capture-dialog-actions';
  dialog.append(heading, body, actions);
  return { dialog, body, actions };
}

export function dialogButton(label: string, tone: 'primary' | 'secondary' | 'danger' | 'ghost' = 'ghost'): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = `btn btn-${tone}`;
  return button;
}
