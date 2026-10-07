const pending = new Map();

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.kind === 'known.auth.redirect-uri') {
    respond({ redirectUri: chrome.identity.getRedirectURL('oauth2') });
    return false;
  }
  if (message?.kind !== 'known.auth.launch') return false;

  const requestId = crypto.randomUUID();
  pending.set(requestId, true);
  chrome.identity.launchWebAuthFlow({ url: message.authorizationUrl, interactive: true })
    .then(() => {
      pending.delete(requestId);
      respond({ outcome: 'redirect' });
    })
    .catch((error) => {
      pending.delete(requestId);
      respond({ outcome: 'cancelled', reason: error?.message ?? 'cancelled' });
    });
  return true;
});
