# Step Race — a weekly step competition for ten people

Everyone logs their daily steps. The week's totals put ten little runners on a
shared athletics track that you scroll sideways to follow, with a leaderboard,
your own pace target, and one group goal that everybody's steps feed into.

The week resets every Monday, so there are fifty-two chances to win a year
rather than one.

Runs on **Cloudflare Workers + D1**. Both have free tiers that comfortably cover
ten people, and D1 is SQLite, so there is a real relational database behind it.

## Running it locally

```bash
npm install
npm run db:init     # create the local D1 tables
npm run dev         # http://127.0.0.1:8787
npm run seed        # optional: ten demo members, two weeks of steps
```

`npm run dev` is `wrangler dev`, which runs the real Workers runtime and a real
local SQLite database on your machine — no Cloudflare account needed to develop.

Demo accounts are `aisyah@example.com` … `jonas@example.com`. They share one
password, which `npm run seed` generates freshly each run and prints once — it
is not stored anywhere, so re-seed if you lose it. `npm run db:reset` drops the
local tables and recreates them.

`seed.mjs` refuses to run against anything but a local address unless you pass
`--allow-remote`. It creates ten accounts with a shared password; doing that to
a live group fills its ten places with fake members.

For your real group: skip the seed, and have everyone visit the deployed URL and
pick **Join the group**. They'll need the invite code.

## Forgotten passwords

Someone signed in can change their own password from the profile dialog — the
🙂 button, then **Change your password**. It asks for the current one, and it
signs them out on every other device.

Someone locked *out* has to ask you, because there is no mail provider here and
adding one would mean a third-party account, an API key and a verified sender
domain for a group of ten. Mint them a link instead:

```bash
npm run reset-password -- --email ben@example.com

# against production
npm run reset-password -- --email ben@example.com \
    --remote --base https://step-race.<your-subdomain>.workers.dev
```

It prints a one-time link. Send it over whatever you already use to talk to
each other. It expires in an hour (`--minutes` to change that), works once, and
using it signs that person out everywhere and kills any other link they had
outstanding. Only the link's SHA-256 is stored, so if you lose it, run the
command again — which also invalidates the one you lost.

The token travels in the URL *fragment* (`/reset#…`), which browsers never send
to a server, so it stays out of request logs and out of Cloudflare's traces.
The page reads it and posts it in a body.

This does not scale, and it is not meant to. For ten people it is a text
message.

## Deploying

You need a Cloudflare account (the free plan is fine). One-time setup:

```bash
npx wrangler login                       # opens a browser to authorise
npx wrangler d1 create step-race         # prints a database_id
```

Paste that `database_id` into `wrangler.jsonc`, then:

```bash
npx wrangler secret put INVITE_CODE      # REQUIRED — signup is closed without it
npm run db:init:remote                   # create the tables in production
npm run deploy
```

That prints your URL — `https://step-race.<your-subdomain>.workers.dev`. Send it
to your nine people.

`npm run tail` streams live logs.

Before you send that URL to anyone, walk the checklist in
[SECURITY.md](SECURITY.md) — it is six commands and it is the difference between
a private group and a public one.

> **Upgrading an instance deployed before the hardening changes?** Re-run
> `npm run db:init:remote`. It is idempotent, and it adds the two new tables:
> `auth_throttle`, which rate limiting needs, and `password_resets`. Without
> the first, every login returns a 500.

### What this costs

Nothing, for a group of this size. The Workers free plan allows 100,000 requests
a day and D1's free tier allows 5 GB of storage with 5 million row reads a day;
ten people logging steps will not come close to either.

There is one real consequence of the free plan, though — see below.

### The free plan's 10ms CPU limit

Workers on the free plan allow **10ms of CPU per request**. That matters in
exactly one place: password hashing, which is deliberately CPU-expensive.

Workers has no bcrypt or scrypt, so this app uses PBKDF2-SHA256 via WebCrypto,
measured at roughly **0.125ms per 1,000 iterations**. The current OWASP
recommendation of 600,000 iterations would take ~75ms and the login request
would be killed outright.

So `PBKDF2_ITERATIONS` defaults to **25,000** (~3ms), which fits the free plan
with headroom. That is weaker than a public-facing app should use. It is a
considered trade for this context — signup is invite-only, the group is capped at
ten, and nothing here is worth much to an attacker — but it is a trade, and you
should know you're making it.

If you move to the Workers paid plan (5 minutes of CPU per request), set
`PBKDF2_ITERATIONS` to `600000` in `wrangler.jsonc` and redeploy. The iteration
count is stored inside each password hash, so raising it is backward compatible:
existing accounts keep verifying at their original cost, and new or changed
passwords use the stronger setting.

### Why not GitHub Pages

It can't run this, and can't be made to. Pages serves static files only — no
process to run the API, no database to log into. Cloudflare Workers is the thing
that makes a static-hosting-shaped deployment actually able to run a server.

## Configuration

Plain settings live in `vars` in `wrangler.jsonc`:

| Variable | Default | What it does |
| --- | --- | --- |
| `APP_TZ` | `Asia/Singapore` | Decides "what day is it" and when the week rolls over |
| `MAX_MEMBERS` | `10` | Hard cap on group size |
| `PBKDF2_ITERATIONS` | `25000` | Password hashing cost — see above |

`INVITE_CODE` is a **secret**, not a var, because this repo is public:

```bash
npx wrangler secret put INVITE_CODE          # production
echo 'INVITE_CODE=whatever' > .dev.vars      # local dev (gitignored)
```

There is **no production fallback**. A deployed Worker without this secret
refuses every signup with a 503 rather than accepting a code printed in a public
repo. `wrangler dev` on localhost still accepts `STEP2026`, so `npm run seed`
keeps working; nothing on localhost is worth protecting.

The practical consequence: if you deploy and nobody can join, you forgot the
secret. That is the intended failure — the alternative was a group anyone on the
internet could walk into.

`APP_TZ` matters more than it looks. A Worker runs in whichever datacentre is
nearest the visitor, so there is no meaningful "server timezone" to inherit —
without an explicit value the week would roll over at the wrong moment for
everyone.

## How it is built

- **Runtime** — Cloudflare Workers (a V8 isolate, not Node)
- **Database** — Cloudflare D1, which is SQLite
- **Auth** — PBKDF2-SHA256 via WebCrypto, opaque session tokens in an httpOnly
  cookie
- **Frontend** — plain HTML, CSS and ES modules, served straight from
  Cloudflare's edge. No build step, no framework, no bundler.
- **Runtime dependencies — none.** `wrangler` is the only package, and it is a
  build-time tool. Express doesn't run on Workers, and twelve routes didn't
  justify a replacement framework, so the router is about forty lines.

### The data model

One record type does the real work:

```
step_entries (user_id, date, steps)   UNIQUE(user_id, date)
```

One row per person per day. Every number the app displays — weekly totals, ranks,
positions on the track, pace, group progress — is derived by summing that table
over a date range. Nothing is stored pre-summed, so nothing can go stale. Ten
people over seven days is at most seventy rows to add up.

The `UNIQUE(user_id, date)` constraint is what makes logging idempotent: entering
Tuesday twice edits Tuesday rather than adding a second Tuesday.

Supporting tables are plumbing, not features: `users`, `sessions`, `cheers` (the
👏 button), and `meta` (the group's name and goal).

### The permission rule

> Any member can read everyone's steps. You can only write your own.

The read half is one check at the top of every authenticated route. The write
half isn't a check at all — `PUT /api/entries` takes the user id from the session
and ignores any id in the request body, so "write to someone else's day" is not
expressible, crafted request or not.

Everything else is deliberately equal: any member can change the group's shared
goal and the group's name, because a group of ten does not need an admin. This
is a real trade — one member can rename the group for everyone, and nothing logs
who did it. It is fine among ten people who know each other and wrong the moment
that stops being true. See [SECURITY.md](SECURITY.md).

Getting *in* is a different matter, and is defended properly: see
[SECURITY.md](SECURITY.md) for the invite code, rate limiting, session and
header policy.

## The features, and why they exist

The leaderboard is the fun part, but it isn't where an app like this succeeds or
fails. Two things kill it: people forget to log, and whoever is losing by
Wednesday stops opening it. Most of these features target one of those.

**Against forgetting to log**

- **Backfill grid** — the whole week as seven boxes. Forgot Tuesday? Type it in.
  Past weeks stay editable, because people genuinely don't catch up until Monday.
- **Ghost runners** — someone who hasn't logged today is greyed and dashed, but
  still standing at their real total, never dropped to zero. The board never
  looks emptier than the group actually is, and a row of ghosts is a gentle nudge.
- **"8/10 logged today"** — one number, visible, mildly shaming.

**Against losing being boring**

- **Personal pace line** — an orange dashed line on the track at where *you*
  should be by today to hit *your* goal. Tenth place still has a race to run.
- **Everyone sets their own weekly goal** — 50k and 90k are both real targets.
- **Head-to-head chips** — "1,482 behind Hakim", "10,842 ahead of Grace". The
  person one place above you is a better motivator than the leader.
- **Group goal** — "walking to Kuala Lumpur, 46%". Everyone's steps count towards
  it wherever they are on the leaderboard.
- **Weekly reset** — Monday is a clean slate; finished weeks stay in the archive.

**Making the race legible**

- **Absolute scale** — a fixed number of pixels per thousand steps, so the gaps
  you see are the real gaps. The leader really is off-screen. A compressed scale
  would keep everyone visible but would quietly lie about the distances.
- **Fixed name gutter** — a runner scrolled out of view still has a visible lane.
- **Minimap** — the whole track as one strip; click or drag it to jump. Plus a
  **Jump to me** button and arrow-key scrolling.
- **Milestone flags** every 10k, and a checkered flag at your weekly goal, so
  scrolling has landmarks instead of blank road.
- **Avatars** — 22 to pick from. Being a specific character is what makes the
  track worth scrolling.

**The one social action**

- **👏 Cheer** — one per person per week, undoable. Not a comment thread: you
  already have a group chat, and comments would mean moderation.

## Deliberately left out

- **Health app / Google Fit import** — the real answer to logging friction, and
  an OAuth rabbit hole that would eat the whole project. Manual entry plus
  backfill is the right trade for ten people who know each other.
- **Anti-cheat validation** — social trust beats a step cap in a group of ten.
  The server only rejects a day over 200,000 steps, which is a typo, not a lie.
- **Comments, photos, public profiles** — each one adds a record type, and two of
  them add moderation.

## API

Everything except `/api/config`, signup, login and the two reset routes
requires a session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Group name, size, avatar list (public; never the invite code) |
| `POST` | `/api/auth/signup` | Join, with invite code |
| `POST` | `/api/auth/login` / `logout` | Session in, session out |
| `POST` | `/api/auth/reset/check` | Is this reset link still good, and whose is it? |
| `POST` | `/api/auth/reset` | Spend a reset link, set a password, sign in |
| `POST` | `/api/auth/change-password` | Rotate your own password (needs the current one) |
| `GET` / `PATCH` | `/api/me` | Your profile, avatar and weekly goal |
| `GET` | `/api/week?week=YYYY-MM-DD` | **The one read.** Everything the UI renders, for that week |
| `PUT` | `/api/entries` | Log or correct one of *your* days |
| `DELETE` | `/api/entries/:date` | Clear one of your days |
| `POST` / `DELETE` | `/api/cheers` | Cheer, un-cheer |
| `PATCH` | `/api/group` | Change the shared goal |

`GET /api/week` accepts any date inside a week and resolves it to that Monday.

## Layout

```
worker/
  index.js     Router, routes, validation, CSRF + security headers
  db.js        Every D1 query
  auth.js      PBKDF2 hashing, sessions, reset-token hashing
  throttle.js  Login / invite-code brute-force rate limiting
  week.js      Timezone-aware week maths (pure)
  weekview.js  Builds the payload GET /api/week returns
public/
  login.html   Sign in / join
  reset.html   Set a new password from a one-time link
  index.html   The app
  js/          api.js, track.js, app.js, login.js, reset.js
  css/
  _headers     Security headers for edge-served static files
schema.sql     D1 tables
wrangler.jsonc Worker config, bindings, vars
SECURITY.md    Threat model and the pre-deploy checklist
scripts/
  seed.mjs             Ten demo members via the HTTP API
  reset-password.mjs   Mint a one-time reset link for one member
```

Static files are served by Cloudflare's edge via the `assets` binding, which
matches them before the Worker runs — so the Worker only executes for `/api/*`.
Asset URLs are extensionless: `/login`, not `/login.html`.

## History

This started as a Node + Express server using the built-in `node:sqlite` and a
local database file, deployable to any Docker host. That version is in the git
history if you want it. It was replaced with Workers + D1 because Cloudflare's
free tier gives persistent shared storage, which the free tiers of container
hosts generally do not — Render, for instance, only offers persistent disks on
paid instances.
