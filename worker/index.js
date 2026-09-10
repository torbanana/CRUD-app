// The Worker: routing, validation, and the API.
//
// Express does not run on Workers (no node:http), so this is a small hand-rolled
// router over the standard fetch handler. Twelve routes did not justify pulling
// in a framework, and doing without leaves the project with ZERO runtime
// dependencies -- wrangler is the only package, and it is a build-time tool.
//
// Static files are served by the [assets] binding configured in wrangler.jsonc.
// Cloudflare matches those first, so this code only runs for /api/* and for
// paths with no matching file.

import {
  addCheer,
  consumePasswordReset,
  countUsers,
  createUser,
  deleteEntry,
  deletePasswordResetsForUser,
  deleteSessionsForUser,
  findUserByEmail,
  findUserById,
  findUserCredentials,
  getMeta,
  peekPasswordReset,
  purgeExpiredPasswordResets,
  removeCheer,
  setMeta,
  setPasswordHash,
  updateUserProfile,
  upsertEntry,
} from './db.js';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_INSECURE,
  endSession,
  getSessionUser,
  hashPassword,
  hashToken,
  iterationsFrom,
  parseCookies,
  secretsMatch,
  startSession,
  verifyPassword,
} from './auth.js';
import {
  clearFailures,
  ipKey,
  purgeStaleThrottles,
  recordFailure,
  retryAfter,
  subjectKey,
  throttleKeys,
} from './throttle.js';
import { buildWeekView } from './weekview.js';
import { currentWeekStart, isValidISODate, todayISO, weekStartOf } from './week.js';

const DEFAULT_TZ = 'Asia/Singapore';
const DEFAULT_MAX_MEMBERS = 10;

// The invite code is the ONLY thing standing between a public URL and a
// stranger taking one of the ten places. It used to fall back to a code
// written in this file, which meant forgetting `wrangler secret put
// INVITE_CODE` silently published the group. There is no fallback now: if the
// secret is unset, signup is closed. The one exception is local development,
// where there is nothing to protect and a working `npm run seed` matters more.
const DEV_INVITE_CODE = 'STEP2026';
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
const isLocalDev = (url) => DEV_HOSTS.has(url.hostname);

// Length limits. The minimum is the usual floor; the maximum exists because
// PBKDF2 will faithfully hash a 10MB password and bill us the CPU for it.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// A password that survives eight characters of length checking but appears on
// every credential-stuffing list has not actually been checked. This is a
// deliberately short list of the passwords that guessing attempts start with,
// not a substitute for a breach corpus -- it is the cheap 90%.
const BANNED_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd',
  '12345678', '123456789', '1234567890', '123123123', '11111111',
  'qwertyui', 'qwerty123', 'iloveyou', 'letmein1', 'letmein123',
  'welcome1', 'welcome123', 'admin123', 'football', 'baseball',
  'sunshine', 'princess', 'trustno1', 'dragon123', 'monkey123',
  'abc12345', 'abcd1234', 'changeme', 'steprace', 'step2026',
]);

// A day's steps above this is almost certainly a typo (a very long day is
// ~50k). We reject rather than silently clamp, so the person can fix it.
const MAX_STEPS_PER_DAY = 200000;

// The avatars people may pick. Kept server-side too, so a crafted request
// can't set an arbitrary string as an avatar.
const AVATARS = [
  '🦊', '🐢', '🐇', '🐕', '🐈', '🐼', '🐨', '🦁',
  '🐯', '🦄', '🐝', '🦖', '🐙', '🦩', '🐧', '🦉',
  '🏃', '🚶', '🧗', '🤸', '💃', '🕺',
];

// -------------------------------------------------------------------- helpers

const json = (data, status = 200, headers = {}) => {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  // An array value means "send this header more than once" -- logout clears two
  // cookies at once, and Set-Cookie cannot be comma-joined into a single line.
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const one of value) h.append(key, one);
    else h.set(key, value);
  }
  return new Response(JSON.stringify(data), { status, headers: h });
};

const fail = (status, message, headers) => json({ error: message }, status, headers);

/** The 429 every throttled route returns, with the header a client can act on. */
const tooMany = (wait, what = 'attempts') =>
  fail(429, `Too many ${what}. Try again in ${wait} second${wait === 1 ? '' : 's'}.`, {
    'retry-after': String(wait),
  });

const config = (env) => ({
  tz: env.APP_TZ || DEFAULT_TZ,
  inviteCode: env.INVITE_CODE || null,
  maxMembers: Number(env.MAX_MEMBERS) || DEFAULT_MAX_MEMBERS,
});

/**
 * The headers every API response carries.
 *
 * `no-store` is the one that matters most: /api/week is per-viewer (it marks
 * one member `isMe`) and the responses travel through Cloudflare's cache
 * layers. Without it, a shared cache is one misconfiguration away from handing
 * one member's view to another. The rest is standard hardening -- the CSP is
 * `default-src 'none'` because a JSON document should never load anything.
 */
function harden(response, url) {
  const h = new Headers(response.headers);

  // Copying a Headers object can fold several Set-Cookie values into one
  // comma-joined string, which corrupts any cookie carrying an Expires date
  // (those contain a comma of their own). Restore them one by one.
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 1) {
    h.delete('set-cookie');
    for (const cookie of cookies) h.append('set-cookie', cookie);
  }

  h.set('cache-control', 'private, no-store, max-age=0');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  h.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  h.set('cross-origin-resource-policy', 'same-origin');
  h.set('cross-origin-opener-policy', 'same-origin');
  h.set('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  if (url.protocol === 'https:') {
    h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(response.body, { status: response.status, headers: h });
}

/**
 * Reject state-changing requests that did not come from our own pages.
 *
 * The session cookie is already SameSite=Strict, which is the primary CSRF
 * defence, but it is one browser setting away from being the only one. A
 * browser sends Origin on every non-GET request, so an exact match against our
 * own origin is a second, independent check that costs nothing.
 *
 * Non-browser callers (scripts/seed.mjs, curl) must send the header too. That
 * is intentional: a request with no Origin at all is indistinguishable from an
 * old browser that omits it, and we would rather break a script than guess.
 */
function originAllowed(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  return request.headers.get('origin') === url.origin;
}

/** Password rules, applied identically at signup and any future reset. */
function passwordProblem(password, email) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Your password needs to be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Your password can be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (BANNED_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is one of the most commonly guessed ones. Please pick another.';
  }
  // Reusing your own address as your password defeats the point of having one.
  // The message names the offending string: someone whose address starts with
  // a short word can trip this without having typed their email at all
  // ("bens-first-password" contains "ben"), and "does not contain your email
  // address" would leave them staring at a password that plainly doesn't.
  const localPart = String(email || '').split('@')[0].toLowerCase();
  if (localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
    return `Your password cannot contain "${localPart}" — that is the start of your email address.`;
  }
  return null;
}

/** Read a JSON body, tolerating an empty or malformed one. */
async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/**
 * Resolve a ?week= value into a Monday. Any date inside the week works, so
 * '2026-09-10' and '2026-09-07' both mean the same week. Returns null if the
 * value is present but not a real date.
 */
function resolveWeek(raw, tz) {
  if (!raw) return currentWeekStart(tz);
  if (!isValidISODate(raw)) return null;
  return weekStartOf(raw);
}

// Secure cookies require HTTPS. `wrangler dev` serves plain http on localhost,
// where a Secure cookie would be silently dropped, so mirror the request.
const isSecure = (url) => url.protocol === 'https:';

// --------------------------------------------------------------------- routes

async function handleConfig(_request, env, db) {
  const { maxMembers, tz } = config(env);
  const [meta, members] = await Promise.all([getMeta(db), countUsers(db)]);
  // Public endpoint -- deliberately never includes the invite code, only
  // whether the group still has room.
  return json({
    groupName: meta.group_name,
    memberCount: members,
    maxMembers,
    full: members >= maxMembers,
    avatars: AVATARS,
    timezone: tz,
  });
}

async function handleSignup(request, env, db, url) {
  const { email, name, password, avatar, inviteCode } = await readJson(request);
  const { inviteCode: configured, maxMembers } = config(env);

  // Fail closed. A deployment that never ran `wrangler secret put INVITE_CODE`
  // has no door lock, so we do not open the door at all.
  const expected = configured ?? (isLocalDev(url) ? DEV_INVITE_CODE : null);
  if (!expected) {
    return fail(503, 'Joining is closed: this group has no invite code configured yet.');
  }

  // Guessing the invite code is a brute-force attack like any other, so it is
  // rate limited the same way. Keyed on IP plus the constant 'signup', which
  // caps total signup attempts against this instance regardless of source.
  const keys = throttleKeys(request, 'signup');
  const wait = await retryAfter(db, keys);
  if (wait > 0) return tooMany(wait);

  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return fail(400, 'Please enter a valid email address.');
  }
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
    return fail(400, 'Your name needs to be between 2 and 30 characters.');
  }
  const badPassword = passwordProblem(password, email);
  if (badPassword) return fail(400, badPassword);

  // Constant-time, so the code cannot be recovered a character at a time.
  if (typeof inviteCode !== 'string' || !(await secretsMatch(inviteCode, expected))) {
    await recordFailure(db, keys);
    return fail(403, 'That invite code is not right.');
  }
  if (avatar !== undefined && !AVATARS.includes(avatar)) {
    return fail(400, 'Please pick one of the offered avatars.');
  }

  // The group has a fixed size; this is what makes it a group of ten. Checked
  // here for a readable error, and again inside the INSERT so that concurrent
  // signups cannot slip past the gap between the two.
  const members = await countUsers(db);
  if (members >= maxMembers) return fail(403, `This group is full (${maxMembers} members).`);
  if (await findUserByEmail(db, email)) {
    return fail(409, 'Someone has already signed up with that email.');
  }

  const result = await createUser(
    db,
    {
      email,
      name,
      avatar: avatar || AVATARS[members % AVATARS.length],
      passwordHash: await hashPassword(password, env),
    },
    maxMembers
  );

  if (result.error === 'full') return fail(403, `This group is full (${maxMembers} members).`);
  if (result.error === 'duplicate') {
    return fail(409, 'Someone has already signed up with that email.');
  }

  await clearFailures(db, keys);
  const cookie = await startSession(db, result.user.id, { secure: isSecure(url) });
  return json({ user: result.user }, 201, { 'set-cookie': cookie });
}

async function handleLogin(request, env, db, url) {
  const { email, password } = await readJson(request);
  if (typeof email !== 'string' || typeof password !== 'string') {
    return fail(400, 'Please enter your email and password.');
  }

  // Checked before anything else, so a locked-out attacker cannot even make us
  // spend a PBKDF2 derivation per guess.
  const keys = throttleKeys(request, email);
  const wait = await retryAfter(db, keys);
  if (wait > 0) return tooMany(wait, 'sign-in attempts');

  const record = await findUserByEmail(db, email);

  // Same message either way, so this cannot be used to discover who is a
  // member. We still run the KDF on a miss to keep the timing similar -- and
  // the decoy hash must use the CURRENT cost, not a hardcoded one: with
  // PBKDF2_ITERATIONS raised to 600000 a hardcoded 25000 decoy would return
  // ~70ms faster than a real account and hand out the member list by stopwatch.
  const decoy = `pbkdf2$${iterationsFrom(env)}$${'00'.repeat(16)}$${'00'.repeat(32)}`;
  const ok = record
    ? await verifyPassword(password, record.password_hash)
    : await verifyPassword(password, decoy);

  if (!record || !ok) {
    await recordFailure(db, keys);
    return fail(401, 'That email and password do not match.');
  }

  await clearFailures(db, keys);
  const cookie = await startSession(db, record.id, { secure: isSecure(url) });
  return json(
    {
      user: {
        id: record.id,
        email: record.email,
        name: record.name,
        avatar: record.avatar,
        weekly_goal: record.weekly_goal,
      },
    },
    200,
    { 'set-cookie': cookie }
  );
}

async function handleLogout(request, _env, db, url) {
  const jar = parseCookies(request);
  // Both names, so an upgraded instance cannot leave a live pre-__Host- session
  // behind after the user has asked to be signed out.
  const cookies = await endSession(db, [jar[SESSION_COOKIE], jar[SESSION_COOKIE_INSECURE]], {
    secure: isSecure(url),
  });
  return json({ ok: true }, 200, { 'set-cookie': cookies });
}

// ------------------------------------------------------------ password reset
//
// Nothing here sends anything. This project has no mail provider and adding
// one would mean a third-party account, an API key and a verified sender
// domain for a group of ten -- so the link is minted out of band, by whoever
// runs the group, with `npm run reset-password`. These routes are what the
// link then talks to.
//
// The token travels in the URL *fragment* (`/reset#<token>`), which a browser
// never puts on the wire. That keeps it out of request logs, out of
// Cloudflare's observability traces, and out of any Referer header. The page
// reads location.hash and posts the token in a body instead.

const BAD_RESET_TOKEN = 'That reset link is not valid any more. Ask for a new one.';

/** Is this link still good, and whose is it? Asked before showing the form. */
async function handleResetCheck(request, _env, db) {
  const { token } = await readJson(request);

  // IP only, deliberately -- see the note on key choice in throttle.js.
  const keys = [ipKey(request)];
  const wait = await retryAfter(db, keys);
  if (wait > 0) return tooMany(wait);

  if (typeof token !== 'string' || !token) return fail(400, BAD_RESET_TOKEN);

  const target = await peekPasswordReset(db, await hashToken(token));
  if (!target) {
    await recordFailure(db, keys);
    return fail(400, BAD_RESET_TOKEN);
  }

  // Only the name. Enough for the page to confirm whose link this is before
  // someone types a password into it; not enough to be worth harvesting.
  return json({ name: target.name });
}

async function handleResetPassword(request, env, db, url) {
  const { token, password } = await readJson(request);

  const keys = [ipKey(request)];
  const wait = await retryAfter(db, keys);
  if (wait > 0) return tooMany(wait);

  if (typeof token !== 'string' || !token) return fail(400, BAD_RESET_TOKEN);
  const tokenHash = await hashToken(token);

  // Check the password BEFORE spending the token. Rejecting a weak password
  // after the link is burnt would send the person back to ask for another one
  // for no reason.
  const target = await peekPasswordReset(db, tokenHash);
  if (!target) {
    await recordFailure(db, keys);
    return fail(400, BAD_RESET_TOKEN);
  }
  const badPassword = passwordProblem(password, target.email);
  if (badPassword) return fail(400, badPassword);

  // Now spend it. The UPDATE's own WHERE clause is what makes the link
  // single-use: if the same token arrives twice, exactly one of them matches
  // `used_at IS NULL` and the other is refused.
  const spent = await consumePasswordReset(db, tokenHash);
  if (!spent) return fail(400, BAD_RESET_TOKEN);

  await setPasswordHash(db, spent.user_id, await hashPassword(password, env));

  // A reset answers "I have lost control of this account", so everything that
  // might still be holding it goes: every session on every device, and every
  // other link that was outstanding.
  await Promise.all([
    deleteSessionsForUser(db, spent.user_id),
    deletePasswordResetsForUser(db, spent.user_id),
    // They almost certainly locked themselves out on the way here.
    clearFailures(db, [subjectKey(target.email)]),
  ]);

  const cookie = await startSession(db, spent.user_id, { secure: isSecure(url) });
  return json({ user: await findUserById(db, spent.user_id) }, 200, { 'set-cookie': cookie });
}

/** Rotate your own password while signed in. No link, no operator involved. */
async function handleChangePassword(request, env, db, url, user) {
  const { currentPassword, newPassword } = await readJson(request);

  const keys = [ipKey(request), subjectKey(user.email)];
  const wait = await retryAfter(db, keys);
  if (wait > 0) return tooMany(wait);

  const record = await findUserCredentials(db, user.id);
  if (!record) return fail(401, 'Please sign in.');

  // Re-authenticate. A session alone is not enough to change the password it
  // rests on, or a borrowed laptop becomes a permanent takeover.
  const ok =
    typeof currentPassword === 'string' &&
    (await verifyPassword(currentPassword, record.password_hash));
  if (!ok) {
    await recordFailure(db, keys);
    // 403 rather than 401 on purpose: the session is perfectly valid, it is
    // the re-auth that failed. The client bounces to /login on any 401, which
    // would throw someone out of the app for mistyping.
    return fail(403, 'That is not your current password.');
  }

  const badPassword = passwordProblem(newPassword, record.email);
  if (badPassword) return fail(400, badPassword);
  if (newPassword === currentPassword) {
    return fail(400, 'That is already your password. Pick a different one.');
  }

  await setPasswordHash(db, user.id, await hashPassword(newPassword, env));

  // Changing a password is also how you evict someone who has your session,
  // so drop them all -- including this one -- and issue a fresh cookie, so the
  // person doing it stays signed in and nobody else does.
  await Promise.all([
    deleteSessionsForUser(db, user.id),
    deletePasswordResetsForUser(db, user.id),
    clearFailures(db, keys),
  ]);

  const cookie = await startSession(db, user.id, { secure: isSecure(url) });
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function handlePatchMe(request, _env, db, _url, user) {
  const { name, avatar, weeklyGoal } = await readJson(request);
  const patch = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
      return fail(400, 'Your name needs to be between 2 and 30 characters.');
    }
    patch.name = name.trim();
  }
  if (avatar !== undefined) {
    if (!AVATARS.includes(avatar)) return fail(400, 'Please pick one of the offered avatars.');
    patch.avatar = avatar;
  }
  if (weeklyGoal !== undefined) {
    const goal = Number(weeklyGoal);
    if (!Number.isInteger(goal) || goal < 7000 || goal > 700000) {
      return fail(400, 'Pick a weekly goal between 7,000 and 700,000 steps.');
    }
    patch.weeklyGoal = goal;
  }

  // user.id, never a body field: you can only ever edit yourself.
  return json({ user: await updateUserProfile(db, user.id, patch) });
}

async function handleWeek(_request, env, db, url, user) {
  const { tz } = config(env);
  const weekStart = resolveWeek(url.searchParams.get('week'), tz);
  if (!weekStart) return fail(400, 'That is not a valid date.');
  return json(await buildWeekView(db, weekStart, user.id, tz));
}

/**
 * Log or correct one day of MY steps.
 *
 * This is the app's one shared action, and the write half of the permission
 * rule lives here: the row is keyed on the session user's id, so there is no
 * way to express "write to someone else's day" even with a crafted body.
 */
async function handlePutEntry(request, env, db, _url, user) {
  const { date, steps } = await readJson(request);
  const { tz } = config(env);

  if (!isValidISODate(date)) return fail(400, 'Please give a date as YYYY-MM-DD.');
  // No logging the future -- it would sit on the leaderboard unearned.
  if (date > todayISO(tz)) {
    return fail(400, 'You cannot log steps for a day that has not happened yet.');
  }

  const count = Number(steps);
  if (!Number.isInteger(count) || count < 0) {
    return fail(400, 'Steps must be a whole number, zero or more.');
  }
  if (count > MAX_STEPS_PER_DAY) {
    return fail(400, `${count.toLocaleString('en-US')} steps in a day looks like a typo.`);
  }

  return json({ entry: await upsertEntry(db, user.id, date, count) });
}

async function handleDeleteEntry(_request, _env, db, _url, user, params) {
  if (!isValidISODate(params.date)) return fail(400, 'Please give a date as YYYY-MM-DD.');
  return json({ removed: await deleteEntry(db, user.id, params.date) });
}

async function handlePostCheer(request, env, db, _url, user) {
  const body = await readJson(request);
  const { tz } = config(env);
  const toUser = Number(body.toUserId);
  const weekStart = resolveWeek(body.week, tz);

  if (!Number.isInteger(toUser)) return fail(400, 'Which member do you want to cheer?');
  if (!weekStart) return fail(400, 'That is not a valid date.');
  // Checked here rather than relying on the CHECK constraint, because
  // INSERT OR IGNORE swallows the violation and reports a silent no-op.
  if (toUser === user.id) return fail(400, 'Cheer someone else, not yourself.');

  const added = await addCheer(db, user.id, toUser, weekStart);
  return json({ added, alreadyCheered: !added });
}

async function handleDeleteCheer(_request, env, db, url, user, params) {
  const { tz } = config(env);
  const toUser = Number(params.toUserId);
  const weekStart = resolveWeek(url.searchParams.get('week'), tz);

  if (!Number.isInteger(toUser)) return fail(400, 'Which member do you want to un-cheer?');
  if (!weekStart) return fail(400, 'That is not a valid date.');
  return json({ removed: await removeCheer(db, user.id, toUser, weekStart) });
}

async function handlePatchGroup(request, _env, db) {
  // Ten people who know each other don't need an admin role -- any member can
  // set the group's shared goal, the same way anyone can move a whiteboard.
  const { journeyName, journeyGoalSteps, groupName } = await readJson(request);
  const writes = [];

  if (journeyName !== undefined) {
    if (typeof journeyName !== 'string' || !journeyName.trim() || journeyName.length > 40) {
      return fail(400, 'Give the destination a name of up to 40 characters.');
    }
    writes.push(setMeta(db, 'journey_name', journeyName.trim()));
  }
  if (groupName !== undefined) {
    if (typeof groupName !== 'string' || !groupName.trim() || groupName.length > 40) {
      return fail(400, 'Give the group a name of up to 40 characters.');
    }
    writes.push(setMeta(db, 'group_name', groupName.trim()));
  }
  if (journeyGoalSteps !== undefined) {
    const goal = Number(journeyGoalSteps);
    if (!Number.isInteger(goal) || goal < 10000 || goal > 20000000) {
      return fail(400, 'Pick a group goal between 10,000 and 20,000,000 steps.');
    }
    writes.push(setMeta(db, 'journey_goal_steps', goal));
  }

  await Promise.all(writes);
  return json({ meta: await getMeta(db) });
}

// ---------------------------------------------------------------- route table

// [method, pattern, handler, requiresAuth]
// Patterns are matched against the pathname; named groups become `params`.
const ROUTES = [
  ['GET', /^\/api\/config$/, handleConfig, false],
  ['POST', /^\/api\/auth\/signup$/, handleSignup, false],
  ['POST', /^\/api\/auth\/login$/, handleLogin, false],
  ['POST', /^\/api\/auth\/logout$/, handleLogout, false],
  ['POST', /^\/api\/auth\/reset\/check$/, handleResetCheck, false],
  ['POST', /^\/api\/auth\/reset$/, handleResetPassword, false],
  ['POST', /^\/api\/auth\/change-password$/, handleChangePassword, true],
  ['GET', /^\/api\/me$/, (_r, _e, _d, _u, user) => json({ user }), true],
  ['PATCH', /^\/api\/me$/, handlePatchMe, true],
  ['GET', /^\/api\/week$/, handleWeek, true],
  ['PUT', /^\/api\/entries$/, handlePutEntry, true],
  ['DELETE', /^\/api\/entries\/(?<date>[^/]+)$/, handleDeleteEntry, true],
  ['POST', /^\/api\/cheers$/, handlePostCheer, true],
  ['DELETE', /^\/api\/cheers\/(?<toUserId>[^/]+)$/, handleDeleteCheer, true],
  ['PATCH', /^\/api\/group$/, handlePatchGroup, true],
];

// The CSP for the app's own pages, as opposed to the `default-src 'none'` one
// on JSON. Cloudflare normally serves static files from its edge without
// invoking this Worker, so the authoritative copy of these lives in
// public/_headers -- this is the fall-through path. Keep the two in step.
//
// script-src has no 'unsafe-inline': both pages load their JavaScript from
// /js/*.js, which is what makes the policy worth having. style-src does allow
// it, because the rendered markup sets bar widths with style="width: N%"
// attributes; an injected style attribute cannot execute anything.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function hardenAsset(response, url) {
  const h = new Headers(response.headers);
  h.set('content-security-policy', PAGE_CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  h.set('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  if (url.protocol === 'https:') {
    h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = env.DB;

    if (!db) {
      return harden(fail(500, 'The database binding is missing. Check wrangler.jsonc.'), url);
    }

    // Anything that isn't the API is a static file. Cloudflare normally serves
    // those before the Worker runs; this covers the fall-through case.
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return hardenAsset(await env.ASSETS.fetch(request), url);
      return hardenAsset(new Response('Not found', { status: 404 }), url);
    }

    // CSRF: a write that did not come from one of our own pages never runs.
    if (!originAllowed(request, url)) {
      return harden(fail(403, 'This request did not come from the app.'), url);
    }

    let matchedPath = false;
    for (const [method, pattern, handler, requiresAuth] of ROUTES) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      matchedPath = true;
      if (method !== request.method) continue;

      try {
        let user = null;
        if (requiresAuth) {
          user = await getSessionUser(db, request);
          if (!user) return harden(fail(401, 'Please sign in.'), url);
        }

        const params = match.groups ?? {};
        // Tidy expired sessions and spent throttle rows occasionally, after the
        // response is sent.
        if (Math.random() < 0.02 && ctx?.waitUntil) {
          ctx.waitUntil(
            Promise.all([
              import('./db.js').then((m) => m.purgeExpiredSessions(db)),
              purgeStaleThrottles(db),
              purgeExpiredPasswordResets(db),
            ]).catch(() => {})
          );
        }
        return harden(await handler(request, env, db, url, user, params), url);
      } catch (err) {
        // The stack goes to the log; the caller gets nothing it could learn
        // from. Never put err.message in the response body.
        console.error('[error]', err?.stack || String(err));
        return harden(fail(500, 'Something went wrong on our end.'), url);
      }
    }

    return harden(
      matchedPath ? fail(405, 'That method is not allowed here.') : fail(404, 'No such endpoint.'),
      url
    );
  },
};
