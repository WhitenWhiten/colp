const result = document.querySelector('#result');

chrome.runtime.sendMessage({ kind: 'known.auth.redirect-uri' }).then(({ redirectUri }) => {
  result.textContent = redirectUri;
});

document.querySelector('#login').addEventListener('click', async () => {
  const { evidenceAuthorizationUrl } = await chrome.storage.session.get('evidenceAuthorizationUrl');
  const response = await chrome.runtime.sendMessage({
    kind: 'known.auth.launch',
    authorizationUrl: evidenceAuthorizationUrl
      ?? new URL('oauth2/authorize', 'https://issuer.example.test/').toString(),
  });
  result.textContent = response.outcome;
});
