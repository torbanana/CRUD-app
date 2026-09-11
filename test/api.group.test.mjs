// PATCH /api/group -- the shared settings any member may change.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, signUp } from './helpers/app.mjs';

describe('PATCH /api/group', () => {
  test('needs a session', async () => {
    const app = createApp();
    assert.equal((await app.request('PATCH', '/api/group', { body: { groupName: 'X' } })).status, 401);
  });

  test('any member may change the shared settings', async () => {
    const app = createApp();
    await signUp(app, { name: 'First' });
    const second = await signUp(app, { name: 'Second' });

    const r = await app.request('PATCH', '/api/group', {
      body: { groupName: 'The Nine', journeyName: 'Osaka', journeyGoalSteps: 900000 },
      cookie: second.cookie,
    });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body.meta, {
      group_name: 'The Nine',
      journey_name: 'Osaka',
      journey_goal_steps: '900000',
    });
  });

  test('changes one field without disturbing the others', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);

    const r = await app.request('PATCH', '/api/group', { body: { journeyName: 'Bali' }, cookie });
    assert.equal(r.body.meta.journey_name, 'Bali');
    assert.equal(r.body.meta.group_name, 'The Ten');
    assert.equal(r.body.meta.journey_goal_steps, '750000');
  });

  test('an empty patch is a no-op that returns current settings', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PATCH', '/api/group', { body: {}, cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.group_name, 'The Ten');
  });

  test('trims the names it stores', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PATCH', '/api/group', {
      body: { groupName: '  Padded  ', journeyName: '  Kyoto  ' },
      cookie,
    });
    assert.equal(r.body.meta.group_name, 'Padded');
    assert.equal(r.body.meta.journey_name, 'Kyoto');
  });

  test('accepts the exact boundaries of the goal range', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const goal of [10000, 20000000]) {
      const r = await app.request('PATCH', '/api/group', { body: { journeyGoalSteps: goal }, cookie });
      assert.equal(r.status, 200);
      assert.equal(r.body.meta.journey_goal_steps, String(goal));
    }
  });

  for (const [label, body, fragment] of [
    ['an empty group name', { groupName: '' }, 'group a name'],
    ['a whitespace-only group name', { groupName: '   ' }, 'group a name'],
    ['a 41-character group name', { groupName: 'x'.repeat(41) }, 'group a name'],
    ['a non-string group name', { groupName: 5 }, 'group a name'],
    ['an empty destination', { journeyName: '' }, 'destination a name'],
    ['a 41-character destination', { journeyName: 'x'.repeat(41) }, 'destination a name'],
    ['a goal below 10,000', { journeyGoalSteps: 9999 }, 'group goal'],
    ['a goal above 20,000,000', { journeyGoalSteps: 20000001 }, 'group goal'],
    ['a fractional goal', { journeyGoalSteps: 1000.5 }, 'group goal'],
    ['an unparseable goal', { journeyGoalSteps: 'many' }, 'group goal'],
  ]) {
    test(`rejects ${label}`, async () => {
      const app = createApp();
      const { cookie } = await signUp(app);
      const r = await app.request('PATCH', '/api/group', { body, cookie });
      assert.equal(r.status, 400);
      assert.match(r.body.error, new RegExp(fragment));
    });
  }

  test('a rejected patch changes nothing at all', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);

    // Regression: setMeta() used to be called during validation, so the writes
    // for the fields that passed were already in flight by the time a later
    // field failed -- a 400 that changed the group anyway.
    const r = await app.request('PATCH', '/api/group', {
      body: { groupName: 'Renamed', journeyName: 'Osaka', journeyGoalSteps: 5 },
      cookie,
    });
    assert.equal(r.status, 400);

    const after = await app.request('PATCH', '/api/group', { body: {}, cookie });
    assert.deepEqual(after.body.meta, {
      group_name: 'The Ten',
      journey_name: 'Kuala Lumpur',
      journey_goal_steps: '750000',
    });
    assert.equal((await app.request('GET', '/api/config')).body.groupName, 'The Ten');
  });

  test('nothing is written whichever field is the bad one', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const good = { groupName: 'Good Name', journeyName: 'Good Place', journeyGoalSteps: 400000 };

    for (const bad of [
      { ...good, groupName: '' },
      { ...good, journeyName: 'x'.repeat(41) },
      { ...good, journeyGoalSteps: 20000001 },
    ]) {
      assert.equal((await app.request('PATCH', '/api/group', { body: bad, cookie })).status, 400);
      const meta = (await app.request('PATCH', '/api/group', { body: {}, cookie })).body.meta;
      assert.equal(meta.group_name, 'The Ten', `${JSON.stringify(bad)} left a write behind`);
      assert.equal(meta.journey_name, 'Kuala Lumpur');
      assert.equal(meta.journey_goal_steps, '750000');
    }
  });

  test('a valid patch still applies every field together', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PATCH', '/api/group', {
      body: { groupName: 'All Three', journeyName: 'Hanoi', journeyGoalSteps: 123000 },
      cookie,
    });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body.meta, {
      group_name: 'All Three',
      journey_name: 'Hanoi',
      journey_goal_steps: '123000',
    });
  });

  test('settings survive and are visible to everyone', async () => {
    const app = createApp();
    const first = await signUp(app);
    const second = await signUp(app);
    await app.request('PATCH', '/api/group', { body: { groupName: 'Shared' }, cookie: first.cookie });

    assert.equal((await app.request('GET', '/api/config')).body.groupName, 'Shared');
    const week = await app.request('GET', '/api/week', { cookie: second.cookie });
    assert.equal(week.body.group.name, 'Shared');
  });
});
