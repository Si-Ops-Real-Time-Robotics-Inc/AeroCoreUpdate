# Quickstart: validating that there is one way in

## Prerequisites

- The stack is up, and the realm reachable.
- Accounts: one with `aeroserver-admin`, one with `aeroserver-publisher`, one with no
  operator role at all.

## Scenarios

| # | Do this | Expect |
|---|---|---|
| 1 | Open `/admin/` | Only the organisation sign-in is offered — no username or password field |
| 2 | Open `/admin/?local=1` | Same screen. The escape hatch is gone, not merely hidden |
| 3 | Sign in as the admin account | Reaches the UI with the same scopes as before |
| 4 | Sign in on `/admin/legacy.html` | Works; all its screens usable, and a publish completes |
| 5 | Sign in as the account with no operator role | Refused, told which role is missing, and **not** told to use a local account |
| 6 | `POST /admin/api/auth/login` by hand | 404 |
| 7 | `POST /admin/api/auth/refresh` with no cookies | 401 |
| 8 | Reload while signed in through Keycloak | Still signed in — the Keycloak cookie path is untouched |
| 9 | Check the boot log of a fresh deployment | No account created, no password printed |
| 10 | Inspect the running configuration | No secret that grants access to this server |
| 11 | `GET /api/v1/update/check` as a device | Unchanged |

## Database checks

```sql
select count(*) from admin_user where external_id is null;   -- 0
select to_regclass('refresh_token'), to_regclass('login_attempt');  -- both null
select to_regclass('registration_attempt');  -- NOT null: still needed
```

## Automated

```bash
npm test                 # server, including OpenAPI conformance in both directions
cd webui && npm test     # the admin UI's own suite
cd webui && npm run typecheck
```

## Done when

Scenarios 1–11 pass, both suites are green, `docs/c4.md` no longer describes a local account,
and no configuration variable documented anywhere refers to one.
