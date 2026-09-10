// Fills a running instance with ten members and two weeks of plausible steps,
// so you can see the race track working before your real group signs up.
//
//   npm run seed                                  -> against wrangler dev
//   node scripts/seed.mjs --base https://... --invite CODE
//
// This talks to the public HTTP API rather than writing SQL directly, which
// means it works identically against local D1 and production, and the dates are
// always relative to today rather than baked in.
//
// Two things about that convenience are dangerous, and both are handled below:
//
//   1. "Works identically against production" means one wrong --base populates
//      your real group with ten fake members. Remote hosts now need --allow-remote.
//   2. The demo password used to be the literal string 'password123', committed
//      to a public repo. Every run now generates a fresh random one and prints
//      it once. Pass --password to choose your own.

import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag('base', 'http://127.0.0.1:8787').replace(/\/$/, '');
const INVITE = flag('invite', 'STEP2026');

// 24 bytes of base64url: well past anything guessable, and the app's common
// password list can never contain it.
const PASSWORD = flag('password', randomBytes(18).toString('base64url'));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const target = new URL(BASE);

if (!LOCAL_HOSTS.has(target.hostname) && !has('allow-remote')) {
  console.error(`Refusing to seed ${BASE} -- that is not a local address.`);
  console.error('');
  console.error('This script creates ten accounts with a shared password. Doing that to a');
  console.error('live group fills its ten places with fake members and hands anyone who');
  console.error('learns the password a way in.');
  console.error('');
  console.error('If you really mean it, re-run with --allow-remote.');
  process.exit(1);
}

const PEOPLE = [
  // A spread of characters so the track has a real shape: a runaway leader, a
  // tight midfield scrap, someone who has barely logged, someone climbing.
  { name: 'Aisyah', avatar: '🦊', pattern: 'leader', goal: 90000 },
  { name: 'Ben', avatar: '🐢', pattern: 'steady', goal: 70000 },
  { name: 'Chloe', avatar: '🐇', pattern: 'climber', goal: 70000 },
  { name: 'Darren', avatar: '🦁', pattern: 'steady', goal: 70000 },
  { name: 'Elena', avatar: '🦄', pattern: 'weekender', goal: 60000 },
  { name: 'Faiz', avatar: '🐯', pattern: 'steady', goal: 70000 },
  { name: 'Grace', avatar: '🐼', pattern: 'sporadic', goal: 50000 },
  { name: 'Hakim', avatar: '🦖', pattern: 'climber', goal: 80000 },
  { name: 'Iris', avatar: '🐧', pattern: 'behind', goal: 70000 },
  { name: 'Jonas', avatar: '🦉', pattern: 'steady', goal: 70000 },
];

// Deterministic pseudo-random, so re-seeding gives the same demo week and
// screenshots stay comparable.
let seedState = 12345;
const rand = () => {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
};
const jitter = (base, spread) => Math.max(0, Math.round(base + (rand() - 0.5) * spread));

/** Steps for one person on one day, dayIndex 0 = Monday. */
function stepsFor(pattern, dayIndex) {
  const isWeekend = dayIndex >= 5;
  switch (pattern) {
    case 'leader':
      return jitter(15500, 4000);
    case 'steady':
      return jitter(isWeekend ? 11000 : 9800, 3500);
    case 'climber':
      return jitter(6000 + dayIndex * 1600, 2500); // starts slow, builds
    case 'weekender':
      return isWeekend ? jitter(18000, 5000) : jitter(4200, 2000);
    case 'sporadic':
      return rand() < 0.45 ? 0 : jitter(9000, 6000); // this is what makes ghosts
    case 'behind':
      return jitter(4800, 2500);
    default:
      return jitter(9000, 3000);
  }
}

// --- date helpers, matching the Worker's Monday-first weeks -----------------

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const mondayOffset = (today.getUTCDay() + 6) % 7;

const thisMonday = new Date(today);
thisMonday.setUTCDate(today.getUTCDate() - mondayOffset);
const lastMonday = new Date(thisMonday);
lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);

const weekDates = (monday) =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return iso(d);
  });

const elapsed = mondayOffset + 1; // 1 = Monday ... 7 = Sunday

// --- API plumbing ------------------------------------------------------------

async function call(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      // The Worker rejects writes whose Origin is not its own -- see
      // originAllowed() in worker/index.js. A script has to say who it is too.
      origin: target.origin,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, cookie: (res.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('sid='))?.split(';')[0] };
}

// --- go ----------------------------------------------------------------------

console.log(`Seeding ${BASE}\n`);

const health = await call('GET', '/api/config');
if (health.status !== 200) {
  console.error(`Could not reach ${BASE}/api/config (HTTP ${health.status}).`);
  console.error('Is the server running? Try: npm run dev');
  process.exit(1);
}
if (health.json.memberCount > 0) {
  console.log(`That instance already has ${health.json.memberCount} member(s); leaving it alone.`);
  console.log('To start over locally: npm run db:reset');
  process.exit(0);
}

let created = 0;
for (const person of PEOPLE) {
  const signup = await call('POST', '/api/auth/signup', {
    name: person.name,
    email: `${person.name.toLowerCase()}@example.com`,
    password: PASSWORD,
    avatar: person.avatar,
    inviteCode: INVITE,
  });

  if (signup.status !== 201) {
    console.error(`  ${person.name}: signup failed -- ${signup.json?.error ?? signup.status}`);
    if (signup.status === 403) console.error('  (wrong --invite code?)');
    process.exit(1);
  }

  const cookie = signup.cookie;
  await call('PATCH', '/api/me', { weeklyGoal: person.goal }, cookie);

  // Last week: a complete week, so the archive view has something in it.
  for (const [dayIndex, date] of weekDates(lastMonday).entries()) {
    const steps = stepsFor(person.pattern, dayIndex);
    if (steps > 0) await call('PUT', '/api/entries', { date, steps }, cookie);
  }

  // This week: only up to today. Grace and Iris skip today, so the UI has
  // ghost runners to grey out.
  const skipsToday = person.pattern === 'sporadic' || person.pattern === 'behind';
  for (const [dayIndex, date] of weekDates(thisMonday).entries()) {
    if (dayIndex >= elapsed) continue; // never log the future
    if (skipsToday && dayIndex === elapsed - 1) continue;
    const steps = stepsFor(person.pattern, dayIndex);
    if (steps > 0) await call('PUT', '/api/entries', { date, steps }, cookie);
  }

  created++;
  console.log(`  ${person.avatar}  ${person.name.padEnd(8)} ${person.pattern}`);
}

console.log(`\nSeeded ${created} members.`);
console.log(`  this week: ${iso(thisMonday)} (day ${elapsed} of 7)`);
console.log(`  last week: ${iso(lastMonday)} (complete, for the archive)`);
console.log('\nAll ten demo accounts share this password, shown once:');
console.log(`\n  ${PASSWORD}\n`);
console.log('Sign in with any of:');
console.log('  aisyah@example.com   (the leader)');
console.log('  chloe@example.com    (mid-pack climber)');
console.log("  iris@example.com     (last place, hasn't logged today)");
