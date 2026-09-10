// GET /api/config -- the only unauthenticated read.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, signUp } from './helpers/app.mjs';

describe('GET /api/config', () => {
  test('reports an empty group with room to spare', async () => {
    const app = createApp();
    const { status, body } = await app.request('GET', '/api/config');

    assert.equal(status, 200);
    assert.equal(body.groupName, 'The Ten');
    assert.equal(body.memberCount, 0);
    assert.equal(body.maxMembers, 10);
    assert.equal(body.full, false);
    assert.equal(body.timezone, 'Asia/Singapore');
    assert.ok(Array.isArray(body.avatars) && body.avatars.length > 0);
  });

  test('never leaks the invite code', async () => {
    const app = createApp({ INVITE_CODE: 'SUPERSECRET' });
    const { text } = await app.request('GET', '/api/config');
    assert.ok(!text.includes('SUPERSECRET'));
    assert.ok(!('inviteCode' in JSON.parse(text)));
  });

  test('counts members and flips `full` at the cap', async () => {
    const app = createApp({ MAX_MEMBERS: '2' });
    await signUp(app);
    assert.equal((await app.request('GET', '/api/config')).body.full, false);

    await signUp(app);
    const { body } = await app.request('GET', '/api/config');
    assert.equal(body.memberCount, 2);
    assert.equal(body.full, true);
  });

  test('honours a configured timezone', async () => {
    const app = createApp({ APP_TZ: 'Europe/Lisbon' });
    assert.equal((await app.request('GET', '/api/config')).body.timezone, 'Europe/Lisbon');
  });

  test('falls back to defaults when vars are absent', async () => {
    const app = createApp({ APP_TZ: undefined, MAX_MEMBERS: undefined });
    const { body } = await app.request('GET', '/api/config');
    assert.equal(body.timezone, 'Asia/Singapore');
    assert.equal(body.maxMembers, 10);
  });
});
