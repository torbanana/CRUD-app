// PUT /api/entries and DELETE /api/entries/:date -- the app's core write path.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { PAST_DATES, PAST_WEEK, createApp, signUp, todayISO } from './helpers/app.mjs';

const TZ = 'Asia/Singapore';

describe('PUT /api/entries', () => {
  test('needs a session', async () => {
    const app = createApp();
    const r = await app.request('PUT', '/api/entries', { body: { date: PAST_DATES[0], steps: 1 } });
    assert.equal(r.status, 401);
  });

  test('records a day and reads it back on the week view', async () => {
    const app = createApp();
    const { cookie, user } = await signUp(app);

    const r = await app.request('PUT', '/api/entries', {
      body: { date: PAST_DATES[2], steps: 8412 },
      cookie,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entry, { user_id: user.id, date: PAST_DATES[2], steps: 8412 });

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie });
    assert.equal(week.body.members[0].days[PAST_DATES[2]], 8412);
    assert.equal(week.body.members[0].total, 8412);
  });

  test('overwrites rather than duplicating the same day', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);

    await app.request('PUT', '/api/entries', { body: { date: PAST_DATES[0], steps: 1000 }, cookie });
    const second = await app.request('PUT', '/api/entries', {
      body: { date: PAST_DATES[0], steps: 2000 },
      cookie,
    });

    assert.equal(second.body.entry.steps, 2000);
    const { n } = await app.db.prepare('SELECT COUNT(*) AS n FROM step_entries').first();
    assert.equal(n, 1, 'a correction updates the row, it does not add one');
  });

  test('accepts today in the configured timezone', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PUT', '/api/entries', {
      body: { date: todayISO(TZ), steps: 500 },
      cookie,
    });
    assert.equal(r.status, 200);
  });

  test('refuses a day that has not happened yet', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const tomorrow = new Date(Date.parse(`${todayISO(TZ)}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);

    const r = await app.request('PUT', '/api/entries', { body: { date: tomorrow, steps: 1 }, cookie });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /has not happened yet/);
  });

  test('the future boundary follows the group timezone, not the server', async () => {
    // Kiritimati is a day ahead of Honolulu, so a date that is "today" in one
    // is still "tomorrow" in the other.
    const ahead = createApp({ APP_TZ: 'Pacific/Kiritimati' });
    const behind = createApp({ APP_TZ: 'Pacific/Honolulu' });
    const aheadUser = await signUp(ahead);
    const behindUser = await signUp(behind);
    const aheadToday = todayISO('Pacific/Kiritimati');

    assert.equal(
      (await ahead.request('PUT', '/api/entries', { body: { date: aheadToday, steps: 1 }, cookie: aheadUser.cookie })).status,
      200
    );
    assert.equal(
      (await behind.request('PUT', '/api/entries', { body: { date: aheadToday, steps: 1 }, cookie: behindUser.cookie })).status,
      400
    );
  });

  test('accepts zero steps and the top of the sane range', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const [date, steps] of [[PAST_DATES[0], 0], [PAST_DATES[1], 200000]]) {
      const r = await app.request('PUT', '/api/entries', { body: { date, steps }, cookie });
      assert.equal(r.status, 200, `${steps} steps should be accepted`);
      assert.equal(r.body.entry.steps, steps);
    }
  });

  for (const [label, body, fragment] of [
    ['a missing date', { steps: 1 }, 'YYYY-MM-DD'],
    ['a malformed date', { date: '09/09/2026', steps: 1 }, 'YYYY-MM-DD'],
    ['a date that is not on the calendar', { date: '2026-02-30', steps: 1 }, 'YYYY-MM-DD'],
    ['a non-string date', { date: 20260909, steps: 1 }, 'YYYY-MM-DD'],
    ['negative steps', { date: '2020-01-06', steps: -1 }, 'zero or more'],
    ['fractional steps', { date: '2020-01-06', steps: 1.5 }, 'whole number'],
    ['steps beyond the sanity cap', { date: '2020-01-06', steps: 200001 }, 'typo'],
    ['unparseable steps', { date: '2020-01-06', steps: 'lots' }, 'whole number'],
  ]) {
    test(`rejects ${label}`, async () => {
      const app = createApp();
      const { cookie } = await signUp(app);
      const r = await app.request('PUT', '/api/entries', { body, cookie });
      assert.equal(r.status, 400);
      assert.match(r.body.error, new RegExp(fragment));
    });
  }

  test('writes to the session user, ignoring any id in the body', async () => {
    const app = createApp();
    const victim = await signUp(app, { name: 'Victim' });
    const attacker = await signUp(app, { name: 'Attacker' });

    await app.request('PUT', '/api/entries', {
      body: { date: PAST_DATES[0], steps: 9999 },
      cookie: victim.cookie,
    });
    const r = await app.request('PUT', '/api/entries', {
      body: { date: PAST_DATES[0], steps: 1, userId: victim.user.id, user_id: victim.user.id },
      cookie: attacker.cookie,
    });

    assert.equal(r.body.entry.user_id, attacker.user.id);
    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: victim.cookie });
    const victimRow = week.body.members.find((m) => m.name === 'Victim');
    assert.equal(victimRow.days[PAST_DATES[0]], 9999, "another member's day is untouched");
  });
});

describe('DELETE /api/entries/:date', () => {
  test('needs a session', async () => {
    const app = createApp();
    assert.equal((await app.request('DELETE', `/api/entries/${PAST_DATES[0]}`)).status, 401);
  });

  test('removes the day and reports one row gone', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    await app.request('PUT', '/api/entries', { body: { date: PAST_DATES[0], steps: 700 }, cookie });

    const r = await app.request('DELETE', `/api/entries/${PAST_DATES[0]}`, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, 1);

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie });
    assert.equal(week.body.members[0].total, 0);
    assert.deepEqual(week.body.members[0].days, {});
  });

  test('deleting a day that was never logged is a no-op', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('DELETE', `/api/entries/${PAST_DATES[3]}`, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, 0);
  });

  test('rejects a date that is not a real calendar date', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const date of ['tomorrow', '2026-13-01', '2026-2-3']) {
      const r = await app.request('DELETE', `/api/entries/${date}`, { cookie });
      assert.equal(r.status, 400, `${date} should be rejected`);
    }
  });

  test('cannot delete another member\'s day', async () => {
    const app = createApp();
    const victim = await signUp(app, { name: 'Victim' });
    const attacker = await signUp(app, { name: 'Attacker' });
    await app.request('PUT', '/api/entries', {
      body: { date: PAST_DATES[0], steps: 4321 },
      cookie: victim.cookie,
    });

    const r = await app.request('DELETE', `/api/entries/${PAST_DATES[0]}`, { cookie: attacker.cookie });
    assert.equal(r.body.removed, 0);

    const week = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: victim.cookie });
    assert.equal(week.body.members.find((m) => m.name === 'Victim').days[PAST_DATES[0]], 4321);
  });
});
