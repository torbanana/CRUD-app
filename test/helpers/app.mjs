// Test harness for the Worker's fetch handler.
//
// Calls the real exported `fetch(request, env, ctx)` with a fresh in-memory
// database per test, so every test exercises routing, auth, validation and SQL
// exactly as deployed. Nothing here stubs out worker code.

import worker from '../../worker/index.js';
import { FakeD1Database } from './d1.mjs';

export const INVITE_CODE = 'TESTCODE';
export const BASE = 'https://step-race.test';

/**
 * Fresh app instance. `vars` overrides anything in the default env, so a test
 * can change the timezone or the member cap without touching the others.
 */
export function createApp(vars = {}) {
  const db = new FakeD1Database();
  const env = {
    DB: db,
    APP_TZ: 'Asia/Singapore',
    INVITE_CODE,
    MAX_MEMBERS: '10',
    // The floor iterationsFrom() accepts. Real cost is a deployment concern;
    // paying it on every one of these tests is not.
    PBKDF2_ITERATIONS: '1000',
    ...vars,
  };
  const ctx = { waitUntil: (promise) => { void Promise.resolve(promise).catch(() => {}); } };

  /**
   * Send a request. `cookie` is the jar returned by a previous signup/login;
   * `body` is JSON-encoded unless it is already a string.
   */
  async function request(method, path, { body, cookie, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] ??= 'application/json';
    }
    if (cookie) init.headers.cookie = cookie;

    const response = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, body: json, text };
  }

  return { db, env, ctx, request };
}

/** The `sid=...` pair from a Set-Cookie header, ready to send back. */
export function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  return setCookie.split(';')[0];
}

let seq = 0;

/** Sign up a member and return { user, cookie }. */
export async function signUp(app, overrides = {}) {
  seq += 1;
  const payload = {
    email: `member${seq}@example.com`,
    name: `Member ${seq}`,
    password: 'password123',
    inviteCode: INVITE_CODE,
    ...overrides,
  };
  const response = await app.request('POST', '/api/auth/signup', { body: payload });
  return { response, user: response.body?.user, cookie: cookieFrom(response), payload };
}

// --------------------------------------------------------------- date helpers
//
// "Today" moves, so tests must not hardcode it. These derive the dates a test
// needs from the same helpers the Worker uses, which keeps the suite passing
// next week as well as this one.

export { todayISO, currentWeekStart, weekDates, addWeeks } from '../../worker/week.js';

/** A week that is unambiguously finished, whenever the suite is run. */
export const PAST_WEEK = '2020-01-06';
/** A week that has unambiguously not started. */
export const FUTURE_WEEK = '2099-01-05';

/** The seven dates of PAST_WEEK, all safely loggable. */
export const PAST_DATES = [
  '2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09',
  '2020-01-10', '2020-01-11', '2020-01-12',
];
