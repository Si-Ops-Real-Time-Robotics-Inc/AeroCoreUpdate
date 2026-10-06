# Phase 0 Research: The identity provider becomes the only way in

Three assumptions carried into this feature turned out to be wrong. Each one would have caused
an outage if the removal had been done from the description alone.

## Decision 1 — The refresh endpoint splits cleanly. The previous UI is safe.

**Finding**: `POST /admin/api/auth/refresh` reads two different cookies, and they belong to
two different flows with no overlap:

| Cookie | Set by | Carries |
|---|---|---|
| `aerocoreupdate_oidc` | the server-side Keycloak callback | Keycloak's own refresh token |
| `aerocoreupdate_refresh` | local password sign-in | an opaque token stored in this database |

The handler checks `aerocoreupdate_oidc` **first** and returns immediately when it is present
(`src/controllers/auth.controller.js`, `refresh()`). The local branch is only reached when
that cookie is absent.

**Decision**: Delete the local branch and everything below it. `refresh()` becomes "refresh a
Keycloak session, or 401".

**Why this de-risks the feature**: the previous admin UI at `/admin/legacy.html` signs in
through the server-side Keycloak flow, so it holds `aerocoreupdate_oidc` and never reaches the
branch being removed. The four operator screens that still live only there keep working. This
was the risk that decided the order of work, and it turns out not to constrain the order at
all.

## Decision 2 — `admin_user` STAYS. It is not the local account's table.

**Finding**: every Keycloak sign-in writes to `admin_user`. `authenticateExternal()` calls
`repository.upsertExternalUser({ issuer, subject, username })` on each authenticated request,
and the row is what `/auth/me` returns an `id` from, what "cut this account's sessions" acts
on, and what the audit trail refers to.

Its columns divide cleanly:

| Column | Belongs to |
|---|---|
| `username`, `disabled`, `created_at`, `last_login_at` | both |
| `external_id`, `external_issuer` | Keycloak only |
| `permissions_changed_at` | Keycloak only — the timestamp `predatesCut` compares against |
| `password_hash`, `password_changed_at` | **the local account only** |

**Decision**: keep the table. Drop the two password columns, and delete rows with no
`external_id` — those are local accounts and nothing will read them again.

**What dropping the table would have cost**: `/auth/me` returns nothing, cutting a
compromised operator's sessions stops working, and the audit trail loses the subject it
names. All three for Keycloak accounts, which are the ones that remain.

## Decision 3 — Not every session table is local.

| Table | Verdict | Reason |
|---|---|---|
| `refresh_token` | **remove** | Only local sign-in writes it. A Keycloak session's refresh token lives in a cookie, never in this database. |
| `login_attempt` | **remove** | Throttles password guessing. With no password, nothing to guess. |
| `registration_attempt` | **KEEP** | Throttles the self-service sign-up form by address. That form creates KEYCLOAK accounts, not local ones, and stays. |

**What removing `registration_attempt` would have cost**: an open form that creates accounts
in a realm shared with AeroCore and aerotunnel, with its per-address ceiling gone.

## Decision 4 — The server currently tells people to use the door being removed

`authenticateExternal()` refuses an account holding no recognised realm role with a message
ending *"...or sign in with the local break-glass account."*

**Decision**: rewrite it to name the missing role and say an administrator must grant one.
Leaving it would have the server directing operators to a door that no longer exists, in
the one situation where they are already stuck.

The same wording appears in `.env.example`, `docs/c4.md` and `CLAUDE.md`; all move together
(Constitution VII).

## Decision 5 — `core/jwt.js` goes, and the fleet does not notice

**Finding**: `src/core/jwt.js` is HS256 only, and is used exclusively to sign and verify the
local access token. Keycloak tokens are EdDSA and verified in `src/core/oidc.js`, which shares
no code with it.

**Decision**: delete `src/core/jwt.js` and `tests/jwt.test.js`.

**Alternative rejected**: keeping it "in case something needs a JWT later". Constitution IV
and the cleanup rule both say the same thing — an export nobody calls is not an asset.

## Decision 6 — The contract and its tests move in the same change

`tests/openapi.test.js` asserts, in both directions, that every served route is in
`api/openapi.yaml` and that the spec describes no route that is not served. Removing routes
without removing their spec entries turns the suite red immediately.

**Decision**: treat the spec edit as part of the same task as each route deletion, not as a
follow-up. The `Me` schema also loses `password_changed_at`, which only ever described the
local account.

**This is a feature, not an obstacle**: it is the check that makes "we removed the routes"
verifiable rather than asserted.

## Decision 7 — What happens to operators signed in when this deploys

**Decision**: local sessions stop working at deployment and the sign-in screen appears. No
migration, no grace period.

**Rationale**: the spec's assumptions allow it, and the alternative — honouring existing
local tokens for a while — means keeping the verification path alive, which is the thing
being removed. A grace period for a door that is being removed is just a later removal.
