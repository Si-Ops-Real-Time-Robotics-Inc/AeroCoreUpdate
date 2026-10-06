# Phase 1 Data Model: Uploading must not be able to ship

No table changes and no migration. This feature adds one decision and one audit row; the
entities below are the ones the decision reads.

## Decision inputs

### Caller (`req.user`, set by `requireAuth`)

| Field | Type | Where from | Used for |
|---|---|---|---|
| `username` | string | token `preferred_username` | the audit row's actor |
| `scopes` | `Set<string>` | `scopesForRoles(realm roles)` | holds `channel:write` or not |

`requireScope(SCOPE.ARTIFACT_WRITE, …)` has already run, so `artifact:write` is present on
every request that reaches the check. The second scope is read, not required by the router —
because failing to hold it is not a refusal by itself, only a refusal to name a channel.

### Requested channel (`validateUploadQuery(req.query).channel`)

Three states, and the rule treats them differently:

| `?channel=` | Parsed value | Meaning | Needs `channel:write`? |
|---|---|---|---|
| absent | `config.autoPromoteChannel` (default `'beta'`) | the automatic target | only if that value is not the staging channel |
| `` (empty) | `null` | land nowhere | no — nothing is served to anybody |
| a name | the validated name | land there | unless it equals `config.stagingChannel` |

`validateChannelName` already rejects a malformed name, so the value reaching the check is
either `null` or a syntactically valid name. Whether that channel EXISTS is not checked here
(edge case: refused for not existing, not for permission — and `store()` creates it, which is
what makes a first upload land somewhere at all).

### Configuration read

| Key | Value | Kind |
|---|---|---|
| `config.stagingChannel` | `'beta'` | literal in `src/config/index.js` |
| `config.autoPromoteChannel` | `AUTO_PROMOTE_CHANNEL` env, default `'beta'` | environment |

The rule reads `stagingChannel`. See research Decision 2 — reading `autoPromoteChannel` would
let a config change reopen the hole.

## The rule

```
may land on the requested channel  ⟺  requested is null
                                   ∨  requested === config.stagingChannel
                                   ∨  caller.scopes.has('channel:write')
```

Everything else is refused, before any byte of the body is read.

## Audit row (existing table, new action)

`insertAudit({actor, action, subject, detail})` — `audit` table, no schema change.

| Field | Value |
|---|---|
| `actor` | the caller's username |
| `action` | `channel.denied` |
| `subject` | the channel asked for |
| `detail` | `{ requested: <channel>, missing: 'channel:write', route: 'upload' }` |

Written outside any transaction, because the refusal happens before the upload's transaction
exists. It is the one audit row in this system recording something that did NOT happen, which
is why the action name says `denied` rather than reusing `channel.update`.

## Rollback finding (existing shape, second producer)

Already emitted by `upsertChannel` as an `invalidBundle` finding:

```json
{ "rule": "channel_rollback", "message": "…", "from": "0.13.5", "to": "0.13.4" }
```

After this feature the upload path produces the identical shape from the same code. `from` and
`to` are declared on `Finding` in the contract as of feature 003 — no contract change needed
here, which is the payoff for having declared them.

## State transitions

`channel.latest` is the only mutable state involved, and the point of the feature is which
principals may cause the transition:

```
channel.latest = A ──upload naming this channel──▶ latest = B
                   requires channel:write, unless the channel is beta
                   requires allow_rollback when B is older than A   ← new on this path
```
