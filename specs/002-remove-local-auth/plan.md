# Implementation Plan: The identity provider becomes the only way in

**Branch**: `002-remove-local-auth` | **Date**: 2026-09-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-remove-local-auth/spec.md`

## Summary

Remove local password authentication so Keycloak is the only way anyone signs in, making the
code conform to Constitution I as amended to 2.0.0.

The work is mostly deletion, and Phase 0 found that the deletion is smaller and differently
shaped than the description assumed: the refresh endpoint splits cleanly along two cookies, so
the previous admin UI is never touched; `admin_user` is shared with Keycloak sign-ins and
stays, losing only its two password columns; and `registration_attempt` protects a form that
has nothing to do with local accounts. Two tables go, three routes go, one message that
directs operators to the removed door gets rewritten.

## Technical Context

**Language/Version**: Node 22, ESM. TypeScript 5.6 for the admin UI.

**Primary Dependencies**: `pg` only on the server. This feature adds none and removes none —
`src/core/jwt.js` was hand-written, so deleting it removes code rather than a package.

**Storage**: PostgreSQL. One migration, `010_remove_local_auth.sql`: drop two tables, drop two
columns, delete the local rows. Order matters — see [data-model.md](./data-model.md).

**Testing**: `node --test` on the server, Vitest for the admin UI, plus the OpenAPI
conformance tests that assert the contract and the route table agree in both directions.

**Target Platform**: the same Docker container behind proxy_alpha's gateway.

**Project Type**: web service plus a single-page admin UI.

**Performance Goals**: none. Removal changes no hot path; the fleet endpoints are untouched.

**Constraints**: the previous admin UI at `/admin/legacy.html` must keep working, because four
operator screens exist only there. Deployment ends local sessions abruptly, which the spec
permits.

**Scale/Scope**: 3 routes, ~4 service functions, 1 core module, 2 tables, 2 columns, 6
configuration variables, 1 migration, and the four documents that describe the removed
account.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Pre-design | Post-design |
|---|---|---|
| I. Identity belongs to proxy_alpha (2.0.0) | **VIOLATED by the current code** — this feature is the remedy | PASS once implemented |
| II. Uploading is not publishing | PASS — untouched | PASS |
| III. Node protocol frozen | PASS — `/api/v1` untouched | PASS |
| IV. One runtime dependency | PASS — removes hand-written code, adds nothing | PASS, provided no orphaned exports remain |
| V. Layering is not advisory | PASS — the removal spans route, controller, service and repository together | PASS |
| VI. The contract is a file | ACTION — each route deletion must delete its spec entry in the same change | PASS, enforced by the conformance test |
| VII. Done means tested, drawn and tidied | ACTION — `docs/c4.md` describes the local account in two places; six variables become dead | PASS once those land |
| VIII. Comments explain why | ACTION — one refusal message names the removed account | PASS |
| IX. Admin surface is HTTPS only | PASS — untouched | PASS |

**I is the whole point, and it is currently failing.** The repository does not conform to its
own constitution between the amendment and this feature landing. That was recorded when the
amendment was made rather than discovered here.

**VI is self-enforcing.** `tests/openapi.test.js` fails the moment a route is removed from the
code but left in the spec, or the reverse. No discipline required.

**VII has a specific target**: `docs/c4.md` names the local break-glass account in its L1
section and lists `admin_user`, `refresh_token`, `login_attempt` and `registration_attempt`
together in its Data table as though they were one thing. After this feature that sentence is
false and that row is wrong.

## Project Structure

### Documentation (this feature)

```text
specs/002-remove-local-auth/
├── plan.md              # This file
├── research.md          # Phase 0: three wrong assumptions, corrected
├── data-model.md        # Phase 1: what the database keeps and loses
├── quickstart.md        # Phase 1: eleven scenarios plus SQL checks
├── contracts/
│   └── removed-and-kept.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks
```

### Source Code (repository root)

```text
api/openapi.yaml                       # delete 3 operations, amend refresh and Me

src/
├── routes/admin.routes.js             # delete 3 route registrations
├── controllers/auth.controller.js     # delete login, changePassword, logoutAll; trim refresh
├── services/auth.service.js           # delete login, issueTokens, refresh, logoutAll,
│                                      #   changePassword and the jwt.verify fallback;
│                                      #   rewrite the "no recognised role" message
├── repositories/auth.repository.js    # delete refresh-token and login-attempt access
├── core/jwt.js                        # DELETE — HS256 served only the local token
├── config/index.js                    # delete jwtSecret, admin credentials, login throttling
├── server.js                          # delete the admin bootstrap and the JWT_SECRET gate
└── db/migrations/010_remove_local_auth.sql   # NEW

tests/
├── jwt.test.js                        # DELETE with core/jwt.js
├── auth.test.js                       # local sign-in cases go; Keycloak cases stay
└── openapi.test.js                    # unchanged; it enforces the contract edits

webui/src/
├── routes/SignIn.tsx                  # delete the password form, the link and ?local=1
├── lib/auth.ts                        # delete localToken/setLocalToken and the local halves
├── lib/api.ts                         # delete localLogin and changePassword
└── router.tsx                         # the Shell's refresh-on-load keeps only the Keycloak case

public/admin/login.html                # previous UI: password form out, Keycloak button stays

docs/c4.md                             # L1 sentence and the Data table
CLAUDE.md                              # remove the "code does not yet conform" warning
.env.example                           # delete six variables and their prose
```

## Complexity Tracking

> Filled here for the opposite reason to usual: these are places the feature deliberately
> removes LESS than it looks like it should, and each needs a reason on record.

| Kept | Why it survives | What removing it would cost |
|------|-----------------|-----------------------------|
| `admin_user` table | Every Keycloak sign-in upserts a row here; it is what `/auth/me` returns an id from and what cutting an account's sessions acts on | `/auth/me` breaks, cutting a compromised operator's sessions stops working, and the audit trail loses its subject |
| `registration_attempt` table | Throttles the self-service sign-up form by address; that form creates Keycloak accounts, not local ones | An open form that creates accounts in a realm shared with two other products, with no ceiling |
| `POST /auth/refresh` | Still serves Keycloak sessions through the `aerocoreupdate_oidc` cookie | The previous admin UI cannot hold a session, taking four operator screens offline |
| `permissions_changed_at` column | The timestamp behind "cut this account's sessions", which applies to Keycloak accounts | A demoted account keeps working until its token expires on its own |
