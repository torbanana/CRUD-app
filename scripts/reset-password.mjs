// Mint a single-use password-reset link for one member.
//
//   npm run reset-password -- --email aisyah@example.com
//   npm run reset-password -- --email aisyah@example.com --remote --base https://step-race.you.workers.dev
//
// WHY THIS IS A SCRIPT AND NOT A PAGE
//
// A "forgot password" form has to send the link somewhere, and this project
// has no mail provider. Adding one means a third-party account, an API key
// held as a Worker secret, and a verified sender domain -- real infrastructure
// for a group of ten people who already have each other's phone numbers. So
// the delivery channel is you: run this, then send the link over whatever you
// already use to talk to each other.
//
// The trade is that a locked-out member has to ask a human. For ten people
// that is a text message; it does not scale, and it is not meant to.
//
// WHAT THIS WRITES
//
// Only the SHA-256 of the token reaches the database, so the link cannot be
// recovered from a dump -- or from this terminal once you clear it. If you
// lose it, run the command again; minting a new link kills the old one.

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_NAME = 'step-race';
const DEFAULT_MINUTES = 60;
const TOKEN_BYTES = 32;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const email = flag('email');
const remote = has('remote');
const minutes = Number(flag('minutes', DEFAULT_MINUTES));
const base = flag('base', remote ? null : 'http://127.0.0.1:8787');

function usage(problem) {
  if (problem) console.error(`${problem}\n`);
  console.error('Mint a single-use password-reset link for one member.\n');
  console.error('  npm run reset-password -- --email someone@example.com');
  console.error('  npm run reset-password -- --email someone@example.com \\');
  console.error('      --remote --base https://step-race.<your-subdomain>.workers.dev\n');
  console.error('  --email    who to reset (required)');
  console.error('  --remote   act on the deployed D1 database, not the local one');
  console.error('  --base     the site URL the link should point at');
  console.error(`             (required with --remote; defaults to the dev server otherwise)`);
  console.error(`  --minutes  how long the link stays valid (default ${DEFAULT_MINUTES})`);
  process.exit(1);
}

if (!email) usage('Which member? Pass --email.');
if (!base) usage('With --remote I cannot guess your site URL. Pass --base https://...');
if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
  usage('--minutes must be a whole number between 5 and 1440.');
}

/**
 * Run one statement through wrangler and parse its JSON.
 *
 * Note what is NOT here: any interpolation of `email`. wrangler d1 execute has
 * no bind parameters, so instead of escaping operator input into SQL we read
 * every member out and match in JavaScript. The only values that ever reach a
 * statement are ones this script generated -- hex, an integer, a timestamp.
 */
// Run wrangler's own entry point under this Node, rather than going through
// `npx`. On Windows that would mean spawning npx.cmd, which Node refuses
// without a shell -- and handing SQL to a shell is not something to do for
// convenience. This way there is no shell, no .cmd, and no trouble with the
// spaces that turn up in real project paths.
function findWrangler() {
  // The package's `exports` map does not expose bin/, so require.resolve on
  // the subpath fails on a normal install. Try it anyway in case that changes,
  // then fall back to walking up for node_modules -- which also covers a
  // hoisted install, where wrangler sits above this package.
  try {
    return createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');
  } catch {
    /* fall through */
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const wranglerBin = findWrangler();
if (!wranglerBin) {
  console.error('Could not find wrangler. Run `npm install` first.');
  process.exit(1);
}

function query(sql) {
  const where = remote ? ['--remote', '--yes'] : ['--local'];
  const run = spawnSync(
    process.execPath,
    [wranglerBin, 'd1', 'execute', DB_NAME, ...where, '--json', '--command', sql],
    { encoding: 'utf8' }
  );

  if (run.error) {
    console.error(`Could not run wrangler: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error(run.stderr?.trim() || run.stdout?.trim() || 'wrangler failed.');
    process.exit(1);
  }

  // --json still lets the occasional notice through, so take the JSON body.
  const text = run.stdout ?? '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    console.error('Could not read wrangler output as JSON:\n' + text.trim());
    process.exit(1);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// --- find the member -------------------------------------------------------

console.log(`Reading members from the ${remote ? 'REMOTE' : 'local'} database...\n`);

const members = query('SELECT id, email, name FROM users ORDER BY id')[0]?.results ?? [];
const wanted = email.toLowerCase().trim();
const member = members.find((m) => String(m.email).toLowerCase() === wanted);

if (!member) {
  console.error(`No member with the email ${email}.`);
  if (members.length) {
    console.error('\nThe group is:');
    for (const m of members) console.error(`  ${m.email}  (${m.name})`);
  } else {
    console.error('\nThere are no members in that database yet.');
  }
  process.exit(1);
}

// --- mint ------------------------------------------------------------------

const token = randomBytes(TOKEN_BYTES).toString('hex');

// Must match hashToken() in worker/auth.js exactly: UTF-8, SHA-256, hex.
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

// SQLite's datetime('now') is UTC, and it compares datetimes as strings, so
// store the same shape it produces -- as worker/auth.js does for sessions.
const expiresAt = new Date(Date.now() + minutes * 60000)
  .toISOString()
  .replace('T', ' ')
  .slice(0, 19);

// Any link already outstanding for this person dies now, so exactly one is
// live at a time and a stale one in someone's chat history stops working.
query(
  `DELETE FROM password_resets WHERE user_id = ${member.id};
   INSERT INTO password_resets (token_hash, user_id, expires_at)
        VALUES ('${tokenHash}', ${member.id}, '${expiresAt}');`
);

const link = `${base.replace(/\/$/, '')}/reset#${token}`;

console.log(`Reset link for ${member.name} <${member.email}>, valid ${minutes} minutes:\n`);
console.log(`  ${link}\n`);
console.log('Send it over a channel you trust -- Signal, WhatsApp, in person.');
console.log('It works once. Using it also signs them out everywhere and kills any');
console.log('other link they had outstanding.');
console.log('');
console.log('Anyone who reads this link can take the account until it is used or');
console.log('expires. Only its hash is stored, so this is the only time you will');
console.log('see it: if you lose it, run this again.');
