// Thin wrapper over fetch. Every call sends the session cookie, and any
// non-2xx response becomes a thrown Error carrying the server's own message,
// so callers can put err.message straight in front of the user.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    // The session expired or was never there. Bounce to the login page.
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('Please sign in again.');
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* some responses have no body */
  }

  if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload;
}

export const api = {
  config: () => request('GET', '/api/config'),

  signup: (data) => request('POST', '/api/auth/signup', data),
  login: (data) => request('POST', '/api/auth/login', data),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/me'),
  updateMe: (patch) => request('PATCH', '/api/me', patch),

  // Password reset. The token goes in the body, never the URL -- see reset.js.
  resetCheck: (token) => request('POST', '/api/auth/reset/check', { token }),
  resetPassword: (token, password) => request('POST', '/api/auth/reset', { token, password }),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/auth/change-password', { currentPassword, newPassword }),

  week: (weekStart) =>
    request('GET', weekStart ? `/api/week?week=${encodeURIComponent(weekStart)}` : '/api/week'),

  logSteps: (date, steps) => request('PUT', '/api/entries', { date, steps }),
  clearDay: (date) => request('DELETE', `/api/entries/${date}`),

  cheer: (toUserId, week) => request('POST', '/api/cheers', { toUserId, week }),
  uncheer: (toUserId, week) =>
    request('DELETE', `/api/cheers/${toUserId}?week=${encodeURIComponent(week)}`),

  updateGroup: (patch) => request('PATCH', '/api/group', patch),
};

/** 62400 -> "62,400" */
export const fmt = (n) => Number(n || 0).toLocaleString('en-US');
