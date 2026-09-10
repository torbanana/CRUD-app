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
  countUsers,
  createUser,
  deleteEntry,
  findUserByEmail,
  getMeta,
  removeCheer,
  setMeta,
  updateUserProfile,
  upsertEntry,
  userExists,
} from './db.js';
import {
  SESSION_COOKIE,
  endSession,
  getSessionUser,
  hashPassword,
  parseCookies,
  startSession,
  verifyPassword,
} from './auth.js';
import { buildWeekView } from './weekview.js';
import { currentWeekStart, isValidISODate, todayISO, weekStartOf } from './week.js';

const DEFAULT_TZ = 'Asia/Singapore';
const DEFAULT_INVITE_CODE = 'STEP2026';
const DEFAULT_MAX_MEMBERS = 10;

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

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const fail = (status, message) => json({ error: message }, status);

const config = (env) => ({
  tz: env.APP_TZ || DEFAULT_TZ,
  inviteCode: env.INVITE_CODE || DEFAULT_INVITE_CODE,
  maxMembers: Number(env.MAX_MEMBERS) || DEFAULT_MAX_MEMBERS,
});

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
  const { inviteCode: expected, maxMembers } = config(env);

  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return fail(400, 'Please enter a valid email address.');
  }
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 30) {
    return fail(400, 'Your name needs to be between 2 and 30 characters.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    return fail(400, 'Your password needs to be at least 8 characters.');
  }
  if (inviteCode !== expected) {
    return fail(403, 'That invite code is not right.');
  }
  if (avatar !== undefined && !AVATARS.includes(avatar)) {
    return fail(400, 'Please pick one of the offered avatars.');
  }

  // The group has a fixed size; this is what makes it a group of ten.
  const members = await countUsers(db);
  if (members >= maxMembers) return fail(403, `This group is full (${maxMembers} members).`);
  if (await findUserByEmail(db, email)) {
    return fail(409, 'Someone has already signed up with that email.');
  }

  const user = await createUser(db, {
    email,
    name,
    avatar: avatar || AVATARS[members % AVATARS.length],
    passwordHash: await hashPassword(password, env),
  });

  const cookie = await startSession(db, user.id, { secure: isSecure(url) });
  return json({ user }, 201, { 'set-cookie': cookie });
}

async function handleLogin(request, env, db, url) {
  const { email, password } = await readJson(request);
  if (typeof email !== 'string' || typeof password !== 'string') {
    return fail(400, 'Please enter your email and password.');
  }

  const record = await findUserByEmail(db, email);

  // Same message either way, so this cannot be used to discover who is a
  // member. We still run the KDF on a miss to keep the timing similar.
  const ok = record
    ? await verifyPassword(password, record.password_hash)
    : await verifyPassword(password, `pbkdf2$25000$${'00'.repeat(16)}$${'00'.repeat(32)}`);

  if (!record || !ok) return fail(401, 'That email and password do not match.');

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
  const cookie = await endSession(db, parseCookies(request)[SESSION_COOKIE], {
    secure: isSecure(url),
  });
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
  // OR IGNORE does NOT cover this one: SQLite's conflict resolution applies to
  // UNIQUE and CHECK, not to foreign keys, so an unknown id raises instead of
  // being ignored. Left to the database it surfaces as a 500.
  if (!(await userExists(db, toUser))) return fail(404, 'There is no such member.');

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
  ['GET', /^\/api\/me$/, (_r, _e, _d, _u, user) => json({ user }), true],
  ['PATCH', /^\/api\/me$/, handlePatchMe, true],
  ['GET', /^\/api\/week$/, handleWeek, true],
  ['PUT', /^\/api\/entries$/, handlePutEntry, true],
  ['DELETE', /^\/api\/entries\/(?<date>[^/]+)$/, handleDeleteEntry, true],
  ['POST', /^\/api\/cheers$/, handlePostCheer, true],
  ['DELETE', /^\/api\/cheers\/(?<toUserId>[^/]+)$/, handleDeleteCheer, true],
  ['PATCH', /^\/api\/group$/, handlePatchGroup, true],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = env.DB;

    if (!db) {
      return fail(500, 'The database binding is missing. Check wrangler.jsonc.');
    }

    // Anything that isn't the API is a static file. Cloudflare normally serves
    // those before the Worker runs; this covers the fall-through case.
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
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
          if (!user) return fail(401, 'Please sign in.');
        }

        const params = match.groups ?? {};
        // Tidy expired sessions occasionally, after the response is sent.
        if (Math.random() < 0.02 && ctx?.waitUntil) {
          ctx.waitUntil(
            import('./db.js').then((m) => m.purgeExpiredSessions(db)).catch(() => {})
          );
        }
        return await handler(request, env, db, url, user, params);
      } catch (err) {
        console.error('[error]', err?.stack || String(err));
        return fail(500, 'Something went wrong on our end.');
      }
    }

    return matchedPath
      ? fail(405, 'That method is not allowed here.')
      : fail(404, 'No such endpoint.');
  },
};
