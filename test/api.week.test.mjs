// GET /api/week -- the one payload the whole UI renders from. Everything here
// is derived from raw step_entries rows, so these tests are really about the
// arithmetic: totals, ranks, pace, rivals and the group goal.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURE_WEEK,
  PAST_DATES,
  PAST_WEEK,
  createApp,
  currentWeekStart,
  signUp,
  todayISO,
} from './helpers/app.mjs';

const TZ = 'Asia/Singapore';

/** Seed a fixed, finished week so totals are deterministic whenever tests run. */
async function seedPastWeek(app) {
  const alpha = await signUp(app, { name: 'Alpha' });
  const bravo = await signUp(app, { name: 'Bravo' });
  const charlie = await signUp(app, { name: 'Charlie' });

  const log = (member, date, steps) =>
    app.request('PUT', '/api/entries', { body: { date, steps }, cookie: member.cookie });

  await log(alpha, PAST_DATES[0], 12000);
  await log(alpha, PAST_DATES[1], 8000); // 20000
  await log(bravo, PAST_DATES[0], 5000); // 5000
  await log(charlie, PAST_DATES[0], 5000); // 5000, tied with Bravo

  return { alpha, bravo, charlie };
}

describe('GET /api/week', () => {
  test('needs a session', async () => {
    const app = createApp();
    assert.equal((await app.request('GET', '/api/week')).status, 401);
  });

  test('defaults to the current week', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const { body } = await app.request('GET', '/api/week', { cookie });

    assert.equal(body.weekStart, currentWeekStart(TZ));
    assert.equal(body.isCurrentWeek, true);
    assert.equal(body.today, todayISO(TZ));
  });

  test('accepts any day inside a week and snaps to its Monday', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);

    for (const day of PAST_DATES) {
      const { body } = await app.request('GET', `/api/week?week=${day}`, { cookie });
      assert.equal(body.weekStart, PAST_WEEK, `${day} belongs to ${PAST_WEEK}`);
      assert.equal(body.weekEnd, PAST_DATES[6]);
    }
  });

  test('lays out the seven days Monday first', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie });

    assert.equal(body.dates.length, 7);
    assert.deepEqual(body.dates.map((d) => d.dayName), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.deepEqual(body.dates.map((d) => d.iso), PAST_DATES);
    assert.ok(body.dates.every((d) => d.isToday === false && d.isFuture === false));
  });

  test('marks today and the days still to come in the current week', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const { body } = await app.request('GET', '/api/week', { cookie });

    const today = body.dates.filter((d) => d.isToday);
    assert.equal(today.length, 1);
    assert.equal(today[0].iso, todayISO(TZ));
    assert.ok(body.dates.every((d) => d.isFuture === d.iso > body.today));
  });

  test('totals each member and ranks them, sharing a rank on a tie', async () => {
    const app = createApp();
    const { bravo } = await seedPastWeek(app);
    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: bravo.cookie });

    assert.deepEqual(
      body.members.map((m) => [m.name, m.total, m.rank]),
      [['Alpha', 20000, 1], ['Bravo', 5000, 2], ['Charlie', 5000, 2]]
    );
  });

  test('breaks ties by name so the order is stable', async () => {
    const app = createApp();
    const { alpha } = await seedPastWeek(app);
    const first = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    const second = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    assert.deepEqual(
      first.body.members.map((m) => m.name),
      second.body.members.map((m) => m.name)
    );
  });

  test('flags the viewer and reports their per-day breakdown', async () => {
    const app = createApp();
    const { alpha } = await seedPastWeek(app);
    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });

    const me = body.members.filter((m) => m.isMe);
    assert.equal(me.length, 1);
    assert.equal(me[0].name, 'Alpha');
    assert.deepEqual(me[0].days, { [PAST_DATES[0]]: 12000, [PAST_DATES[1]]: 8000 });
    assert.equal(me[0].loggedDays, 2);
    assert.equal(me[0].lastLoggedDate, PAST_DATES[1]);
    assert.equal(me[0].lastLoggedDay, 'Tue');
  });

  test('judges a finished week against the whole goal', async () => {
    const app = createApp();
    const { alpha } = await seedPastWeek(app);
    await app.request('PATCH', '/api/me', { body: { weeklyGoal: 40000 }, cookie: alpha.cookie });

    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    const me = body.members.find((m) => m.isMe);

    assert.equal(body.daysElapsed, 7, 'a past week is over');
    assert.equal(me.paceTarget, 40000);
    assert.equal(me.paceDelta, 20000 - 40000);
    assert.equal(me.goalPercent, 50);
  });

  test('pro-rates the pace target through the current week', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    await app.request('PATCH', '/api/me', { body: { weeklyGoal: 70000 }, cookie });

    const { body } = await app.request('GET', '/api/week', { cookie });
    const me = body.members.find((m) => m.isMe);

    assert.ok(body.daysElapsed >= 1 && body.daysElapsed <= 7);
    assert.equal(me.paceTarget, Math.round((70000 * body.daysElapsed) / 7));
  });

  test('greys out members who have not logged today', async () => {
    const app = createApp();
    const logged = await signUp(app, { name: 'Logged' });
    await signUp(app, { name: 'Silent' });
    await app.request('PUT', '/api/entries', {
      body: { date: todayISO(TZ), steps: 3000 },
      cookie: logged.cookie,
    });

    const { body } = await app.request('GET', '/api/week', { cookie: logged.cookie });
    const byName = Object.fromEntries(body.members.map((m) => [m.name, m]));

    assert.equal(byName.Logged.hasLoggedToday, true);
    assert.equal(byName.Logged.isGhost, false);
    assert.equal(byName.Silent.hasLoggedToday, false);
    assert.equal(byName.Silent.isGhost, true);
    assert.equal(body.group.loggedToday, 1);
  });

  test('nobody is a ghost in a finished week', async () => {
    const app = createApp();
    const { alpha } = await seedPastWeek(app);
    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    assert.ok(body.members.every((m) => m.isGhost === false));
  });

  test('reports the rivals immediately ahead of and behind me', async () => {
    const app = createApp();
    const alpha = await signUp(app, { name: 'Alpha' });
    const bravo = await signUp(app, { name: 'Bravo' });
    const charlie = await signUp(app, { name: 'Charlie' });
    const log = (m, steps) =>
      app.request('PUT', '/api/entries', { body: { date: PAST_DATES[0], steps }, cookie: m.cookie });
    await log(alpha, 30000);
    await log(bravo, 20000);
    await log(charlie, 5000);

    const middle = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: bravo.cookie });
    assert.deepEqual(middle.body.rivals.ahead, { name: 'Alpha', avatar: alpha.user.avatar, gap: 10000 });
    assert.deepEqual(middle.body.rivals.behind, { name: 'Charlie', avatar: charlie.user.avatar, gap: 15000 });

    const leader = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    assert.equal(leader.body.rivals.ahead, null);
    assert.equal(leader.body.rivals.behind.name, 'Bravo');

    const last = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: charlie.cookie });
    assert.equal(last.body.rivals.behind, null);
    assert.equal(last.body.rivals.ahead.name, 'Bravo');
  });

  test('skips over members tied with me when picking rivals', async () => {
    const app = createApp();
    const alpha = await signUp(app, { name: 'Alpha' });
    const bravo = await signUp(app, { name: 'Bravo' });
    const charlie = await signUp(app, { name: 'Charlie' });
    const log = (m, steps) =>
      app.request('PUT', '/api/entries', { body: { date: PAST_DATES[0], steps }, cookie: m.cookie });
    await log(alpha, 10000);
    await log(bravo, 10000); // tied with Alpha
    await log(charlie, 1000);

    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: bravo.cookie });
    assert.equal(body.rivals.ahead, null, 'a tie is not "ahead"');
    assert.equal(body.rivals.behind.name, 'Charlie');
  });

  test('sums the group goal and caps its percentage at 100', async () => {
    const app = createApp();
    const { alpha } = await seedPastWeek(app);

    const before = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    assert.equal(before.body.group.total, 30000);
    assert.equal(before.body.group.memberCount, 3);
    assert.equal(before.body.group.goal, 750000);
    assert.equal(before.body.group.percent, 4);

    await app.request('PATCH', '/api/group', {
      body: { journeyGoalSteps: 10000 },
      cookie: alpha.cookie,
    });
    const after = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });
    assert.equal(after.body.group.percent, 100, 'overshooting the goal does not exceed 100%');
  });

  test('reflects the group name and destination', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    await app.request('PATCH', '/api/group', {
      body: { groupName: 'The Nine', journeyName: 'Osaka' },
      cookie,
    });

    const { body } = await app.request('GET', '/api/week', { cookie });
    assert.equal(body.group.name, 'The Nine');
    assert.equal(body.group.journeyName, 'Osaka');
  });

  test('places milestone flags past the leader', async () => {
    const app = createApp();
    const { alpha } = await seedPastWeek(app);
    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: alpha.cookie });

    assert.equal(body.maxSteps, 20000);
    assert.equal(body.milestones[0], 10000);
    assert.ok(body.milestones.at(-1) > body.maxSteps, 'the track runs past the leader');
    assert.ok(body.milestones.every((m, i) => i === 0 || m - body.milestones[i - 1] === 10000));
  });

  test('keeps a minimum track length for an empty week', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie });

    assert.equal(body.maxSteps, 0);
    assert.deepEqual(body.members[0].days, {});
    assert.equal(body.members[0].total, 0);
    assert.equal(body.members[0].lastLoggedDate, null);
    assert.equal(body.members[0].lastLoggedDay, null);
    assert.ok(body.milestones.length >= 3);
  });

  test('lists the weeks that hold data, newest first', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const date of ['2020-01-08', '2020-01-15', '2020-01-22']) {
      await app.request('PUT', '/api/entries', { body: { date, steps: 100 }, cookie });
    }

    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie });
    assert.deepEqual(body.archiveWeeks, ['2020-01-20', '2020-01-13', '2020-01-06']);
  });

  test('labels the week, repeating the month only when it straddles two', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const label = async (week) =>
      (await app.request('GET', `/api/week?week=${week}`, { cookie })).body.weekLabel;

    assert.equal(await label('2026-09-07'), '7 - 13 Sept 2026');
    assert.equal(await label('2026-08-31'), '31 Aug - 6 Sept 2026');
    assert.equal(await label('2026-12-28'), '28 Dec - 3 Jan 2027');
  });

  test('a week that has not started counts as zero days elapsed', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const { body } = await app.request('GET', `/api/week?week=${FUTURE_WEEK}`, { cookie });

    assert.equal(body.daysElapsed, 0);
    assert.equal(body.isCurrentWeek, false);
    assert.equal(body.members[0].paceTarget, 0);
    assert.equal(body.members[0].total, 0);
  });

  test('rejects a week parameter that is not a real date', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const week of ['garbage', '2026-02-30', '26-01-01', '2026-1-1']) {
      const r = await app.request('GET', `/api/week?week=${week}`, { cookie });
      assert.equal(r.status, 400, `${week} should be rejected`);
      assert.match(r.body.error, /valid date/);
    }
  });

  test('an empty week parameter falls back to the current week', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const { body } = await app.request('GET', '/api/week?week=', { cookie });
    assert.equal(body.weekStart, currentWeekStart(TZ));
  });

  test('shows every member, including those who logged nothing', async () => {
    const app = createApp();
    const active = await signUp(app, { name: 'Active' });
    await signUp(app, { name: 'Absent' });
    await app.request('PUT', '/api/entries', {
      body: { date: PAST_DATES[0], steps: 1000 },
      cookie: active.cookie,
    });

    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie: active.cookie });
    assert.equal(body.members.length, 2);
    assert.equal(body.members.find((m) => m.name === 'Absent').total, 0);
    assert.equal(body.members.find((m) => m.name === 'Absent').rank, 2);
  });

  test('counts only the requested week, not neighbouring ones', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    await app.request('PUT', '/api/entries', { body: { date: '2020-01-05', steps: 999 }, cookie }); // Sunday before
    await app.request('PUT', '/api/entries', { body: { date: '2020-01-06', steps: 100 }, cookie });
    await app.request('PUT', '/api/entries', { body: { date: '2020-01-13', steps: 999 }, cookie }); // Monday after

    const { body } = await app.request('GET', `/api/week?week=${PAST_WEEK}`, { cookie });
    assert.equal(body.members[0].total, 100);
  });
});
