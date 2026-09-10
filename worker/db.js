// Every query the app makes, against Cloudflare D1.
//
// D1 is SQLite, so the SQL is unchanged from the Node version -- but the API is
// async and statements are built with .bind(), so every function here returns a
// promise. Each takes the D1Database as its first argument rather than reaching
// for a module-level singleton: a Worker handles many requests in one isolate,
// and the binding arrives per-request on `env`.
//
// D1 result shapes, for reference:
//   .first()  -> the first row, or null
//   .all()    -> { results: [...], meta: {...} }
//   .run()    -> { meta: { changes, last_row_id, ... } }

// What the signed-in person may see about THEMSELVES.
const PUBLIC_USER_COLS = 'id, email, name, avatar, weekly_goal, created_at';

// What one member may see about the OTHERS. Email is deliberately absent: the
// leaderboard needs a name and an avatar, and nothing downstream of listUsers
// has ever used the address. Not selecting it means a future rendering change
// cannot accidentally publish nine people's email addresses to the tenth.
const MEMBER_COLS = 'id, name, avatar, weekly_goal';

// ---------------------------------------------------------------- group config

export async function getMeta(db) {
  const { results } = await db.prepare('SELECT key, value FROM meta').all();
  const out = {};
  for (const row of results) out[row.key] = row.value;
  return out;
}

export function setMeta(db, key, value) {
  return db
    .prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .bind(key, String(value))
    .run();
}

// ---------------------------------------------------------------------- users

export async function countUsers(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row?.n ?? 0;
}

export function findUserByEmail(db, email) {
  return db
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim())
    .first();
}

export function findUserById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`).bind(id).first();
}

/**
 * The one place that reads a password hash by id, for re-authenticating
 * someone who is already signed in. Kept separate from findUserById so the
 * hash never rides along in an object that gets serialised into a response.
 */
export function findUserCredentials(db, id) {
  return db
    .prepare('SELECT id, email, name, password_hash FROM users WHERE id = ?')
    .bind(id)
    .first();
}

export async function listUsers(db) {
  const { results } = await db.prepare(`SELECT ${MEMBER_COLS} FROM users ORDER BY id`).all();
  return results;
}

/**
 * Create a member, enforcing the group size limit IN THE INSERT.
 *
 * The route checks the count first for a friendly error, but a check followed
 * by an insert is two statements with a gap between them: ten people hitting
 * signup at once could all pass the check and all get in. The `WHERE (SELECT
 * COUNT(*) ...) < ?` makes the limit part of the write itself, so the eleventh
 * insert simply does not happen.
 *
 * Returns { user } on success, or { error: 'full' | 'duplicate' }.
 */
export async function createUser(
  db,
  { email, name, avatar, passwordHash, weeklyGoal = 70000 },
  maxMembers
) {
  let info;
  try {
    info = await db
      .prepare(
        `INSERT INTO users(email, name, avatar, password_hash, weekly_goal)
              SELECT ?, ?, ?, ?, ?
               WHERE (SELECT COUNT(*) FROM users) < ?`
      )
      .bind(email.toLowerCase().trim(), name.trim(), avatar, passwordHash, weeklyGoal, maxMembers)
      .run();
  } catch (err) {
    // The UNIQUE index on email is the real guard against duplicate accounts;
    // the route's lookup beforehand only exists to phrase the error nicely.
    if (/UNIQUE|constraint/i.test(String(err))) return { error: 'duplicate' };
    throw err;
  }

  if (info.meta.changes === 0) return { error: 'full' };
  return { user: await findUserById(db, info.meta.last_row_id) };
}

export async function updateUserProfile(db, id, { name, avatar, weeklyGoal }) {
  // Only overwrite the fields actually supplied; COALESCE leaves the rest alone.
  await db
    .prepare(
      `UPDATE users
          SET name        = COALESCE(?, name),
              avatar      = COALESCE(?, avatar),
              weekly_goal = COALESCE(?, weekly_goal)
        WHERE id = ?`
    )
    .bind(name ?? null, avatar ?? null, weeklyGoal ?? null, id)
    .run();
  return findUserById(db, id);
}

// -------------------------------------------------------------------- sessions

export function createSession(db, token, userId, expiresAt) {
  return db
    .prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run();
}

export function findValidSession(db, token) {
  return db
    .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')")
    .bind(token)
    .first();
}

export function deleteSession(db, token) {
  return db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/** Sign one person out of every device. The lever to pull after a compromise. */
export async function deleteSessionsForUser(db, userId) {
  const info = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return info.meta.changes;
}

// ------------------------------------------------------------ password resets

export async function setPasswordHash(db, userId, passwordHash) {
  const info = await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(passwordHash, userId)
    .run();
  return info.meta.changes;
}

/** Mint one. Written by scripts/reset-password.mjs, not by the Worker. */
export function createPasswordReset(db, tokenHash, userId, expiresAt) {
  return db
    .prepare('INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt)
    .run();
}

/** Look at a token without spending it, so the page can say whose link it is. */
export function peekPasswordReset(db, tokenHash) {
  return db
    .prepare(
      `SELECT r.user_id, u.name, u.email
         FROM password_resets r
         JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ?
          AND r.used_at IS NULL
          AND r.expires_at > datetime('now')`
    )
    .bind(tokenHash)
    .first();
}

/**
 * Spend a reset token, atomically.
 *
 * Single use is enforced by the UPDATE's own WHERE clause rather than by
 * reading the row and then writing it: two requests arriving with the same
 * token race, and exactly one of them matches `used_at IS NULL`. The other
 * gets no row back and is refused.
 *
 * Returns the row (with user_id) on success, or null.
 */
export function consumePasswordReset(db, tokenHash) {
  return db
    .prepare(
      `UPDATE password_resets
          SET used_at = datetime('now')
        WHERE token_hash = ?
          AND used_at IS NULL
          AND expires_at > datetime('now')
      RETURNING user_id`
    )
    .bind(tokenHash)
    .first();
}

/** Every other outstanding link for this person dies with the one just used. */
export async function deletePasswordResetsForUser(db, userId) {
  const info = await db
    .prepare('DELETE FROM password_resets WHERE user_id = ?')
    .bind(userId)
    .run();
  return info.meta.changes;
}

export async function purgeExpiredPasswordResets(db) {
  const info = await db
    .prepare(
      `DELETE FROM password_resets
        WHERE expires_at <= datetime('now')
           OR used_at <= datetime('now', '-1 day')`
    )
    .run();
  return info.meta.changes;
}

export async function purgeExpiredSessions(db) {
  const info = await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  return info.meta.changes;
}

// ---------------------------------------------------------------- step entries

/** Every entry in a date range, for all members. Drives the whole week view. */
export async function entriesInRange(db, startISO, endISO) {
  const { results } = await db
    .prepare(
      'SELECT user_id, date, steps FROM step_entries WHERE date BETWEEN ? AND ? ORDER BY date'
    )
    .bind(startISO, endISO)
    .all();
  return results;
}

/**
 * Record one person's steps for one day.
 * The caller always passes the *session* user id, never a client-supplied one --
 * that is what enforces "you may only edit your own steps".
 */
export async function upsertEntry(db, userId, dateISO, steps) {
  await db
    .prepare(
      `INSERT INTO step_entries(user_id, date, steps) VALUES (?, ?, ?)
         ON CONFLICT(user_id, date)
         DO UPDATE SET steps = excluded.steps, updated_at = datetime('now')`
    )
    .bind(userId, dateISO, steps)
    .run();
  return db
    .prepare('SELECT user_id, date, steps FROM step_entries WHERE user_id = ? AND date = ?')
    .bind(userId, dateISO)
    .first();
}

export async function deleteEntry(db, userId, dateISO) {
  const info = await db
    .prepare('DELETE FROM step_entries WHERE user_id = ? AND date = ?')
    .bind(userId, dateISO)
    .run();
  return info.meta.changes;
}

/** Week starts that have at least one entry -- the archive list. */
export async function weeksWithData(db) {
  // date(d, 'weekday 0', '-6 days') is SQLite's way of saying "the Monday of
  // that week": jump forward to Sunday, then back six days.
  const { results } = await db
    .prepare(
      `SELECT DISTINCT date(date, 'weekday 0', '-6 days') AS week_start
         FROM step_entries
        ORDER BY week_start DESC`
    )
    .all();
  return results.map((row) => row.week_start);
}

// ---------------------------------------------------------------------- cheers

export async function cheersForWeek(db, weekStartISO) {
  const { results } = await db
    .prepare('SELECT from_user, to_user FROM cheers WHERE week_start = ?')
    .bind(weekStartISO)
    .all();
  return results;
}

/** Returns false if this person already cheered that person this week. */
export async function addCheer(db, fromUserId, toUserId, weekStartISO) {
  const info = await db
    .prepare('INSERT OR IGNORE INTO cheers(from_user, to_user, week_start) VALUES (?, ?, ?)')
    .bind(fromUserId, toUserId, weekStartISO)
    .run();
  return info.meta.changes > 0;
}

export async function removeCheer(db, fromUserId, toUserId, weekStartISO) {
  const info = await db
    .prepare('DELETE FROM cheers WHERE from_user = ? AND to_user = ? AND week_start = ?')
    .bind(fromUserId, toUserId, weekStartISO)
    .run();
  return info.meta.changes;
}
