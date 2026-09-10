// The "set a new password" page, reached through a link an operator minted
// with `npm run reset-password`.
//
// The token is in the URL fragment, not the query string: `/reset#<token>`.
// Browsers never send a fragment to the server, so the token stays out of
// request logs, out of Cloudflare's observability traces and out of any
// Referer header. We read it here and put it in a POST body instead.

import { api } from '/js/api.js';

const el = (id) => document.getElementById(id);

function showError(message) {
  el('error').textContent = message;
  el('error').hidden = !message;
  el('resetHelp').hidden = !message;
}

const token = location.hash.slice(1).trim();

// Drop the token out of the address bar and the history entry as soon as we
// have it. It stays in this variable for the life of the page; it does not
// need to stay somewhere the next person to use this browser can read it.
if (token) history.replaceState(null, '', location.pathname);

if (!token) {
  el('resetSub').textContent = 'This link is incomplete.';
  showError('That link is missing its token. Copy the whole thing, including the # part.');
} else {
  try {
    const { name } = await api.resetCheck(token);
    el('resetSub').textContent = `Hello ${name} — choose a new password.`;
    el('resetForm').hidden = false;
    el('newPassword').focus();
  } catch (err) {
    el('resetSub').textContent = 'This link cannot be used.';
    showError(err.message);
  }
}

el('resetForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const password = el('newPassword').value;
  if (password !== el('confirmPassword').value) {
    return showError('Those two passwords are not the same.');
  }

  el('resetSubmit').disabled = true;
  try {
    await api.resetPassword(token, password);
    // The server signed us in as part of the reset, so go straight to the app.
    location.href = '/';
  } catch (err) {
    showError(err.message);
    el('resetSubmit').disabled = false;
  }
});
