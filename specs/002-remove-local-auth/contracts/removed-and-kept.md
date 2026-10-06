# Contract: what the operator API loses, and what it must keep

`api/openapi.yaml` is the contract, and `tests/openapi.test.js` asserts in both directions
that it matches the route table. Each removal below is a route deletion AND a spec deletion in
the same change; doing one without the other turns the suite red immediately, which is the
point of having it.

## Removed

| Operation | Why |
|---|---|
| `POST /admin/api/auth/login` | Accepts a username and password. This is the feature. |
| `POST /admin/api/auth/password` | Changes a password that no longer exists. |
| `POST /admin/api/auth/logout-all` | Revokes local refresh tokens. A Keycloak session has none here; cutting one is `DELETE /admin/api/users/{username}/sessions`, which stays. |

## Changed

| Operation | Change |
|---|---|
| `POST /admin/api/auth/refresh` | Keeps only the Keycloak branch. With no `aerocoreupdate_oidc` cookie it answers 401 instead of falling back to a local session. |
| `GET /admin/api/auth/me` | Drops `password_changed_at`. |

## Must keep working, unchanged

| Operation | Used by |
|---|---|
| `GET /admin/api/auth/oidc` | both admin UIs, to decide whether to offer sign-in at all |
| `GET /admin/api/auth/oidc/start` and its callback | the previous UI at `/admin/legacy.html` — still the only way to reach four operator screens |
| `POST /admin/api/auth/logout` | both; it clears whichever cookie is present |
| `POST /admin/api/auth/register`, `GET /admin/api/auth/registration` | self-service sign-up, which creates KEYCLOAK accounts |
| everything under `/api/v1` | devices; never involved in any of this |

## Behaviour relied on beyond the shapes

1. **The two refresh cookies never overlap.** `aerocoreupdate_oidc` is checked first and
   returns immediately; `aerocoreupdate_refresh` is only reached in its absence. This is why
   the previous UI survives the removal untouched.
2. **A refusal must stop naming the removed account.** The message for an account holding no
   recognised realm role currently ends "or sign in with the local break-glass account". It
   must name the missing role instead. A server that directs people to a door it has removed
   is worse than one that simply says no.
3. **Scope mapping is unchanged.** Permissions still come from realm roles on each request,
   never from a stored row — so nothing about this feature changes who may do what.
