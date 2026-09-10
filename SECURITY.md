# Security

Step Race is a private app for ten named people, deployed to a public URL. That
combination is the whole threat model: there is no perimeter, no VPN and no SSO
in front of it, so every control has to live in the app itself.

This document is what to check before you send anyone the link, what the app
defends against, and — just as important — what it does not.

---

## Before you deploy

Six things. Skipping the first one publishes your group.

```bash
# 1. Set the invite code. Without it, signup is closed (503) by design.
npx wrangler secret put INVITE_CODE

# 2. Create the tables — including auth_throttle (rate limiting) and
#    password_resets. Idempotent, so run it again on an existing deployment.
npm run db:init:remote

# 3. Deploy.
npm run deploy

# 4. Confirm the security headers actually arrived.
curl -sSI https://<your-worker>.workers.dev/login | grep -i content-security-policy

# 5. Confirm signup is not open to a code from this public repo.
curl -s -X POST https://<your-worker>.workers.dev/api/auth/signup \
  -H 'content-type: application/json' -H 'origin: https://<your-worker>.workers.dev' \
  -d '{"email":"t@example.com","name":"Test","password":"a-long-enough-one","inviteCode":"STEP2026"}'
# expect: {"error":"That invite code is not right."}   NOT a 201.

# 6. Check the build tooling.
npm run audit
```

Step 4 matters more than it looks. Cloudflare serves `public/` from its edge
without invoking the Worker, so the page headers come from `public/_headers`,
not from any code. If that file is ever ignored, the pages lose their CSP
silently — the app keeps working and looks fine. Only the `curl` tells you.

**Never run `npm run seed` against your real deployment.** It creates ten
accounts sharing one password and fills every place in the group. It refuses
non-local addresses unless forced with `--allow-remote`, which exists so that
using it is a decision rather than a typo.

---

## What defends what

| Threat | Control | Where |
| --- | --- | --- |
| Stranger joins the group | Invite code, required, no production fallback | `worker/index.js` `handleSignup` |
| Invite code guessed | Constant-time compare, rate limited per IP | `auth.js` `secretsMatch`, `throttle.js` |
| Member's password guessed | PBKDF2-SHA256, per-account + per-IP lockout | `auth.js`, `throttle.js` |
| Password database stolen | Per-user random salt, cost stored per hash | `auth.js` `hashPassword` |
| Session cookie stolen by script | `HttpOnly`, and a CSP with no inline script | `auth.js`, `public/_headers` |
| Session cookie overwritten by a sibling subdomain | `__Host-` cookie prefix over HTTPS | `auth.js` |
| Another site making writes as a logged-in member | `SameSite=Strict` **and** an `Origin` check | `auth.js`, `index.js` `originAllowed` |
| A member editing someone else's steps | The row is keyed on the session user id — not expressible | `index.js` `handlePutEntry` |
| A member reading others' email addresses | `listUsers` does not select the column | `db.js` `MEMBER_COLS` |
| Injected HTML in a name or group name | `escapeHtml` at every `innerHTML`, `textContent` elsewhere, plus CSP | `public/js/app.js` |
| A shared cache serving one member's view to another | `Cache-Control: private, no-store` on every API response | `index.js` `harden` |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | both header sets |
| Member enumeration by response | One message for both wrong-email and wrong-password | `index.js` `handleLogin` |
| Member enumeration by stopwatch | Decoy hash uses the *configured* cost, not a hardcoded one | `index.js` `handleLogin` |
| A stolen session being made permanent | Changing a password needs the current one, and drops every session | `index.js` `handleChangePassword` |
| A leaked database yielding live reset links | Only the SHA-256 of a reset token is stored | `auth.js` `hashToken` |
| A reset link replayed | Single use, enforced by the `UPDATE`'s own `WHERE`, not a read-then-write | `db.js` `consumePasswordReset` |
| A reset link in a log or Referer header | The token rides in the URL fragment, which browsers never send | `public/js/reset.js` |
| Eleventh member slipping in during a race | The size limit is inside the `INSERT`, not a separate check | `db.js` `createUser` |

### Rate limiting, specifically

Failures are counted against two keys at once — the source IP
(`CF-Connecting-IP`, which Cloudflare sets at the edge and a client cannot
spoof) and the target email. Either key tripping locks the attempt, so neither
one distributed guess at a single account nor one IP walking the member list
gets through.

| Failures in 15 min | Lockout |
| --- | --- |
| 5 | 1 minute |
| 10 | 5 minutes |
| 15 | 30 minutes |

The check runs *before* the password is verified, so a locked-out attacker
cannot even spend our CPU on a key derivation. A correct password clears the
counter, so one typo never compounds. Counters live in D1 rather than in memory
because a Worker isolate is discarded between requests — an in-memory counter
would reset constantly and see only a fraction of the traffic.

---

## Accepted risks

These are known, deliberate, and worth re-reading if the group ever grows.

**PBKDF2 at 25,000 iterations is below the OWASP recommendation of 600,000.**
The Workers free plan allows 10ms of CPU per request and PBKDF2 is pure CPU;
600,000 iterations takes roughly 75ms, so login would be killed outright. Rate
limiting is what makes the lower cost survivable: an attacker gets fifteen
guesses in fifteen minutes, not millions. **On the Workers paid plan, set
`PBKDF2_ITERATIONS` to `600000` in `wrangler.jsonc` and redeploy.** The cost is
stored inside each hash, so existing accounts keep verifying at their old cost
and only new passwords use the new one — there is no migration.

**Any member can rename the group and change the shared goal**, and nothing
records who did. This is the design: ten people who know each other do not need
an admin role. It stops being right the moment the group is not ten people who
know each other.

**Signup reveals whether an email is already a member** — a duplicate returns
"Someone has already signed up with that email." Login is careful not to leak
this; signup deliberately does, because the alternative is a confusing dead end
for a real person. It is gated behind knowing the invite code.

**`style-src` allows `'unsafe-inline'`.** The rendered markup sets progress-bar
widths with `style="width: N%"` attributes. Script injection — the part that
matters — is blocked: `script-src 'self'` with no inline escape hatch.

**Password recovery goes through you, not through email.** A signed-in member
can rotate their own password from the profile dialog. A locked-out one cannot
do anything without you: there is no mail provider here, so you mint them a
link with `npm run reset-password` and send it over a channel you trust. See
**Resetting a password** below.

The residual risk is that whoever can run `wrangler` against the production
database can mint a link for anybody and take their account. That is already
true of anyone with that access — they can rewrite the `users` table directly —
so the reset script grants no new power. It does make it easy, which is worth
knowing: guard the Cloudflare account like the admin credential it is.

**Sessions last 30 days with no idle timeout.** Reasonable for a step tracker
people open once a day, and the cookie is `HttpOnly` + `SameSite=Strict`. Not
reasonable for anything holding data that matters more than step counts.

**Build tooling has known CVEs.** `npm audit` reports advisories in `sharp`, via
`miniflare`, via `wrangler`. None of it ships: the Worker has **zero runtime
dependencies**, and `npm audit --omit=dev` (`npm run audit`) reports clean. Worth
tracking, not worth an emergency.

---

## Resetting a password

```bash
npm run reset-password -- --email ben@example.com \
    --remote --base https://<your-worker>.workers.dev
```

That prints a one-time link. Send it over a channel you trust — Signal,
WhatsApp, in person. What it does:

- **Expires in an hour** (`--minutes` to change it, 5 to 1440).
- **Works once.** Single use is enforced by the `UPDATE`'s own `WHERE` clause,
  so two requests carrying the same token race and exactly one wins.
- **Kills every other outstanding link** for that person the moment it is
  minted, and again when it is used. Only one is ever live.
- **Signs them out everywhere** when used, then signs them in on the device
  that used it.
- **Clears their login lockout**, since they almost certainly tripped it on the
  way to asking you.

Only the SHA-256 of the token is stored. Your terminal is the only place the
link exists, so if you lose it, run the command again — that also invalidates
the one you lost.

A weak new password is rejected *before* the link is spent, so someone who
picks badly gets another try rather than having to come back to you.

## If an account is compromised

There is no admin UI, so this is done with `wrangler`:

```bash
# Sign one member out everywhere (find their id in the users table first).
npx wrangler d1 execute step-race --remote \
  --command "DELETE FROM sessions WHERE user_id = <id>;"

# Sign everyone out.
npx wrangler d1 execute step-race --remote --command "DELETE FROM sessions;"

# Force one person onto a new password (also drops all their sessions).
npm run reset-password -- --email them@example.com \
    --remote --base https://<your-worker>.workers.dev

# Change the invite code, then tell the group the new one.
npx wrangler secret put INVITE_CODE
```

Rotating `INVITE_CODE` does not affect anyone already signed up; it only closes
the door behind them.

---

## Reporting

It is ten people and a step counter. Tell whoever set the group up.
