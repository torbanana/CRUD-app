// POST /api/auth/signup, /login, /logout, and GET /api/me.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_CODE, cookieFrom, createApp, signUp } from './helpers/app.mjs';

describe('POST /api/auth/signup', () => {
  test('creates a member and signs them straight in', async () => {
    const app = createApp();
    const { response, user, cookie } = await signUp(app, {
      email: 'ada@example.com',
      name: 'Ada',
      avatar: '🦉',
    });

    assert.equal(response.status, 201);
    assert.equal(user.email, 'ada@example.com');
    assert.equal(user.name, 'Ada');
    assert.equal(user.avatar, '🦉');
    assert.equal(user.weekly_goal, 70000);
    assert.ok(!('password_hash' in user), 'the password hash must never be returned');

    const me = await app.request('GET', '/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, user.id);
  });

  test('sets an httpOnly, SameSite=Lax session cookie', async () => {
    const app = createApp();
    const { response } = await signUp(app);
    const setCookie = response.headers.get('set-cookie');

    assert.match(setCookie, /^sid=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/, 'https requests must get a Secure cookie');
  });

  test('omits Secure over plain http, where the browser would drop it', async () => {
    const app = createApp();
    const response = await app.request('POST', '/api/auth/signup', {
      body: { email: 'h@example.com', name: 'Http', password: 'password123', inviteCode: INVITE_CODE },
    });
    // The harness always uses https, so drive the http case through the URL.
    const direct = await (await import('../worker/index.js')).default.fetch(
      new Request('http://127.0.0.1:8787/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'h@example.com', password: 'password123' }),
      }),
      app.env,
      app.ctx
    );
    assert.equal(response.status, 201);
    assert.equal(direct.status, 200);
    assert.ok(!direct.headers.get('set-cookie').includes('Secure'));
  });

  test('assigns a default avatar when none is picked', async () => {
    const app = createApp();
    const { user } = await signUp(app, { avatar: undefined });
    assert.ok(typeof user.avatar === 'string' && user.avatar.length > 0);
  });

  for (const [label, overrides, status, fragment] of [
    ['a missing email', { email: undefined }, 400, 'valid email'],
    ['a malformed email', { email: 'not-an-email' }, 400, 'valid email'],
    ['an email with spaces', { email: 'a b@example.com' }, 400, 'valid email'],
    ['a one-character name', { name: 'A' }, 400, '2 and 30'],
    ['a 31-character name', { name: 'x'.repeat(31) }, 400, '2 and 30'],
    ['a non-string name', { name: 42 }, 400, '2 and 30'],
    ['a 7-character password', { password: '1234567' }, 400, 'at least 8'],
    ['a missing password', { password: undefined }, 400, 'at least 8'],
    ['the wrong invite code', { inviteCode: 'NOPE' }, 403, 'invite code'],
    ['a missing invite code', { inviteCode: undefined }, 403, 'invite code'],
    ['an avatar that is not on the list', { avatar: '💣' }, 400, 'offered avatars'],
  ]) {
    test(`rejects ${label}`, async () => {
      const app = createApp();
      const { response } = await signUp(app, overrides);
      assert.equal(response.status, status);
      assert.match(response.body.error, new RegExp(fragment));
    });
  }

  test('rejects a duplicate email regardless of case or padding', async () => {
    const app = createApp();
    await signUp(app, { email: 'dup@example.com' });

    for (const email of ['dup@example.com', 'DUP@example.com', '  dup@example.com  ']) {
      const { response } = await signUp(app, { email });
      assert.equal(response.status, 409, `${email} should collide`);
    }
    assert.equal((await app.request('GET', '/api/config')).body.memberCount, 1);
  });

  test('refuses to admit an eleventh member', async () => {
    const app = createApp({ MAX_MEMBERS: '3' });
    for (let i = 0; i < 3; i++) assert.equal((await signUp(app)).response.status, 201);

    const { response } = await signUp(app);
    assert.equal(response.status, 403);
    assert.match(response.body.error, /full \(3 members\)/);
    assert.equal((await app.request('GET', '/api/config')).body.memberCount, 3);
  });

  test('stores the password hashed, never in the clear', async () => {
    const app = createApp();
    await signUp(app, { email: 'hash@example.com', password: 'password123' });
    const row = await app.db.prepare('SELECT password_hash FROM users WHERE email = ?')
      .bind('hash@example.com').first();

    assert.match(row.password_hash, /^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(!row.password_hash.includes('password123'));
  });
});

describe('POST /api/auth/login', () => {
  test('accepts the right password and starts a session', async () => {
    const app = createApp();
    const { payload, user } = await signUp(app);

    const login = await app.request('POST', '/api/auth/login', {
      body: { email: payload.email, password: payload.password },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, user.id);
    assert.ok(!('password_hash' in login.body.user));

    const me = await app.request('GET', '/api/me', { cookie: cookieFrom(login) });
    assert.equal(me.body.user.id, user.id);
  });

  test('is case-insensitive about the email', async () => {
    const app = createApp();
    const { payload } = await signUp(app, { email: 'case@example.com' });
    const login = await app.request('POST', '/api/auth/login', {
      body: { email: 'CASE@EXAMPLE.COM', password: payload.password },
    });
    assert.equal(login.status, 200);
  });

  test('gives the same answer for a wrong password and an unknown member', async () => {
    const app = createApp();
    const { payload } = await signUp(app);

    const wrongPassword = await app.request('POST', '/api/auth/login', {
      body: { email: payload.email, password: 'wrong-password' },
    });
    const unknownEmail = await app.request('POST', '/api/auth/login', {
      body: { email: 'nobody@example.com', password: 'password123' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body, 'must not reveal who is a member');
    assert.equal(wrongPassword.headers.get('set-cookie'), null);
  });

  test('rejects a body that is missing or the wrong shape', async () => {
    const app = createApp();
    for (const body of [{}, { email: 'a@b.com' }, { password: 'x' }, { email: 1, password: 2 }]) {
      const r = await app.request('POST', '/api/auth/login', { body });
      assert.equal(r.status, 400);
    }
    assert.equal((await app.request('POST', '/api/auth/login', { body: '{oops' })).status, 400);
    assert.equal((await app.request('POST', '/api/auth/login')).status, 400);
  });
});

describe('POST /api/auth/logout', () => {
  test('invalidates the session server-side, not just the cookie', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    assert.equal((await app.request('GET', '/api/me', { cookie })).status, 200);

    const out = await app.request('POST', '/api/auth/logout', { cookie });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /^sid=;.*Max-Age=0/);

    // Replaying the old cookie must fail: the row is gone, not just expired.
    assert.equal((await app.request('GET', '/api/me', { cookie })).status, 401);
    const rows = await app.db.prepare('SELECT COUNT(*) AS n FROM sessions').first();
    assert.equal(rows.n, 0);
  });

  test('succeeds when there is no session to end', async () => {
    const app = createApp();
    assert.equal((await app.request('POST', '/api/auth/logout')).status, 200);
    assert.equal((await app.request('POST', '/api/auth/logout', { cookie: 'sid=nope' })).status, 200);
  });
});

describe('GET /api/me', () => {
  test('needs a session', async () => {
    const app = createApp();
    const anonymous = await app.request('GET', '/api/me');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.body.error, /sign in/);
  });

  test('rejects an unknown or expired token', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    assert.equal((await app.request('GET', '/api/me', { cookie: 'sid=deadbeef' })).status, 401);

    await app.db.prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00'").run();
    assert.equal((await app.request('GET', '/api/me', { cookie })).status, 401);
  });

  test('ignores unrelated cookies alongside the session', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('GET', '/api/me', { cookie: `theme=dark; ${cookie}; other=1` });
    assert.equal(r.status, 200);
  });
});
