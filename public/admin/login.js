import { login } from './api.js';

const form = document.getElementById('login-form');
const submit = document.getElementById('submit');
const error = document.getElementById('error');

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  submit.disabled = true;
  submit.textContent = 'Signing in…';

  try {
    await login(
      document.getElementById('username').value.trim(),
      document.getElementById('password').value,
    );
    // The access token is in memory and this navigation discards it — that is fine, because
    // the refresh cookie survives and the dashboard exchanges it for a fresh one on load.
    window.location.replace('/admin/');
  } catch (err) {
    showError(err.status === 429
      ? 'Too many failed attempts. Wait for the lockout window to pass.'
      : err.message);
    document.getElementById('password').value = '';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});
