// Brute-force throttling for the two unauthenticated write routes.
//
// Login and signup are the only doors into this app, and until now both were
// unlimited: an attacker could grind passwords against a known member's email,
// or guess the invite code, as fast as the network allowed. PBKDF2 at 25,000
// iterations (see auth.js -- the Workers free plan caps CPU at 10ms) is not a
// strong enough brake on its own, so the brake lives here instead.
//
// Counting happens against TWO keys per attempt: the source IP and the target
// email (or, for signup, the literal 'signup'). Locking on the IP alone would
// miss a distributed guess at one account; locking on the email alone would let
// one IP walk the whole member list. Either key tripping locks the attempt.
//
// State lives in D1 rather than in memory because a Worker isolate is discarded
// between requests and there may be many of them at once -- an in-memory counter
// would reset constantly and count only a fraction of the traffic.

const WINDOW = '-900 seconds'; // failures older than 15 min no longer count

// Progressive backoff: annoying for a human who mistyped, fatal for a script.
const STEPS = [
  { fails: 5, lockSeconds: 60 },
  { fails: 10, lockSeconds: 300 },
  { fails: 15, lockSeconds: 1800 },
];

/**
 * The real client address. Cloudflare sets CF-Connecting-IP at the edge and
 * overwrites any value the client sent, so unlike X-Forwarded-For it cannot be
 * spoofed. `wrangler dev` does not set it, hence the local fallback.
 */
export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'local';
}

export const ipKey = (request) => `ip:${clientIp(request)}`;
export const subjectKey = (subject) => `subject:${String(subject).toLowerCase().trim()}`;

/** The pair of keys one attempt is counted against. */
export function throttleKeys(request, subject) {
  return [ipKey(request), subjectKey(subject)];
}

// A note on choosing keys. A shared subject -- 'signup', say -- caps attempts
// against this instance from every source at once, which is exactly right for
// guessing at the one invite code: per-IP limits alone would fall to a
// botnet. The cost is that a determined attacker can hold signup closed for
// half an hour. That is an acceptable trade for a group that signs up once.
//
// It is NOT acceptable for password resets, where the same shared key would
// let one attacker block everybody's recovery. Those throttle on ipKey alone;
// there is no shared secret to protect, because each token is 32 bytes of
// CSPRNG output and cannot be guessed at any rate.

/**
 * Is either key currently locked out? Returns the seconds still to wait, or 0.
 * Checked BEFORE the password is verified, so a locked-out attacker does not
 * even get to spend our CPU on a PBKDF2 derivation.
 */
export async function retryAfter(db, keys) {
  const row = await db
    .prepare(
      `SELECT MAX(CAST((julianday(locked_until) - julianday('now')) * 86400 AS INTEGER)) AS wait
         FROM auth_throttle
        WHERE key IN (${keys.map(() => '?').join(', ')})
          AND locked_until IS NOT NULL
          AND locked_until > datetime('now')`
    )
    .bind(...keys)
    .first();
  return Math.max(0, row?.wait ?? 0);
}

/** Count one failed attempt against both keys, locking out once over a step. */
export async function recordFailure(db, keys) {
  for (const key of keys) {
    const row = await db
      .prepare(
        `INSERT INTO auth_throttle(key, fails, window_start)
              VALUES (?, 1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
              fails = CASE WHEN auth_throttle.window_start <= datetime('now', ?)
                           THEN 1 ELSE auth_throttle.fails + 1 END,
              window_start = CASE WHEN auth_throttle.window_start <= datetime('now', ?)
                           THEN datetime('now') ELSE auth_throttle.window_start END
         RETURNING fails`
      )
      .bind(key, WINDOW, WINDOW)
      .first();

    // The highest step the attempt count has passed decides the lock length.
    const step = STEPS.filter((s) => (row?.fails ?? 0) >= s.fails).pop();
    if (step) {
      await db
        .prepare('UPDATE auth_throttle SET locked_until = datetime(\'now\', ?) WHERE key = ?')
        .bind(`+${step.lockSeconds} seconds`, key)
        .run();
    }
  }
}

/** A correct password clears the slate, so one typo never compounds. */
export async function clearFailures(db, keys) {
  await db
    .prepare(`DELETE FROM auth_throttle WHERE key IN (${keys.map(() => '?').join(', ')})`)
    .bind(...keys)
    .run();
}

/** Housekeeping, run occasionally alongside the session purge. */
export async function purgeStaleThrottles(db) {
  const info = await db
    .prepare(
      `DELETE FROM auth_throttle
        WHERE window_start <= datetime('now', '-1 day')
          AND (locked_until IS NULL OR locked_until <= datetime('now'))`
    )
    .run();
  return info.meta.changes;
}
