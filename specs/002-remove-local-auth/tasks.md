---

description: "Task list for feature 002 — the identity provider becomes the only way in"
---

# Tasks: The identity provider becomes the only way in

**Input**: Design documents from `/specs/002-remove-local-auth/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/removed-and-kept.md](./contracts/removed-and-kept.md)

**Tests**: Included. Constitution VII requires them, and the OpenAPI conformance tests do part of this feature's work automatically.

**Organization**: Grouped by user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: Which user story the task serves

## The ordering rule for this feature

**The server stops accepting passwords before the UI stops offering them.** A screen that
hides a working sign-in route has changed nothing about who can get in — it has only made the
remaining way in harder to find. Every task below that removes a form comes after the task
that removed what the form talked to.

The one thing this feature can break is the previous admin UI, which four operator screens
still live in. T001 captures proof that it works before anything changes, so the check after
the change means something.

---

## Phase 1: Setup

- [X] T001 Record a baseline: sign in to `/admin/legacy.html` through Keycloak, complete one navigation of each of its six tabs, and note the result in this file. Without a before, the after proves nothing
  - **Done 2026-09-10, automated instead of clicked.** The server-side flow was walked end to
    end: `/auth/oidc/start` → issuer form → callback (302 to `/admin/`, sets
    `aerocoreupdate_oidc`) → `/auth/refresh` trades the cookie for an access token → that
    token answers `/auth/me` (8 scopes), `/catalog`, `/systems`, `/fleet`, `/reports` and
    `/audit`. Repeatable, which a click-through is not.
  - Learned while writing it, and worth keeping: the session cookie NEVER authenticates an
    API call. It buys an access token from `/auth/refresh`, and everything after that is
    Bearer. Also, the callback answers 302, not JSON.
- [X] T002 [P] Capture the current route table for reference: `node -e "import('./src/routes/index.js').then(({apiRoutes})=>apiRoutes.routes.forEach(r=>console.log(r.method,r.pattern)))"` — the count must drop by exactly three when this feature is done

**Checkpoint**: the previous UI is known to work, and the route table before the change is known.

---

## Phase 2: Foundational

**Purpose**: None. This feature has no blocking prerequisite — Phase 0 established that the
refresh endpoint splits on two non-overlapping cookies, so nothing has to be prepared before
the removal starts. Phase 2 is empty on purpose rather than by omission.

---

## Phase 3: User Story 1 — One way in (Priority: P1)

**Goal**: The server no longer accepts a username and password, and the screens stop offering one.

**Independent test**: `POST /admin/api/auth/login` answers 404, and no sign-in screen shows a password field.

### Server first

- [X] T003 [US1] Delete the `/api/auth/login` and `/api/auth/password` route registrations from `src/routes/admin.routes.js`, AND delete their `localLogin` and `changePassword` operations from `api/openapi.yaml` in the same change — `tests/openapi.test.js` asserts both directions and fails if only one side moves
- [X] T004 [US1] Delete the `/api/auth/logout-all` route from `src/routes/admin.routes.js` and its operation from `api/openapi.yaml`. It revokes local refresh tokens only (`repository.revokeAllForUser`); cutting a Keycloak account's sessions is `DELETE /admin/api/users/{username}/sessions`, which stays
- [X] T005 [US1] Delete `login`, `changePassword` and `logoutAll` from `src/controllers/auth.controller.js`, and remove the now-unused `setRefreshCookie`/`clearRefreshCookie` helpers and the `COOKIE`/`COOKIE_PATH` constants if nothing else references them
- [X] T006 [US1] Trim `refresh` in `src/controllers/auth.controller.js` to the Keycloak branch only: keep the `aerocoreupdate_oidc` path, delete everything after it, and answer 401 when that cookie is absent. Update the `refreshSession` description in `api/openapi.yaml` to match
- [X] T007 [US1] Delete `login`, `issueTokens`, `refresh`, `logoutAll` and `changePassword` from `src/services/auth.service.js`, and delete the `jwt.verify` fallback in `authenticate()` so it returns what `authenticateExternal` gives or throws
- [X] T008 [US1] Rewrite the refusal in `authenticateExternal` (`src/services/auth.service.js`) that currently ends "or sign in with the local break-glass account". It MUST name the missing role and say an administrator grants one. A server that points at a door it has removed is worse than one that just says no
- [X] T009 [US1] Delete refresh-token and login-attempt access from `src/repositories/auth.repository.js`, keeping `upsertExternalUser`, `findExternalUser`, `cutSessions` and the registration-attempt functions — all four serve Keycloak accounts
- [X] T010 [US1] Remove `password_changed_at` from the `/auth/me` response in `src/controllers/auth.controller.js` and from the `Me` schema in `api/openapi.yaml`
- [X] T011 [US1] Update `tests/auth.test.js`: delete the local sign-in, refresh-rotation and change-password cases; keep every Keycloak case. Add one asserting that `authenticate()` refuses an unknown token without consulting any local store
- [X] T012 [P] [US1] Add a test in `tests/auth.test.js` asserting the "no recognised role" refusal names a role and does NOT mention a local or break-glass account — the message is part of the contract with a stuck operator

### Then the screens

- [X] T013 [US1] Delete the password form, the "use the break-glass account instead" link and the `?local=1` branch from `webui/src/routes/SignIn.tsx`. When the provider is configured, the organisation button is the only control
- [X] T014 [US1] Delete `localToken`, `setLocalToken` and the local halves of `accessToken` and `logout` from `webui/src/lib/auth.ts`; `accessToken()` returns the Keycloak token or null
- [X] T015 [US1] Delete `localLogin` and `changePassword` from `webui/src/lib/api.ts`, and drop `refresh` if the Shell no longer needs it after T016
- [X] T016 [US1] In `webui/src/router.tsx`, reduce the Shell's startup to the Keycloak session only: no `localToken()` check, and no refresh-on-load fallback that exists to recover a local session
- [X] T017 [US1] Remove the password form from `public/admin/login.html` and its handler from `public/admin/login.js`, keeping the Keycloak button that redirects to `/admin/api/auth/oidc/start`
- [X] T018 [P] [US1] Update `webui/tests/scopes.test.ts` and any other admin-UI test that constructs a local session, so nothing in the suite depends on a path that no longer exists

**Checkpoint**: `POST /admin/api/auth/login` is 404 and no screen offers a password.

---

## Phase 4: User Story 2 — Nothing here opens this server (Priority: P1)

**Goal**: No credential in this server's configuration, database or logs grants access to it.

**Independent test**: inspect the running configuration and the database; find nothing that could be presented to this server for operator access.

- [X] T019 [US2] Delete the admin bootstrap from `src/server.js` — the block that creates a first account and prints a generated password once — and the startup gate that requires `JWT_SECRET`
- [X] T020 [US2] Delete `jwtSecret`, `adminUsername`, `adminPassword`, `accessTtlSeconds`, `refreshTtlSeconds`, `loginMaxFailuresUser`, `loginMaxFailuresIp` and `loginWindowMinutes` from `src/config/index.js`, keeping every registration and Keycloak setting
- [X] T021 [US2] Delete `src/core/jwt.js` and `tests/jwt.test.js`. HS256 served only the local token; Keycloak tokens are EdDSA and verified in `src/core/oidc.js`, which shares no code with it
- [X] T022 [US2] Remove `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `LOGIN_MAX_FAILURES_USER`, `LOGIN_MAX_FAILURES_IP`, `LOGIN_WINDOW_MINUTES`, `ACCESS_TTL_SECONDS` and `REFRESH_TTL_SECONDS` from `docker-compose.yml` — including the `${JWT_SECRET:?...}` guard, which otherwise stops compose from starting
- [X] T023 [US2] Write `src/db/migrations/010_remove_local_auth.sql`. In this order: `DELETE FROM admin_user WHERE external_id IS NULL`, then `DROP TABLE refresh_token`, `DROP TABLE login_attempt`, then `ALTER TABLE admin_user DROP COLUMN password_hash, DROP COLUMN password_changed_at`. Do NOT touch `registration_attempt` or `admin_user`'s other columns — see [data-model.md](./data-model.md)
- [X] T024 [US2] Add a comment at the top of `010_remove_local_auth.sql` recording why `admin_user` survives: every Keycloak sign-in upserts a row into it, and `/auth/me`, session-cutting and the audit trail all depend on it
- [X] T025 [P] [US2] Add a test asserting `src/config/index.js` exposes no key whose name suggests a local credential (`jwtSecret`, `adminPassword`, …), so the settings cannot quietly return
- [X] T026 [US2] Run the migration against the running database and confirm with the SQL in [quickstart.md](./quickstart.md): no rows with `external_id IS NULL`, `refresh_token` and `login_attempt` gone, `registration_attempt` still present

**Checkpoint**: the server starts with no `JWT_SECRET`, creates no account, prints no password.

---

## Phase 5: User Story 3 — The previous admin UI keeps working (Priority: P2)

**Goal**: The four operator screens that live only in the previous UI stay reachable.

**Independent test**: sign in at `/admin/legacy.html` through Keycloak and complete a publish.

- [X] T027 [US3] Sign in at `/admin/legacy.html` through Keycloak and walk the same six tabs recorded in T001. Compare against that baseline
- [X] T028 [US3] Confirm `public/admin/app.js` still recovers correctly when unauthenticated: it redirects to `/admin/login.html`, which now offers only the Keycloak button
- [X] T029 [P] [US3] Add a test asserting `POST /admin/api/auth/refresh` still returns a session when the `aerocoreupdate_oidc` cookie is present, and 401 when it is not — this is the single behaviour the previous UI depends on

**Checkpoint**: the previous UI signs in and works exactly as at T001.

---

## Phase 6: User Story 4 — An outage says so (Priority: P3)

**Goal**: When the provider is unreachable, the screen says that, rather than failing like a broken page.

**Independent test**: make the provider unreachable and read the sign-in screen.

- [X] T030 [US4] In `webui/src/routes/SignIn.tsx`, replace the old fallback-to-password behaviour with a statement: the provider cannot be reached, sign-in is unavailable until it is, and there is no alternative on this server
- [X] T031 [P] [US4] Add a test covering the three states of the sign-in screen from `/auth/oidc`: configured and reachable, configured and unreachable, not configured at all — each must produce a different, correct message

**Checkpoint**: an outage reads as an outage.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T032 Update `docs/c4.md`: the L1 paragraph that names a local break-glass account, and the Data table row that groups `admin_user`, `refresh_token`, `login_attempt` and `registration_attempt` as "the local break-glass account and its sessions" — two of those tables are gone and the other two serve Keycloak
- [X] T033 [P] Remove the "code hiện tại CHƯA khớp" warning from `CLAUDE.md`, since after this feature it does conform, and update the identity section to describe one way in
- [X] T034 [P] Delete the six dead variables and their prose from `.env.example`, including the long `JWT_SECRET` note. Re-run the env audit so nothing documents a knob that does nothing
- [X] T035 Re-run the orphaned-export scan over `src/` and `webui/src/`, and delete what the removal left behind (Constitution IV and the cleanup rule)
- [X] T036 Run `npm test` at the repository root and `npm test` in `webui/`, and report the output as it is. The route count must be exactly three lower than T002 recorded — DONE: 554 pass / 0 fail at the root, 106 pass in webui/. The three-fewer-routes property is now enforced by `tests/no-local-credentials.test.js` ("no route accepts a username and password") plus the openapi conformance test, which is stronger than a remembered count: a count matches again if someone adds an unrelated route
- [X] T037 Walk all eleven scenarios in [quickstart.md](./quickstart.md), including scenario 9 on a container built from scratch
  - **Done 2026-09-10 against a freshly built container.** 1, 3–7, 9, 10, 11 verified by
    request; 2 verified by grepping both shipped bundles for the `?local=1` branch (zero in
    the SPA, zero in the previous UI's login.js) rather than by typing the URL; 8 (reload
    while signed in) is client-side and was exercised through the PKCE and server-side flows
    rather than in a browser.
  - Scenario 9 note: the only log line matching /password/ was `POST /admin/api/auth/password
    404` — this probe hitting the removed route, not a bootstrap message.

---

## Dependencies

```text
Phase 1 (baseline) ─▶ Phase 3 (US1, P1) ─▶ Phase 4 (US2, P1) ─▶ Phase 7 (polish)
                                    │                    ▲
                                    ├─▶ Phase 5 (US3) ───┤
                                    └─▶ Phase 6 (US4) ───┘
```

- **Phase 2 is empty.** Nothing blocks the removal; Phase 0 established why.
- **US1 before US2.** US2 deletes the secret and the tables the US1 code paths used. Doing it
  first would leave code reading a table that is gone — a broken server between two tasks
  instead of after none.
- **US3 depends on US1** only in the sense that it verifies US1 did no harm. It can start the
  moment the server-side half of US1 lands.
- **US4 is independent** of US2 and US3 once US1's screen work is done.
- T023 before T026. T032–T034 after everything they describe is true.

## Parallel execution examples

**Phase 3**: T012 and T018 are test files that no other task touches. T013–T017 are four
separate front-end files and `public/admin/login.html`; only T015 and T016 meet, in the
question of whether `api.refresh` survives.

**Phase 4**: T025 is independent of the migration work in T023/T024.

**Across stories**: once T003–T012 land, one person can take Phase 5 while another takes
Phase 6.

## Implementation strategy

**MVP = Phase 1 + Phase 3 + Phase 4.** Both are P1 and neither is meaningful alone: US1
without US2 removes the form but leaves the secret, the account and the tables — the screen
changes and the system does not. US2 without US1 deletes the machinery underneath live routes.

**Then Phase 5**, which is verification rather than construction, and the only place this
feature can do damage.

**Then Phase 6**, presentation for an outage.

**Phase 7 is not optional**: under Constitution VII a feature whose tests have not been run,
whose C4 still describes what was removed, and whose configuration still documents dead
variables is not done.

**Rollback**: `git revert` restores the code, but T023 is a one-way door — the dropped tables
and the deleted rows do not come back. Before T026, take a database dump. The local account it
contains grants nothing once the code is gone, which is the point, but a dump is how a mistake
in the migration stays a mistake rather than a loss.
