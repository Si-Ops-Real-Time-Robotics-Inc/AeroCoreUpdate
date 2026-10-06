# Phase 1 Data Model: what the database keeps and what it loses

A single migration, `src/db/migrations/010_remove_local_auth.sql`, following 009.

## Kept, with columns removed

### `admin_user`

Stays. It is the row every signed-in operator has, Keycloak accounts included — see
[research.md](./research.md), Decision 2.

| Column | Action | Why |
|---|---|---|
| `id`, `username`, `disabled`, `created_at`, `last_login_at` | keep | written on every Keycloak sign-in |
| `external_id`, `external_issuer` | keep | how a Keycloak subject maps to this row |
| `permissions_changed_at` | keep | what "cut this account's sessions" sets and `predatesCut` compares |
| `password_hash` | **DROP** | there is no password |
| `password_changed_at` | **DROP** | ditto, and it leaks into `/auth/me` today |

Rows where `external_id IS NULL` are local accounts and are deleted. After the migration
every row in this table corresponds to a Keycloak subject.

**Order matters**: delete the rows before dropping the columns, so a row that exists only
because of a password is not left behind with the reason for it gone.

## Removed entirely

| Table | Why it can go |
|---|---|
| `refresh_token` | Only local sign-in ever wrote it. A Keycloak session's refresh token lives in a browser cookie, never here. |
| `login_attempt` | Existed to slow down password guessing. |

## Explicitly kept, despite looking like part of this

| Table | Why it stays |
|---|---|
| `registration_attempt` | Throttles the self-service sign-up form by source address. That form creates accounts in the shared Keycloak realm, not here, and is unaffected by this feature. Removing it would leave an open form with no ceiling. |
| `audit` | Records who did what, including sign-ins. Its subject is a username, which still exists. |

## Response shapes that change

### `Me` (`GET /admin/api/auth/me`)

`password_changed_at` is removed from the response and from the schema in
`api/openapi.yaml`. It described a local password and would be `null` forever otherwise.

Everything else — `id`, `username`, `last_login_at`, `scopes` — is unchanged, because all of
it is filled in for a Keycloak account.

## What is NOT a migration concern

Backups taken before this change still contain the dropped tables and the password column. That
is harmless by design: nothing reads them after this feature, so restoring an old backup
restores data that grants nothing. This is stated because "restore an old backup" is the one
path by which a removed credential could otherwise come back to life.
