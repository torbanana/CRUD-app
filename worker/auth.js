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
const KEY_BITS = 256;
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'sid';

const encoder = new TextEncoder();

const toHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

function iterationsFrom(env) {
  const raw = Number(env.PBKDF2_ITERATIONS);
  return Number.isInteger(raw) && raw >= 1000 ? raw : DEFAULT_ITERATIONS;
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
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000000) return false;

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

  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export async function endSession(db, token, { secure = true } = {}) {
  if (token) await deleteSession(db, token);
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ------------------------------------------------------------ request helpers

/**
 * Parse the Cookie header into a plain object.
 *
 * A cookie value is whatever the client sent, so it need not be valid
 * percent-encoding -- `sid=%` makes decodeURIComponent throw. That must not
 * become a 500: an undecodable cookie is a bad cookie, which is the same
 * situation as no cookie at all. Keep the raw value and let the caller decide;
 * a session token that failed to decode simply will not match a stored one.
 */
export function parseCookies(request) {
  const out = Object.create(null);
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
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
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const session = await findValidSession(db, token);
  if (!session) return null;
  return findUserById(db, session.user_id);
}

// The other half of the rule -- "you may only write your own steps" -- is not a
// check at all: the write routes take the user id from the session and ignore
// any id in the request body, so writing to someone else's row is not
// expressible. See PUT /api/entries in index.js.
