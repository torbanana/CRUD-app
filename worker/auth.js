// Authentication: password hashing, session cookies, route guards.
//
// The Node version used scrypt. Workers has no scrypt and no bcrypt -- the only
// password KDF available is PBKDF2 through WebCrypto, so that is what this uses.
//
// PBKDF2 cost is a real constraint here, not a free knob. Workers on the FREE
// plan allow 10ms of CPU per request, and PBKDF2 is pure CPU: measured at
// roughly 0.125ms per 1,000 iterations of PBKDF2-SHA256. So 600,000 iterations
// (the current OWASP figure) would take ~75ms and the login request would be
// killed outright.
//
// The iteration count therefore comes from env.PBKDF2_ITERATIONS, defaulting to
// a free-tier-safe 25,000 (~3ms, leaving headroom for the D1 query and JSON).
// It is STORED INSIDE each hash, so raising it later is backward compatible:
// old hashes keep verifying at their original cost, new ones use the new value.
// On the Workers paid plan (5 min CPU) set it to 600000 and it is simply better.
//
// Sessions are opaque random tokens stored in the sessions table and handed to
// the browser in an httpOnly cookie. The cookie holds no user data, so there is
// nothing to forge: a token either exists in the table and is unexpired, or it
// is worthless.

import { createSession, deleteSession, findUserById, findValidSession } from './db.js';

const DEFAULT_ITERATIONS = 25000;
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 1000000;
const KEY_BITS = 256;
const SESSION_DAYS = 30;

// Two cookie names for one cookie. Over HTTPS we use the __Host- prefix, which
// the browser itself enforces: it refuses to store the cookie unless it is
// Secure, Path=/ and has no Domain attribute. That last part is the valuable
// one -- it means a compromised sibling subdomain cannot overwrite our session
// cookie, which a plain 'sid' cookie has no defence against. The prefix
// requires Secure, so `wrangler dev` over plain http falls back to 'sid'.
export const SESSION_COOKIE = '__Host-sid';
export const SESSION_COOKIE_INSECURE = 'sid';

const cookieName = (secure) => (secure ? SESSION_COOKIE : SESSION_COOKIE_INSECURE);

const encoder = new TextEncoder();

const toHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

export function iterationsFrom(env) {
  const raw = Number(env.PBKDF2_ITERATIONS);
  return Number.isInteger(raw) && raw >= MIN_ITERATIONS && raw <= MAX_ITERATIONS
    ? raw
    : DEFAULT_ITERATIONS;
}

async function deriveBits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

/** Compare without leaking where the mismatch is. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ------------------------------------------------------------------ passwords

/** Hash a password as 'pbkdf2$<iterations>$<saltHex>$<keyHex>'. */
export async function hashPassword(password, env) {
  const iterations = iterationsFrom(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(key)}`;
}

/**
 * Check a password against a stored hash, reading the cost back out of the
 * hash itself so older records still verify after the setting changes.
 */
export async function verifyPassword(password, stored) {
  const [scheme, iterStr, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltHex || !keyHex) return false;

  const iterations = Number(iterStr);
  // Floor as well as ceiling. Nothing can currently write a hash below the
  // floor, but if anything ever did -- a bad import, a hand-edited row -- we
  // refuse it outright rather than cheerfully verifying against a 1-round KDF.
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return false;
  }

  const expected = fromHex(keyHex);
  const actual = await deriveBits(password, fromHex(saltHex), iterations);
  return timingSafeEqual(expected, actual);
}

// ------------------------------------------------------------------- sessions

/** Create a session and return the Set-Cookie value for it. */
export async function startSession(db, userId, { secure = true } = {}) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);

  // SQLite compares datetimes as strings, so store the same shape it produces.
  await createSession(db, token, userId, expires.toISOString().replace('T', ' ').slice(0, 19));

  // SameSite=Strict rather than Lax. Lax still attaches the cookie to top-level
  // GET navigations from other sites, which is what you want for an app people
  // link into; nobody deep-links into a private step tracker, so we take the
  // stricter setting and close that gap entirely.
  const parts = [
    `${cookieName(secure)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * End every session the request presented, and clear BOTH cookie names.
 *
 * Clearing only the current name is not enough. An instance upgraded from the
 * plain 'sid' cookie can have both in the browser at once: the new login sets
 * __Host-sid, the old sid is still sitting there, and its token is still live
 * in the sessions table. Clear one and getSessionUser falls straight back to
 * the other -- logout would report success and sign nobody out.
 *
 * Returns an array of Set-Cookie values; the caller appends them all.
 */
export async function endSession(db, tokens, { secure = true } = {}) {
  const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))];
  await Promise.all(list.map((token) => deleteSession(db, token)));

  return [SESSION_COOKIE, SESSION_COOKIE_INSECURE].map((name) => {
    const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  });
}

/**
 * Compare two secrets without leaking their contents or their length through
 * timing. Hashing first gives both sides a fixed 32-byte width, so the
 * comparison below runs for the same time whatever the inputs were. Used for
 * the invite code, where a plain `!==` would in principle leak the code one
 * character at a time.
 */
export async function secretsMatch(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  return timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

// -------------------------------------------------------------- reset tokens

/**
 * SHA-256 of a password-reset token, lowercase hex. The database stores this
 * and never the token itself, so a leaked dump contains no usable links.
 *
 * A plain digest is right here where a password needs PBKDF2: the token is 32
 * bytes of CSPRNG output, so there is no small search space to slow an
 * attacker down within. What matters instead is that lookup stays a single
 * indexed read, which a per-row salt would rule out.
 *
 * scripts/reset-password.mjs computes the same digest with node:crypto. The
 * two must agree exactly -- UTF-8 bytes, SHA-256, lowercase hex.
 */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(token)));
  return toHex(new Uint8Array(digest));
}

// ------------------------------------------------------------ request helpers

/** Parse the Cookie header into a plain object. */
export function parseCookies(request) {
  const out = Object.create(null);
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed escape (`sid=%`) makes decodeURIComponent throw. That is a
    // bad cookie, not a server fault, so keep the raw value and let the lookup
    // miss -- otherwise one junk request header becomes a 500.
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Resolve the signed-in member, or null. This is the read half of the
 * permission rule: every /api route except config, signup and login refuses to
 * proceed without it.
 */
export async function getSessionUser(db, request) {
  const cookies = parseCookies(request);
  // Accept either name: over HTTPS the browser sends __Host-sid, and a session
  // issued before this change (or by `wrangler dev`) is still called sid.
  const token = cookies[SESSION_COOKIE] || cookies[SESSION_COOKIE_INSECURE];
  if (!token) return null;
  const session = await findValidSession(db, token);
  if (!session) return null;
  return findUserById(db, session.user_id);
}

// The other half of the rule -- "you may only write your own steps" -- is not a
// check at all: the write routes take the user id from the session and ignore
// any id in the request body, so writing to someone else's row is not
// expressible. See PUT /api/entries in index.js.
