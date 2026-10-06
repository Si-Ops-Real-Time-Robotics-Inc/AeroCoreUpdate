<!--
SYNC IMPACT REPORT — amendment of 2026-09-10
Scratch material for review of this amendment; remove before committing the amended file.

Version change: 1.1.1 → 2.0.0
Rationale: MAJOR. Principle I is REDEFINED, not expanded: the local break-glass account went
from an exception that MUST be kept to one that MUST NOT exist. Anything written against the
old principle — the local sign-in route, JWT_SECRET, the admin_user and refresh_token tables —
is now non-conforming, which is exactly what a major bump is for.

Modified principles:
  - I. Identity Belongs to proxy_alpha — the break-glass exception removed

Added sections: none
Removed sections: none

Decided by the product owner on the grounds that this is a microservice and Keycloak is the
guarantee. The trade was made with the following recorded and understood:

  - The Keycloak instance relied on runs `start-dev`, which logs "DO NOT use this
    configuration in production" on every boot.
  - It configures no KC_DB and mounts no data volume, so its database is H2 inside the
    container: re-creating the container discards every runtime change.
  - One replica.
  - On 2026-09-10 it exited(1) and would not restart until a malformed realm file was fixed,
    taking platform authentication down with it.

With this principle in force, an outage of that instance means NOBODY can reach this server's
admin API — including to stop a bad rollout. That is now an accepted risk rather than an
oversight, and it is written here so a future reader finds the reasoning rather than the
absence of it.

Follow-up TODOs:
  - The code still contains the local path this principle now forbids. Removal is specified
    separately; until it lands, the repository does not conform to its own constitution.
-->

# AeroCoreUpdate Constitution

## Core Principles

### I. Identity Belongs to proxy_alpha (NON-NEGOTIABLE)

AeroCoreUpdate is a microservice of proxy_alpha, which hosts Keycloak and is the gateway in
front of it. This server MUST verify tokens issued by that realm and MUST NOT mint user
identity, keep a user store, or hold a credential that grants access to itself.

There is NO local account. A password path on this server would be a second identity system
with its own secret, its own rotation and its own way of being wrong — and a microservice
that authenticates people itself is not one. Keycloak is the guarantee; availability of
identity is proxy_alpha's problem to solve, at proxy_alpha, and not to be worked around here.

The consequence is accepted deliberately: while the realm is unreachable, this server's admin
API is unreachable too, including to stop a rollout. The answer to that is a Keycloak worth
depending on, not a spare door in this repository.

Realm role and audience names are a contract with a realm shared with AeroCore and
aerotunnel. They MUST NOT be renamed from this repository alone. Tokens MUST be signed
EdDSA: an AeroCore node built for Android has no OpenSSL and cannot verify RS256, so this
is a fleet constraint, not a preference.

### II. Uploading Is Not Publishing (NON-NEGOTIABLE)

`artifact:write` fills the catalog. `channel:write` moves a channel, and moving a channel
is the only action in this entire system that reaches an aircraft. No role but admin holds
both.

An engineer uploads and the release lands on `beta`. An admin reviews it and promotes it to
`stable`. These are two acts by two levels of authority and MUST NOT be collapsed into one,
however convenient that would be. The property this buys is concrete: a leaked publisher
credential stages a file nobody is served, instead of shipping firmware to every aircraft.

### III. The Node Protocol Is Frozen

Field names and the closed error-code enum under `/api/v1` MUST NOT change. Aircraft in the
field cannot be redeployed to match a rename, and a node that cannot parse an answer stops
updating with no way to say why.

Inside v1, fields MAY be added and MUST NOT be removed, renamed, or repurposed. Consumers
MUST ignore unknown fields. A signature covers exactly the fields it has always covered;
new keys are siblings of it and MUST NOT be folded into what is signed.

### IV. One Runtime Dependency

`pg` is the only runtime dependency. The router, JWT verification, TLS handling, the tar
reader and the HTTP layer are hand-written in `src/core/`. Adding a package requires a
reason strong enough to state out loud, and the burden is on the addition.

Tests run on `node --test` with no framework. The admin UI is the one place with a package
tree, because it mirrors proxy_alpha's front end deliberately; that exception does not
travel back into the server.

### V. Layering Is Not Advisory

The path is `routes/` → `controllers/` → `services/` → `repositories/`.

`repositories/` is the ONLY place that touches SQL. `domain/` holds pure protocol rules and
MUST NOT perform I/O. A controller that reaches past a service, or a service that writes its
own query, is a defect regardless of whether it works.

### VI. The Contract Is a File, Not an Assumption

`api/openapi.yaml` is the source of truth for both surfaces. The TypeScript client MUST be
generated from it and MUST NOT be hand-written alongside it.

This is enforced, not encouraged: tests assert that every route the server serves is
described in the spec, that the spec describes no route that is not served, that the error
enum matches what the code can emit, and that schema field names are columns the queries
actually select. A guess that agrees with nothing is exactly what those tests exist to catch.

### VII. Done Means Tested, Drawn and Tidied

A feature is not finished until three things are true.

**Tested.** The full suite has been run. Adding a feature means adding tests for it; a suite
that passes without executing the new code is not a passing suite. When tests fail, the
output MUST be reported as it is, never summarised into "a few failures".

**Drawn.** A C4 section describing the feature exists in `docs/c4.md`. Every module, route
and table named there MUST be readable out of code that actually runs. Nothing is drawn that
does not exist, and nothing deleted stays drawn.

**Tidied.** What the feature left behind is removed: configuration variables nothing reads
any more — from `.env.example`, from `docker-compose*.yml`, from the `Dockerfile` — along
with exports nobody imports and branches that serve a path no longer taken. A dead setting is
worse than clutter: it is a promise that adjusting it changes something, and the next person
spends an afternoon discovering it does not. The reverse MUST hold too — a variable the code
reads is documented, because a knob nobody knows about may as well not exist.

Four things are NOT violations of the third condition: settings that belong to the image
rather than to `.env`, shell variables local to `docker/entrypoint.sh`, incident switches
nobody has needed, and a component library mirrored from proxy_alpha for screens not yet
ported. Being unused is the intended state of an incident switch, not evidence against it;
the mirrored library is debt with a deadline, and what is still uncalled once the port
finishes is genuinely dead.

The condition covers what the FEATURE left behind, not every uncalled export in the
repository. Sweeping the whole tree and deleting by the result is the quickest way to remove
a library something is about to need.

Removing a configuration variable reaches a running deployment, so it MUST be stated —
which variable and why — never done quietly.

### VIII. Comments Explain Why

Comments MUST carry the reasoning a reader cannot recover from the code: what was tried,
what broke, what the constraint is. Restating the statement below it is noise. The
repository's existing comments are the standard, and new code MUST match their density and
voice rather than its own.

### IX. The Admin Surface Is HTTPS Only

`/admin/*` MUST refuse plaintext. `ALLOW_PLAINTEXT_HTTP` is an incident switch for a fleet
whose nodes have no TLS backend compiled in; it opens `/api/v1/*` only, it is off by
default, and it MUST NOT be described or configured as a recommended deployment.

## Deployment Constraints

This server always runs as a Docker container. Anything that must survive a rebuild lives on
a volume; configuration arrives as environment variables; no code may assume a writable path
outside `/data` or a process running on the host.

It runs behind proxy_alpha's gateway, and three consequences follow that MUST be respected:

- `PUBLIC_BASE_URL` is required, not optional. It is the address in signed manifest URLs and
  the address an OIDC redirect must match; behind a gateway the `Host` header is internal
  and unusable for either.
- The issuer in a token is the public URL while this server dials Keycloak internally, so
  `OIDC_ISSUER` and `OIDC_JWKS_URI` may legitimately differ from the derived values.
- Every request carries the gateway's address. Code MUST NOT treat the socket's peer address
  as the client's, and per-address limits MUST NOT be built on it until forwarded headers are
  read and trusted only from the gateway.

## Development Workflow

Features enter through Spec Kit: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-implement`, with artifacts under `specs/<NNN-name>/`. `/speckit-clarify` runs before
planning when the request is ambiguous, and `/speckit-analyze` after tasks.

Exempt: one-line fixes, configuration values, typos, and live incident response. Not exempt:
anything that adds a route, adds a table, changes an API contract, or touches authentication.

Skipping the chain for real work is a decision that MUST be stated in advance with its
reason. It is never a silent default.

## Governance

This constitution supersedes convenience, habit, and prior practice. Where it and a comment
in the code disagree, this document wins and the comment is a defect to fix.

**Amendments** require a written rationale naming what changed and why, and a version bump
under the policy below. A principle MUST NOT be weakened to let a specific change through;
the change is what gets reconsidered.

**Versioning** is semantic. MAJOR for removing or redefining a principle in a
backward-incompatible way. MINOR for adding a principle or materially expanding one. PATCH
for clarification and wording that changes no obligation.

**Compliance** is reviewed at the plan step: `/speckit-plan` checks a feature against this
document before tasks are generated, and a violation MUST be resolved or explicitly justified
in the plan rather than discovered in review. `CLAUDE.md` carries the same rules in working
form for day-to-day use and MUST be kept in step with this file.

**Version**: 2.0.0 | **Ratified**: 2026-09-10 | **Last Amended**: 2026-09-10
