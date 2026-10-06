# Phase 0 Research: Uploading must not be able to ship

Three questions had to be answered before writing anything. The second one turned up a way the
fix could look correct and still leave the hole open.

## Decision 1 — The check belongs in the controller

**Decision**: refuse in `src/controllers/admin.controller.js`, in `uploadArtifact`, before the
service is called.

**Why not the validator**: `validateUploadQuery` sees the requested channel but not the caller.
A validator that had to be handed the user would stop being a validator.

**Why not the service**: `store()` in `publish.service.js` does the write, but it is also
reached by the two-step commit — the safe path, which hardcodes the staging channel. Putting
an authorisation refusal there means a service throwing 403 from inside a transaction that has
already written an artifact, and it puts a permission decision one layer below the layer that
knows who is asking. Constitution V says the check belongs where it can see what it needs to
check.

**The controller sees both**: `req.user.scopes` is populated by `requireScope`, and the parsed
channel comes back from the validator. It is the only layer that has both without being handed
something it should not have.

**Error shape**: `forbidden(...)` → HTTP 403 with `error: "invalid_api_key"`, the code the
closed enum already uses for that status (`src/core/errors.js`; the enum is closed because the
node branches on it, Constitution III).

**Contract gap found while checking this**: neither `uploadArtifact` nor
`uploadArtifactToRelease` documents the `channel` query parameter at ALL, and neither
documents 401 or 403 — they list only 201 and 413. The parameter this entire feature is about
is invisible in `api/openapi.yaml`. Constitution VI makes closing that part of the work, not a
nicety: a generated client cannot send a parameter the contract does not mention, and a reader
cannot discover the permission rule from the contract. Both operations need the `channel`
parameter, its three meanings (absent, empty, named), and 400/401/403 documented.

## Decision 2 — Anchor the rule on the STAGING channel, not on the configured default

This is the one that could have gone wrong quietly.

**The rule**: an upload may land on `config.stagingChannel` — the literal `beta` — or nowhere,
with no permission beyond the one to upload. Naming any OTHER channel requires the permission
to publish.

**Why not anchor on `config.autoPromoteChannel`**: it is configurable
(`AUTO_PROMOTE_CHANNEL`, default `beta`), and `.env.example` documents setting it to another
channel. A rule reading "no extra permission needed when the requested channel equals the
default" looks equivalent and is not: setting `AUTO_PROMOTE_CHANNEL=stable` would then let
every publisher ship to the fleet with an ordinary upload, and nothing in the code would look
wrong. The hole would reopen through configuration.

`stagingChannel` is a literal in `config/index.js`, not an environment variable. That is
exactly why the rule hangs on it.

**Reconciling FR-002 with the edge case**: "where an ordinary upload lands" means the staging
channel, because that is what the whole publish workflow is built on — an engineer uploads and
the release lands on `beta`, and an admin promotes it from there. If landing on `beta` required
the permission to publish, a publisher could not do the job the role exists for.

**Consequence worth stating**: if a deployment has set `AUTO_PROMOTE_CHANNEL` to something
other than `beta`, an upload by a publisher that would previously have landed there is now
refused. That is the defect being closed, presenting itself as a behaviour change.

**Alternative rejected**: letting an upload land nowhere when the caller may not publish,
instead of refusing. It sounds gentler and is worse — the caller asked for something specific,
got silence, and has to discover from the catalog that their build went somewhere else.

## Decision 3 — Share the rollback guard, do not route the write through the guarded path

**Decision**: extract the backward-move check into one place that both `upsertChannel` and the
upload's channel write call. Do NOT make the upload call `upsertChannel`.

**Why not route through it**: `store()` writes the artifact and moves the channel inside a
single transaction, on one `client`, and audits inside it. `upsertChannel` runs its own
queries outside that transaction. Routing through it would either split the write across two
transactions — leaving a window where the artifact exists and the channel does not know about
it — or require threading a client through a function that does not take one.

**Why sharing beats duplicating**: two implementations of "is this move backwards" is how the
careful one drifts from the other. The comparison itself is already shared
(`isNewer` in the domain layer); what is not shared is the refusal built on it, and that is
what moves.

**What the upload does on a backward move**: refuses the same way, with the same finding, so a
scripted caller handles one shape rather than two. An upload that wants it anyway sends the
same override the channel endpoint takes.

## Decision 4 — The attempt is audited, and audited as an attempt

`insertAudit` already exists and the upload path already writes audit rows inside its
transaction. A refusal happens before the transaction, so this one is written on its own.

**Decision**: record actor, the channel asked for, and that it was refused for permission.

**Why it matters more than the usual audit line**: this is a credential asking for more than it
holds. One occurrence is a misconfigured script; a pattern is something else, and neither is
visible if the request simply 403s into the void.

## Decision 5 — Both routes, one handler, one fix

`POST /admin/api/artifacts` and `POST /admin/api/releases/{version}/artifacts` share
`uploadArtifact`. One check covers both, and a test must assert both, because the second is
easy to forget precisely because it is the same code.
