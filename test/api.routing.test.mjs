// The router itself: method matching, unknown paths, the asset fall-through,
// and the failure modes that are not any one route's fault.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { BASE, createApp, signUp } from './helpers/app.mjs';

describe('routing', () => {
  test('an unknown /api path is a 404', async () => {
    const app = createApp();
    for (const path of ['/api/nope', '/api/', '/api/me/extra', '/api/entries/2026-01-01/x']) {
      const r = await app.request('GET', path);
      assert.equal(r.status, 404, `${path} should be a 404`);
      assert.match(r.body.error, /No such endpoint/);
    }
  });

  test('a known path with the wrong method is a 405', async () => {
    const app = createApp();
    for (const [method, path] of [
      ['DELETE', '/api/config'],
      ['POST', '/api/config'],
      ['GET', '/api/auth/login'],
      ['PUT', '/api/me'],
      ['POST', '/api/week'],
      ['PATCH', '/api/entries'],
      ['GET', '/api/cheers'],
      ['GET', '/api/group'],
    ]) {
      const r = await app.request(method, path);
      assert.equal(r.status, 405, `${method} ${path} should be a 405`);
      assert.match(r.body.error, /not allowed/);
    }
  });

  test('a 405 is decided before authentication', async () => {
    const app = createApp();
    // No cookie: the answer is still "wrong method", not "sign in".
    assert.equal((await app.request('PUT', '/api/me')).status, 405);
  });

  test('GET and PATCH on /api/me reach different handlers', async () => {
    const app = createApp();
    const { cookie } = await signUp(app);
    assert.equal((await app.request('GET', '/api/me', { cookie })).status, 200);
    assert.equal((await app.request('PATCH', '/api/me', { body: {}, cookie })).status, 200);
  });

  test('every response is JSON', async () => {
    const app = createApp();
    for (const [method, path] of [['GET', '/api/config'], ['GET', '/api/nope'], ['GET', '/api/me']]) {
      const r = await app.request(method, path);
      assert.match(r.headers.get('content-type'), /application\/json/);
      assert.ok(r.body !== undefined, 'the body should parse as JSON');
    }
  });

  test('a non-API path is handed to the assets binding', async () => {
    const app = createApp();
    let asked = null;
    app.env.ASSETS = {
      fetch: (request) => {
        asked = new URL(request.url).pathname;
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      },
    };

    const response = await worker.fetch(new Request(`${BASE}/index.html`), app.env, app.ctx);
    assert.equal(response.status, 200);
    assert.equal(asked, '/index.html');
    assert.equal(await response.text(), '<!doctype html>');
  });

  test('a non-API path 404s when there is no assets binding', async () => {
    const app = createApp();
    const response = await worker.fetch(new Request(`${BASE}/index.html`), app.env, app.ctx);
    assert.equal(response.status, 404);
  });

  test('a missing database binding is reported, not thrown', async () => {
    const app = createApp();
    const response = await worker.fetch(new Request(`${BASE}/api/config`), { ...app.env, DB: undefined }, app.ctx);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /database binding is missing/);
  });

  test('a database failure becomes a 500, not a leaked stack trace', async (t) => {
    const app = createApp();
    const { cookie } = await signUp(app);
    t.mock.method(console, 'error', () => {});
    app.env.DB = {
      prepare() {
        throw new Error('D1_ERROR: connection lost at /internal/path.js:42');
      },
    };

    const r = await app.request('GET', '/api/me', { cookie });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Something went wrong on our end.');
    assert.ok(!r.text.includes('D1_ERROR'), 'internal details must not reach the client');
    assert.ok(!r.text.includes('internal/path.js'));
  });

  test('runs without a waitUntil-capable context', async () => {
    const app = createApp();
    const response = await worker.fetch(new Request(`${BASE}/api/config`), app.env, undefined);
    assert.equal(response.status, 200);
  });

  test('a body that is not JSON is treated as an empty one', async () => {
    const app = createApp();
    for (const body of ['not json at all', '[1,2,3]', 'null', '"a string"', '']) {
      const r = await app.request('POST', '/api/auth/login', { body });
      assert.equal(r.status, 400, `${JSON.stringify(body)} should fall through to validation`);
      assert.match(r.body.error, /email and password/);
    }
  });
});
