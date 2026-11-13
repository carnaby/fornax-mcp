/**
 * Browser JavaScript of the pairing page. It makes the token exactly like @fornax/protocol generateToken() and its
 * fingerprint exactly like fingerprint(); the tests run this same text under Node's WebCrypto. No backticks or "${"
 * inside: these are String.raw templates. No "<" either: the text goes into a script element.
 */
export const PAIR_CRYPTO_JS = String.raw`
function fornaxNewToken(name) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return 'fornax-' + name + '-' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fornaxFingerprint(token) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // The first 40 bits; a double holds them exactly.
  let bits = 0;
  for (let i = 0; i !== 5; i++) bits = bits * 256 + digest[i];
  let out = '';
  for (let i = 7; i >= 0; i--) out += alphabet[Math.floor(bits / 2 ** (i * 5)) % 32];
  return out.slice(0, 4) + '-' + out.slice(4);
}
`;

/** Fills the page in. The token stays in this page: it is shown, copied on request, and never sent anywhere. */
export const PAIR_PAGE_JS = String.raw`
async function fornaxPairPage(doc, win, config) {
  const show = (id, text) => { doc.getElementById(id).textContent = text; };
  if (!win.isSecureContext || !globalThis.crypto || !crypto.subtle) {
    show('problem', 'This page must be opened over HTTPS to make a token.');
    doc.getElementById('problem').hidden = false;
    return null;
  }
  const token = fornaxNewToken(config.name);
  show('token', token);
  show('claude-code', 'claude mcp add fornax --scope user --transport http ' + config.publicUrl + '/mcp --header "Authorization: Bearer ' + token + '"');
  show('connector', config.publicUrl + '/mcp/' + token);
  show('fingerprint', await fornaxFingerprint(token));
  for (const button of doc.querySelectorAll('button[data-copy]')) {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(doc.getElementById(button.dataset.copy).textContent);
      button.textContent = 'Copied';
    });
  }
  doc.getElementById('ready').hidden = false;
  return token;
}
`;
