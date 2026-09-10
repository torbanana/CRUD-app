// The sign-in / join page.
//
// This used to be an inline <script> in login.html. It lives in its own file so
// the Content-Security-Policy can say script-src 'self' with no 'unsafe-inline'
// escape hatch -- which is the difference between a policy that stops injected
// script and one that only looks like it does.

import { api } from '/js/api.js';

const el = (id) => document.getElementById(id);
const errorBox = el('error');

let chosenAvatar = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function selectTab(which) {
  const joining = which === 'join';
  el('tabLogin').setAttribute('aria-selected', String(!joining));
  el('tabJoin').setAttribute('aria-selected', String(joining));
  el('loginForm').hidden = joining;
  el('joinForm').hidden = !joining;
  showError('');
}

el('tabLogin').addEventListener('click', () => selectTab('login'));
el('tabJoin').addEventListener('click', () => selectTab('join'));

// Load group details so the page can name the group and say whether there is
// still room to join.
try {
  const config = await api.config();
  el('groupName').textContent = config.groupName;
  el('groupSub').textContent = `A weekly step race for ${config.maxMembers} people`;

  for (const emoji of config.avatars) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = emoji;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      chosenAvatar = emoji;
      for (const other of el('avatarPicker').children) {
        other.setAttribute('aria-pressed', String(other === button));
      }
    });
    el('avatarPicker').append(button);
  }

  if (config.full) {
    el('tabJoin').disabled = true;
    el('tabJoin').title = `The group is full (${config.maxMembers} members)`;
    el('demoNote').hidden = false;
    // This panel used to print a working demo email and password. On a public
    // URL that is not a hint, it is a set of credentials -- and the seeded
    // accounts it referred to are real accounts with real sessions. It now says
    // only that the group is closed; whoever runs the demo can share the
    // sign-in details out of band.
    el('demoNote').textContent =
      `All ${config.maxMembers} places are taken. Ask whoever set up this group to sign you in.`;
  }
} catch {
  showError('Could not reach the server. Is it running?');
}

el('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  el('loginSubmit').disabled = true;
  try {
    await api.login({
      email: el('loginEmail').value,
      password: el('loginPassword').value,
    });
    location.href = '/';
  } catch (err) {
    showError(err.message);
    el('loginSubmit').disabled = false;
  }
});

el('joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  if (!chosenAvatar) return showError('Pick a runner to represent you on the track.');

  el('joinSubmit').disabled = true;
  try {
    await api.signup({
      name: el('joinName').value,
      email: el('joinEmail').value,
      password: el('joinPassword').value,
      inviteCode: el('joinInvite').value.trim(),
      avatar: chosenAvatar,
    });
    location.href = '/';
  } catch (err) {
    showError(err.message);
    el('joinSubmit').disabled = false;
  }
});
