import { keycloakLogin, register, registrationEnabled } from './api.js';

const $ = (id) => document.getElementById(id);

const oidcBlock = $('oidc-block');
// Set once the server has answered; `show` must never reveal a sign-in button on a
// deployment that has no provider configured.
let providerAvailable = false;
const registerForm = $('register-form');
const error = $('error');
const notice = $('notice');

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
  notice.hidden = true;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = !message;
  error.hidden = true;
}

/**
 * One card, two forms. The sign-up half only exists when the server says sign-ups are open —
 * ALLOW_SELF_REGISTRATION off leaves the link and the form out entirely rather than offering
 * a button that always fails.
 */
function show(which) {
  const registering = which === 'register';
  oidcBlock.hidden = registering || !providerAvailable;
  registerForm.hidden = !registering;
  $('to-register').hidden = registering;
  $('to-login').hidden = !registering;
  showError('');
  if (registering) $('r-username').focus();
}

async function withButton(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  await withButton($('r-submit'), 'Creating…', async () => {
    try {
      const created = await register({
        username: $('r-username').value.trim(),
        email: $('r-email').value.trim(),
        password: $('r-password').value,
      });

      // Straight back to sign-in rather than signing them in: the account exists in Keycloak,
      // and whether it may reach THIS server depends on a role an administrator grants there.
      show('login');
      $('username').value = created.username;
      showNotice(created.note ?? 'Account created. Sign in with the password you chose.');
    } catch (err) {
      showError(err.status === 429
        ? 'Too many accounts created from this address. Try again later.'
        : err.message);
      $('r-password').value = '';
    }
  });
});

$('show-register').addEventListener('click', (event) => {
  event.preventDefault();
  show('register');
});

$('show-login').addEventListener('click', (event) => {
  event.preventDefault();
  show('login');
});

/**
 * A failed Keycloak sign-in comes back as a redirect carrying its reason, because the
 * callback has no page of its own to say it on — a role that was never granted, a sign-in
 * that took longer than its ten minutes. Read once, then dropped from the address bar so a
 * reload does not show it again.
 */
const params = new URLSearchParams(window.location.search);
const failure = params.get('error');
if (failure) {
  showError(failure);
  window.history.replaceState(null, '', window.location.pathname);
}

const [signUps, keycloak] = await Promise.all([registrationEnabled(), keycloakLogin()]);
if (signUps) $('to-register').hidden = false;
providerAvailable = keycloak.enabled;
if (providerAvailable) oidcBlock.hidden = false;

/**
 * With the provider answering, nobody should have to press a button to be sent there: this
 * page has nothing else to offer. Two cases keep the page visible instead, and each matters:
 *
 *   - `?error=` — the redirect just came BACK with a refusal. Bouncing straight out again
 *     would spin the browser between the two servers and never show the reason.
 *   - the provider not answering — the server checked before we got here. An automatic
 *     redirect into an outage is what would strand an operator during the incident.
 *
 * `?local=1` used to be a third case. It asked for the password form, and there is no longer
 * one to ask for.
 */
if (keycloak.enabled && keycloak.reachable && !failure) {
  // replace(), not assign(): Back from the provider should reach whatever came before this
  // page, not this page again, which would only redirect once more.
  window.location.replace('/admin/api/auth/oidc/start');
} else if (keycloak.enabled && !keycloak.reachable) {
  showNotice('The identity provider is not answering, so nobody can sign in until it is back. '
    + 'This server holds no other account.');
} else if (!keycloak.enabled) {
  showError('No identity provider is configured on this server, and there is no local account.');
}
