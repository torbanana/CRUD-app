// POST /api/cheers and DELETE /api/cheers/:toUserId -- the one social action,
// capped at one clap per person, per person, per week.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { PAST_WEEK, createApp, currentWeekStart, signUp } from './helpers/app.mjs';

/** Two members, with the second's id handy. */
async function pair(app) {
  const alpha = await signUp(app, { name: 'Alpha' });
  const bravo = await signUp(app, { name: 'Bravo' });
  return { alpha, bravo };
}

describe('POST /api/cheers', () => {
  test('needs a session', async () => {
    const app = createApp();
    assert.equal((await app.request('POST', '/api/cheers', { body: { toUserId: 1 } })).status, 401);
  });

  test('records a cheer and shows it on the week view', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);

    const r = await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id, week: PAST_WEEK },
      cookie: alpha.cookie,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { added: true, alreadyCheered: false });

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    const target = week.body.members.find((m) => m.name === 'Bravo');
    assert.equal(target.cheersReceived, 1);
    assert.equal(target.cheeredByMe, true);
  });

  test('a second cheer for the same week is a no-op', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    const body = { toUserId: bravo.user.id, week: PAST_WEEK };

    await app.request('POST', '/api/cheers', { body, cookie: alpha.cookie });
    const again = await app.request('POST', '/api/cheers', { body, cookie: alpha.cookie });

    assert.deepEqual(again.body, { added: false, alreadyCheered: true });
    const { n } = await app.db.prepare('SELECT COUNT(*) AS n FROM cheers').first();
    assert.equal(n, 1);
  });

  test('the same pair may cheer again in a different week', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);

    for (const week of ['2020-01-06', '2020-01-13']) {
      const r = await app.request('POST', '/api/cheers', {
        body: { toUserId: bravo.user.id, week },
        cookie: alpha.cookie,
      });
      assert.equal(r.body.added, true, `${week} should be its own cheer`);
    }
  });

  test('defaults to the current week when none is given', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id },
      cookie: alpha.cookie,
    });

    const row = await app.db.prepare('SELECT week_start FROM cheers').first();
    assert.equal(row.week_start, currentWeekStart('Asia/Singapore'));
  });

  test('snaps any day in a week to that week\'s Monday', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    // Wednesday and Sunday of the same week are the same cheer.
    await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id, week: '2020-01-08' },
      cookie: alpha.cookie,
    });
    const sunday = await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id, week: '2020-01-12' },
      cookie: alpha.cookie,
    });

    assert.equal(sunday.body.added, false);
    assert.equal((await app.db.prepare('SELECT week_start FROM cheers').first()).week_start, '2020-01-06');
  });

  test('counts cheers from several members separately', async () => {
    const app = createApp();
    const alpha = await signUp(app, { name: 'Alpha' });
    const bravo = await signUp(app, { name: 'Bravo' });
    const charlie = await signUp(app, { name: 'Charlie' });

    for (const from of [alpha, charlie]) {
      await app.request('POST', '/api/cheers', {
        body: { toUserId: bravo.user.id, week: PAST_WEEK },
        cookie: from.cookie,
      });
    }

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: charlie.cookie });
    const target = week.body.members.find((m) => m.name === 'Bravo');
    assert.equal(target.cheersReceived, 2);
    assert.equal(target.cheeredByMe, true);

    const asBravo = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: bravo.cookie });
    assert.equal(asBravo.body.members.find((m) => m.name === 'Bravo').cheeredByMe, false);
  });

  test('refuses self-congratulation', async () => {
    const app = createApp();
    const { alpha } = await pair(app);
    const r = await app.request('POST', '/api/cheers', {
      body: { toUserId: alpha.user.id },
      cookie: alpha.cookie,
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not yourself/);
  });

  test('reports an unknown member as a 404, not a server error', async (t) => {
    const app = createApp();
    const { alpha } = await pair(app);
    // Regression: this reached the INSERT and tripped the foreign key. SQLite's
    // OR IGNORE covers UNIQUE and CHECK but not foreign keys, so it raised and
    // the route answered 500.
    t.mock.method(console, 'error', () => {});

    const r = await app.request('POST', '/api/cheers', {
      body: { toUserId: 9999 },
      cookie: alpha.cookie,
    });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no such member/i);
    assert.equal(console.error.mock.callCount(), 0, 'this is a client error, not an incident');
  });

  test('a member who has left cannot be cheered', async (t) => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    t.mock.method(console, 'error', () => {});
    await app.db.prepare('DELETE FROM users WHERE id = ?').bind(bravo.user.id).run();

    const r = await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id },
      cookie: alpha.cookie,
    });
    assert.equal(r.status, 404);
  });

  for (const [label, body, fragment] of [
    ['a missing target', {}, 'Which member'],
    ['a non-numeric target', { toUserId: 'bravo' }, 'Which member'],
    ['a fractional target', { toUserId: 1.5 }, 'Which member'],
    ['a malformed week', { toUserId: 2, week: 'last-week' }, 'valid date'],
    ['an impossible week', { toUserId: 2, week: '2020-02-31' }, 'valid date'],
  ]) {
    test(`rejects ${label}`, async () => {
      const app = createApp();
      await pair(app);
      const alpha = await signUp(app);
      const r = await app.request('POST', '/api/cheers', { body, cookie: alpha.cookie });
      assert.equal(r.status, 400);
      assert.match(r.body.error, new RegExp(fragment));
    });
  }
});

describe('DELETE /api/cheers/:toUserId', () => {
  test('needs a session', async () => {
    const app = createApp();
    assert.equal((await app.request('DELETE', '/api/cheers/1')).status, 401);
  });

  test('takes a cheer back', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id, week: PAST_WEEK },
      cookie: alpha.cookie,
    });

    const r = await app.request('DELETE', `/api/cheers/${bravo.user.id}?week=${PAST_WEEK}`, {
      cookie: alpha.cookie,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, 1);

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    const target = week.body.members.find((m) => m.name === 'Bravo');
    assert.equal(target.cheersReceived, 0);
    assert.equal(target.cheeredByMe, false);
  });

  test('un-cheering something that was never cheered is a no-op', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    const r = await app.request('DELETE', `/api/cheers/${bravo.user.id}?week=${PAST_WEEK}`, {
      cookie: alpha.cookie,
    });
    assert.equal(r.body.removed, 0);
  });

  test('only takes back my own cheer', async () => {
    const app = createApp();
    const alpha = await signUp(app, { name: 'Alpha' });
    const bravo = await signUp(app, { name: 'Bravo' });
    const charlie = await signUp(app, { name: 'Charlie' });
    await app.request('POST', '/api/cheers', {
      body: { toUserId: bravo.user.id, week: PAST_WEEK },
      cookie: alpha.cookie,
    });

    const r = await app.request('DELETE', `/api/cheers/${bravo.user.id}?week=${PAST_WEEK}`, {
      cookie: charlie.cookie,
    });
    assert.equal(r.body.removed, 0);

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    assert.equal(week.body.members.find((m) => m.name === 'Bravo').cheersReceived, 1);
  });

  test('defaults to the current week', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    await app.request('POST', '/api/cheers', { body: { toUserId: bravo.user.id }, cookie: alpha.cookie });

    const r = await app.request('DELETE', `/api/cheers/${bravo.user.id}`, { cookie: alpha.cookie });
    assert.equal(r.body.removed, 1);
  });

  test('un-cheering an unknown member is a harmless no-op', async () => {
    const app = createApp();
    const { alpha } = await pair(app);
    // DELETE touches no foreign key, so unlike POST this has always been fine
    // -- pin it so the two routes are not "fixed" into matching by accident.
    const r = await app.request('DELETE', '/api/cheers/9999', { cookie: alpha.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, 0);
  });

  test('rejects a non-numeric id or a malformed week', async () => {
    const app = createApp();
    const { alpha, bravo } = await pair(app);
    assert.equal((await app.request('DELETE', '/api/cheers/bravo', { cookie: alpha.cookie })).status, 400);
    const bad = await app.request('DELETE', `/api/cheers/${bravo.user.id}?week=nope`, {
      cookie: alpha.cookie,
    });
    assert.equal(bad.status, 400);
  });
});
