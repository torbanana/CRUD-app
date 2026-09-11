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

  test('rejects a goal that is not a number instead of coercing it', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const journeyGoalSteps of [true, [], ['750000'], '', null, {}, '750000x']) {
      const r = await app.request('PATCH', '/api/group', { body: { journeyGoalSteps }, cookie });
      assert.equal(r.status, 400, `${JSON.stringify(journeyGoalSteps)} should be rejected`);
    }
    assert.equal(
      (await app.request('PATCH', '/api/group', { body: {}, cookie })).body.meta.journey_goal_steps,
      '750000'
    );
  });

  test('still accepts a goal sent as a numeric string', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PATCH', '/api/group', { body: { journeyGoalSteps: '650000' }, cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.journey_goal_steps, '650000');
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
