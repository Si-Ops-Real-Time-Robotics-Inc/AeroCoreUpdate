# Proposal — real authorisation (splitting upload from publish)

Not implemented. This is the design; the code change is deliberately small, and the
reasoning for it is the part worth agreeing on first.

## The problem

`requireAuth` is binary. It answers *"is this a valid token?"* and nothing else, so all 36
admin routes are equally open to anyone holding one:

```js
.post('/api/artifacts',                     requireAuth(admin.uploadArtifact))
.put('/api/systems/:system/channels/:name', requireAuth(admin.putChannel))
.get('/api/fleet',                          requireAuth(admin.fleet))
```

Reading the fleet inventory and shipping firmware to every aircraft in it are the same
permission. That is why a newly created account gets `customer` and nothing else, and why
"created and immediately usable" would have meant "anyone who can be created can ship
firmware".

## The one distinction that matters

**Uploading is not publishing.** An uploaded artifact sits in the catalog and no node ever
sees it. A release reaches the fleet only when a channel is pointed at it.

The server already leans this way — `autoPromoteChannel` defaults to `beta`, so a fresh
upload lands on staging rather than at the fleet — but nothing *enforces* it, because one
permission covers both.

Splitting them means a leaked CI token can add an artifact nobody is served, instead of
moving `stable`. That single split is worth more than the rest of the model combined.

## Proposed roles

| Role | Can | Cannot |
|---|---|---|
| `customer` | Sign in. Nothing else | Everything |
| `viewer` | Read catalog, fleet, rollout, audit | Any write |
| `publisher` | `viewer` + upload artifacts, create releases, edit metadata | **Move a channel** |
| `release_manager` | `publisher` + promote, rollback, assign unplaced nodes | Users, signing keys |
| `admin` | Everything | — |

Two deliberate placements:

- **`signing_key` is not folded into `admin`.** Reading the OTA signing key and publishing
  firmware are different powers and should be separately grantable. Today
  `GET /admin/api/signing-key` sits in the same scope as `PUT /channels/:name`.
- **`customer` really is nothing.** It exists so an account can be created, and sign in,
  without that act granting anything. Do not quietly promote it to `viewer` for convenience:
  the fleet inventory is a list of every serial you own and what it is running.

## Route → scope map

| Routes | Scope |
|---|---|
| `GET /api/catalog`, `/api/fleet`, `/api/reports`, `/api/audit`, `/api/systems`, `/api/unclassified` | `catalog:read` |
| `POST /api/uploads`, `/api/uploads/:token`, `/api/artifacts`, `/api/releases`, `PATCH /api/releases/:v`, `PUT /api/artifacts/:id/metadata` | `artifact:write` |
| `PUT /api/systems/:system/channels/:name` | **`channel:write`** |
| `DELETE /api/releases/:v`, `/api/artifacts/:id` | `catalog:delete` |
| `POST /api/systems`, `PATCH`/`DELETE /api/systems/:name`, `PUT`/`DELETE /api/unclassified/:serial` | `system:write` |
| `GET`/`POST /api/users` | `user:admin` |
| `GET /api/signing-key`, `PUT /api/signing-key/certificate` | `signing_key` |

`channel:write` on its own line is the whole point.

## Implementation

Small, because the shape of the existing code already fits.

**1. Carry scopes in the token.** Keycloak emits realm roles in `realm_access.roles`.
`core/oidc.js` already returns the claims, so nothing new is fetched — map roles to scopes in
one table rather than scattering role names through the routes.

**2. `requireScope` beside `requireAuth`**, same decorator shape, because `Router.use()` only
accepts a Router ([apiKey.js:9-13](../src/middlewares/apiKey.js#L9) explains why):

```js
export function requireScope(scope, handler) {
  return requireAuth(async (req, res) => {
    if (!req.scopes?.has(scope)) throw forbidden(`requires ${scope}`);
    return handler(req, res);
  });
}
```

**3. Annotate the 36 routes.** Mechanical, and the map above is the whole input. Worth doing
in one commit so the diff *is* the permission model — reviewable in one screen.

**4. Deny by default.** A route with no scope declared should refuse, not allow. A test that
walks the router and fails on any unannotated route is what keeps that true as routes are
added.

**5. Local accounts keep everything.** The break-glass admin has no Keycloak roles to read,
so it gets the full set — that is what break-glass means.

## The catch worth knowing about

Scopes in the token mean **demoting someone does not take effect until their token expires** —
up to 15 minutes of retained privilege. For a `release_manager` revoked for cause, that is too
long.

The fix already exists in this codebase. [auth.service.js](../src/services/auth.service.js)
compares `claims.iat` against `password_changed_at` to invalidate tokens minted before a
password change. A `permissions_changed_at` column following the same pattern kills every
outstanding token for that user the moment their role changes — no blocklist, no new table,
no extra request.

## Suggested order

1. `requireScope` + the scope table + deny-by-default test — no behaviour change yet, every route mapped to `admin`
2. Move `channel:write` out of `admin`. **This is the change that matters**; everything after it is refinement
3. Split the rest per the map
4. `permissions_changed_at`
5. Separate CI service tokens with `artifact:write` only — never `channel:write`

Step 2 alone converts "a leaked token ships firmware" into "a leaked token adds a file nobody
is served".
