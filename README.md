# MemberFrame API

Node, Express, Prisma, MySQL. Serves the Framer plugin panel and the canvas
components running on creators' published sites.

Specified in [`docs/memberframe-backend-prd.md`](../docs/memberframe-backend-prd.md).
That document is authoritative; this file is how to run what it describes.

---

## Quick Start

```bash
cd backend
npm install
cp .env.example .env            # then edit DATABASE_URL
```

Create the database. Prisma creates tables, not the schema itself:

```bash
mysql -u root -e "CREATE DATABASE memberframe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
```

Then:

```bash
npm run db:check                # can it connect, and is the server new enough
npm run db:migrate              # create the tables
npm run db:seed                 # one demo site, prints the site key you need
npm run dev                     # http://127.0.0.1:4000
```

`db:seed` prints a site key. Every member request needs it as a header:

```bash
curl -i http://127.0.0.1:4000/api/member/session \
  -H "X-MemberFrame-Site: mf_site_..."
```

A 401 carrying the tier ladder is the correct answer for a visitor who is not
signed in. It is not an error.

---

## Connecting To MySQL

One setting, `DATABASE_URL` in `.env`. Prisma reads it and nothing else.

```
mysql://USER:PASSWORD@HOST:PORT/DATABASE
```

Laragon's defaults, with an empty password written as nothing between the colon
and the at sign:

```
DATABASE_URL="mysql://root:@127.0.0.1:3306/memberframe"
```

Four things that cost an hour each if you get them wrong:

| Symptom | Cause |
| :--- | :--- |
| `ECONNREFUSED` on Windows with the server clearly running | `localhost` resolved to IPv6 `::1` while MySQL listens on IPv4. Use `127.0.0.1` |
| `Access denied` with the right password | The password contains `@ : / ? #` or `%` and needs percent-encoding, or the URL splits in the wrong place |
| `Unknown database` | Prisma migrates tables, it does not create the schema. Run the `CREATE DATABASE` above |
| Everything connects, then a member's name with an emoji is rejected | The database was created without `utf8mb4`. `npm run db:check` warns about this |

`npm run db:check` reports all of these, plus whether the server is MySQL 8
rather than MariaDB, and whether the hand-written migration has been applied.

### Requirements

**MySQL 8.0.13 or newer. MariaDB will not work.** Two reasons, both in
[`prisma/migrations/20261012000001_mysql_specifics/migration.sql`](prisma/migrations/20261012000001_mysql_specifics/migration.sql):
the `utf8mb4_0900_as_ci` collation does not exist in MariaDB, and the generated
`active_email` column needs 8.0.13.

---

## Layout

```
backend/
  prisma/
    schema.prisma            models. Read this first
    migrations/              generated, plus one hand-written
  scripts/
    dbCheck.ts               npm run db:check
    seed.ts                  npm run db:seed
  src/
    server.ts                entry. The only file that binds a port
    app.ts                   Express assembly, importable by a test
    config/
      env.ts                 typed config. The only place process.env is read
      db.ts                  Prisma client and the connection check
    lib/
      entitlement.ts         isEntitled. THE THIRD COPY, see below
      credentials.ts         password policy. THE THIRD COPY
      password.ts            scrypt hashing, timing-safe comparison
      tokens.ts              opaque tokens, OTP codes, hashing
      cookies.ts             the session cookie. Read before changing
      mailer.ts              log and smtp drivers, plus the templates
    middleware/
      errors.ts              the five-case contract the frontend switches on
      site.ts                tenant resolution and per-site CORS
      rateLimit.ts           per address and per IP
    routes/
      member.ts              the member runtime endpoints
    services/
      memberAuthService.ts   register, sign in, forgot, reset
      sessionService.ts      issue, read, revoke
    validation/
      schemas.ts             zod request shapes
  test/                      pure logic. No database
```

### Why some logic is in `services/` rather than in the routes

The routes validate, call one service function, set a cookie, and answer. Every
decision that could be wrong lives in `services/` or `lib/`, where it can be
read without Express in the way and tested without a request.

---

## The Three Copies

`lib/entitlement.ts` and `lib/credentials.ts` are **verbatim copies** of code in
the frontend package. That is not an accident and not technical debt to clean
up later.

PRD section 11.3 requires `isEntitled` to be implemented identically in the
plugin, the canvas components, and the backend, and says divergence between the
three is a security defect. The canvas component is compiled by Framer alone on
a creator's published site and can import nothing from this repository, so one
copy is forced by the architecture. Given one, a second is not worse in kind.

`test/parity.test.ts` reads the frontend's source across the directory boundary
and fails the build if any copy drifts. **Until this package existed, the
backend copy was the one with nothing watching it**, and it is the copy that
actually decides whether a real member gets in: the other two run in a browser
where their verdict is advisory.

If you change a rule in one, change it in all three. The test will tell you.

---

## The Endpoints

All under `/api/member`, all requiring `X-MemberFrame-Site`, all CORS-checked
against that site's own origin allowlist.

| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/session` | 401 when signed out, which is ordinary, not an error |
| POST | `/register` | 400 `email_already_exists`. See conflict C16 |
| POST | `/login-password` | 401 `invalid_credentials` for every refusal |
| POST | `/forgot-password` | Always 200, registered or not |
| POST | `/reset-password` | Revokes every other session |
| POST | `/logout` | 200 whether or not a session was found |
| POST | `/logout-everywhere` | Not in any plan. Two lines, and a member who suspects someone else is signed in has no other way to act |

Health, with no site key needed: `GET /health` and `GET /health/db`.

Not built: OTP send and verify answer **501** rather than 404, because
`<MemberAuth>` ships with that path enabled and a 404 reads as "broken" where
501 reads as "not yet". Checkout is the same.

### What the responses must be, and why

The frontend's API client is a five-arm union mapping PRD section 10.6. The
status codes here are the other half of that contract:

| Status | Client arm | Client behaviour |
| :--- | :--- | :--- |
| 2xx | `ok` | proceed |
| 401 | `unauthorized` | treat as signed out, show the locked state |
| 403 | `forbidden` | signed in, not entitled |
| 429 | `rate_limited` | show the wait, never retry |
| anything else | `unavailable` | fail closed |

**The trap: returning 400 for a bad password.** The client has no
`bad_request` arm, so a 400 lands in `unavailable`, and a visitor who mistyped
their password sees "something went wrong" instead of a sign-in error. 400 is
for a malformed request. A refused credential is 401.

---

## Email

`MAIL_DRIVER=log` is the default. Nothing is sent: the message is written to
`storage/mail/` and printed, and recorded in `email_logs`. Run the reset flow,
open the newest file, click the link. No SMTP account needed.

Switch to `MAIL_DRIVER=smtp` when the flows work. Use Mailtrap or Mailpit in
development, so a bug in the reset flow cannot email a stranger.

`email_logs` stores the recipient and the subject, **never the body**. A reset
link sitting in a database row is a reset link any operator can use.

---

## Testing

```bash
npm test
npx tsc --noEmit
```

67 tests, none of which touch MySQL. They cover the hashing, the token
handling, the rate-limit arithmetic, the origin matching, and the three-way
parity above.

**There are no integration tests yet.** Everything involving the database is
unverified, which includes every route in `routes/member.ts`. That needs a
disposable schema and a migration run per suite, and it is a separate decision
with a separate cost. Until then, the endpoints have been typechecked and
reasoned about, not exercised.

---

## Before A Published Framer Site Can Use This

Four things, in order. The third is the one people miss.

1. **Serve over HTTPS.** A session cookie for a cross-site request needs
   `Secure`, and `Secure` needs TLS. Locally that means a tunnel: Cloudflare
   Tunnel or ngrok.
2. **Set `SESSION_COOKIE_CROSS_SITE=true`** and `API_BASE_URL` to the tunnel
   hostname.
3. **Add the Framer site's origin to that site's `allowed_origins`.** Nothing
   can guess it and a wildcard is not accepted. Edit the row, or add it to
   `scripts/seed.ts`.
4. **Redeploy the component from the Builder tab.** The API base URL is baked
   into the generated file at deploy time, so changing `src/config/backend.ts`
   is not enough. This is the step that catches people.

Then read [backend PRD section 4.1](../docs/memberframe-backend-prd.md) before
you interpret the result. Safari blocks third-party cookies by default, so a
failure there is expected rather than a bug in your setup, and which mitigation
you need is exactly what that spike exists to decide.

---

## Known Deviations

Recorded as conflicts in [`docs/IMPLEMENTATION-STATUS.md`](../docs/IMPLEMENTATION-STATUS.md)
rather than decided quietly.

| # | What |
| :--- | :--- |
| C15 | Argon2id over bcrypt, which truncates at 72 bytes |
| C16 | `register` reveals that an address exists. FP-02 asks for it |
| C17 | Site key plus origin, rather than a `siteId` in the body |
| C18 | The reset page must exist on the creator's site and nothing tells them |
| C23 | **scrypt rather than Argon2id.** `lib/password.ts` explains why, and the algorithm tag in every stored hash makes the upgrade a one-file change |
