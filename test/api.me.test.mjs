// PATCH /api/me -- the profile edit. The rule under test throughout: you can
// only ever edit yourself, whatever the request body says.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, signUp } from './helpers/app.mjs';

describe('PATCH /api/me', () => {
  test('needs a session', async () => {
    const app = createApp();
    assert.equal((await app.request('PATCH', '/api/me', { body: { name: 'X' } })).status, 401);
  });

  test('updates name, avatar and weekly goal together', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);

    const r = await app.request('PATCH', '/api/me', {
      body: { name: 'Renamed', avatar: '🐙', weeklyGoal: 120000 },
      cookie,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, 'Renamed');
    assert.equal(r.body.user.avatar, '🐙');
    assert.equal(r.body.user.weekly_goal, 120000);

    // Persisted, not just echoed back.
    assert.equal((await app.request('GET', '/api/me', { cookie })).body.user.name, 'Renamed');
  });

  test('leaves untouched fields alone', async () => {
    const app = createApp();
    const { cookie, user } = await signUp(app, { name: 'Keep', avatar: '🐢' });

    const r = await app.request('PATCH', '/api/me', { body: { weeklyGoal: 84000 }, cookie });
    assert.equal(r.body.user.name, 'Keep');
    assert.equal(r.body.user.avatar, '🐢');
    assert.equal(r.body.user.email, user.email);
    assert.equal(r.body.user.weekly_goal, 84000);
  });

  test('an empty patch is a no-op, not an error', async () => {
    const app = createApp();
    const { cookie, user } = await signUp(app);
    const r = await app.request('PATCH', '/api/me', { body: {}, cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user, user);
  });

  test('trims whitespace off the name', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PATCH', '/api/me', { body: { name: '  Spaced  ' }, cookie });
    assert.equal(r.body.user.name, 'Spaced');
  });

  for (const [label, body] of [
    ['a one-character name', { name: 'x' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a 31-character name', { name: 'x'.repeat(31) }],
    ['a non-string name', { name: 99 }],
    ['an avatar off the list', { avatar: '💣' }],
    ['a non-string avatar', { avatar: 7 }],
    ['a goal below 7,000', { weeklyGoal: 6999 }],
    ['a goal above 700,000', { weeklyGoal: 700001 }],
    ['a fractional goal', { weeklyGoal: 70000.5 }],
    ['a non-numeric goal', { weeklyGoal: 'lots' }],
  ]) {
    test(`rejects ${label}`, async () => {
      const app = createApp();
      const { cookie } = await signUp(app);
      const r = await app.request('PATCH', '/api/me', { body, cookie });
      assert.equal(r.status, 400);
      assert.ok(r.body.error);
    });
  }

  test('rejects a goal that is not a number instead of coercing it', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const weeklyGoal of [true, [], ['70000'], '', null, {}, '70000x']) {
      const r = await app.request('PATCH', '/api/me', { body: { weeklyGoal }, cookie });
      assert.equal(r.status, 400, `weeklyGoal: ${JSON.stringify(weeklyGoal)} should be rejected`);
    }
  });

  test('still accepts a goal sent as a numeric string', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    const r = await app.request('PATCH', '/api/me', { body: { weeklyGoal: '84000' }, cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.weekly_goal, 84000);
  });

  test('accepts the exact boundaries of the goal range', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    for (const goal of [7000, 700000]) {
      const r = await app.request('PATCH', '/api/me', { body: { weeklyGoal: goal }, cookie });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.weekly_goal, goal);
    }
  });

  test('a rejected patch changes nothing', async () => {
    const app = createApp();
    const { cookie, user } = await signUp(app);
    await app.request('PATCH', '/api/me', { body: { name: 'Fine', weeklyGoal: 1 }, cookie });
    assert.equal((await app.request('GET', '/api/me', { cookie })).body.user.name, user.name);
  });

  test('cannot be aimed at another member via the body', async () => {
    const app = createApp();
    const victim = await signUp(app, { name: 'Victim' });
    const attacker = await signUp(app, { name: 'Attacker' });

    const r = await app.request('PATCH', '/api/me', {
      body: { id: victim.user.id, user_id: victim.user.id, email: 'stolen@example.com', name: 'Owned' },
      cookie: attacker.cookie,
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, attacker.user.id, 'the session decides whose row is written');
    assert.equal(r.body.user.email, attacker.user.email, 'email is not editable');
    assert.equal(
      (await app.request('GET', '/api/me', { cookie: victim.cookie })).body.user.name,
      'Victim'
    );
  });
});
