# Implementation Plan: Uploading must not be able to ship

**Branch**: `004-close-publish-bypass` | **Date**: 2026-09-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-close-publish-bypass/spec.md`

## Summary

The one-shot upload lets the caller name a channel and checks only `artifact:write`, so an
account that may fill the catalog can point the fleet's channel at its own build in a single
request. The fix adds one check in the controller — the layer that can see both the caller's
scopes and the requested channel — allowing the staging channel and "nowhere" freely, and
requiring `channel:write` for anything else. The same code path also writes the channel
without the backward-move guard; the guard's refusal moves into a shared helper both paths
call.

No new permission, no schema change, no migration. Two contract gaps close on the way: neither
upload operation documents the `channel` parameter or a 403.

## Technical Context

**Language/Version**: Node 22, ESM

**Primary Dependencies**: `pg` only (Constitution IV). No new dependency.

**Storage**: PostgreSQL — `channel`, `artifact`, `release`, `audit`. No migration.

**Testing**: `node --test`, no framework. New file `tests/upload-cannot-publish.test.js`;
existing `tests/upload-lands-on-beta.test.js`, `tests/scopes.test.js`, `tests/upload.test.js`,
`tests/staged-upload.test.js`, `tests/publish-auto.test.js` and `tests/openapi.test.js` must
keep passing untouched.

**Target Platform**: Linux container behind proxy_alpha's gateway.

**Project Type**: Web service with a generated TypeScript client.

**Performance Goals**: N/A — the check is a `Set.has` on a request that is about to read a
multi-megabyte body. It happens BEFORE the body is read, which is the only performance-shaped
property that matters: a refused upload costs nothing.

**Constraints**: The refusal must land before the archive reader, since a refusal from the
reader is exactly the defect. The two-step publish must not change at all.

**Scale/Scope**: Two routes, one shared handler, one validator, one service function. Roughly
five source files and one new test file.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — see below.*

| Principle | Bearing | Verdict |
|---|---|---|
| **II. Uploading Is Not Publishing** (NON-NEGOTIABLE) | The principle this feature exists to make true. It is currently stated and not enforced. | **PASS** — this feature is the enforcement |
| **III. Node Protocol Frozen** | Nothing under `/api/v1` is touched; the error code stays inside the closed enum (`invalid_api_key` for 403) | PASS |
| **IV. One Runtime Dependency** | No package added | PASS |
| **V. Layering Is Not Advisory** | The check goes in the controller because it is the layer that can see both the caller and the requested channel — research Decision 1 records why the validator and the service are worse | PASS |
| **VI. The Contract Is a File** | Both upload operations gain the `channel` parameter and 400/401/403; `tests/openapi.test.js` already enforces both directions | PASS, with work |
| **VII. Done Means Tested, Drawn and Tidied** | Full suite run; `docs/c4.md` L3.1 stops at beta and must say who may ask for elsewhere; no config left behind | PASS, with work |
| **VIII. Comments Explain Why** | The check needs a comment saying why it reads `stagingChannel` and not `autoPromoteChannel` — that distinction is the whole reason the fix holds | PASS |
| **I, IX** | Untouched | N/A |

**One item worth stating plainly**: `config.autoPromoteChannel` survives this feature, and a
deployment that has set it to something other than `beta` will now see publisher uploads
refused where they previously succeeded. That is the defect surfacing as a behaviour change,
not a regression — recorded in research Decision 2 and called out in the spec's Assumptions.

### What implementation changed about this plan

Four things the plan did not anticipate, recorded here rather than left as drift:

1. **The rules live in `domain/`, not inline in the controller.** `mayLandOnChannel` went into
   `src/domain/scopes.js` and `rollbackFinding` into a new `src/domain/channel.js`, both pure.
   The controller still makes the decision — research Decision 1 is unchanged — but the rule it
   applies is testable without a database, so the most important line in the feature is covered
   by `npm run test:unit` rather than only when Postgres is up.

2. **The guard runs before the rename, not inside the transaction.** The plan said inside, so a
   refusal would roll the artifact insert back. In practice `store()` renames the received file
   to its final path BEFORE opening the transaction and deletes that path on failure — so an
   in-transaction refusal destroyed the staged bundle, and `commitUpload`'s explicit promise to
   keep the file for a retry was broken. A refusal that destroys the only copy of what it asks
   you to confirm is not a confirmation. Checking first, through `catalog.getChannel`, refuses
   before anything moves and keeps the SQL in the repository where Constitution V wants it.

3. **The two-step commit and the Publish screen were in scope**, as the tasks file predicted:
   `commitUpload` now accepts `allow_rollback`, and `webui/src/routes/Publish.tsx` offers the
   confirmation instead of showing a refusal it cannot act on.

4. **`Finding` had to gain `from` and `to`** in `api/openapi.yaml` — feature 003's T003, still
   open because 003 is paused. The server has always sent them; the contract never said so, and
   the Publish screen cannot state the move without them.

### Post-Design Re-check

Phase 1 produced no new violations. Two things it sharpened:

- The contract work is larger than assumed at gate time — the parameter this feature is about
  was never in `api/openapi.yaml` at all. Constitution VI makes that in scope rather than a
  follow-up.
- FR-007 needs an override the upload path can carry. `upsertChannel` takes `allow_rollback`
  in a JSON body; the upload's body is the bundle, so it arrives as a query parameter of the
  same name. This is a new parameter, but not a new right: it requires `channel:write`, which
  naming a channel already requires.

## Project Structure

### Documentation (this feature)

```text
specs/004-close-publish-bypass/
├── plan.md              # This file
├── research.md          # Phase 0 — where the check belongs, which channel anchors the rule
├── data-model.md        # Phase 1 — the decision inputs and the rule
├── quickstart.md        # Phase 1 — how the fix is proven
├── contracts/
│   └── api-usage.md     # Phase 1 — the two contract gaps
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── routes/admin.routes.js              # unchanged — the routes keep artifact:write
├── controllers/admin.controller.js     # THE CHECK — uploadArtifact, before the body is read
├── validators/admin.validator.js       # parses ?allow_rollback=; still no caller knowledge
├── services/
│   ├── publish.service.js              # store() calls the shared rollback guard
│   └── catalogAdmin.service.js         # upsertChannel calls the same shared guard
├── domain/version.js                   # isNewer — already shared, unchanged
└── core/errors.js                      # unchanged — forbidden() already exists

api/openapi.yaml                        # channel, allow_rollback, 400/401/403 on both ops
webui/src/api/schema.d.ts               # regenerated from it
docs/c4.md                              # L3.1 gains who may ask for a channel on upload
tests/upload-cannot-publish.test.js     # new
```

**Structure Decision**: The existing layered layout, unchanged. This feature adds no module —
it moves a decision to the layer that can make it, and extracts one guard so two callers share
it instead of one having it.

## Complexity Tracking

No Constitution Check violations. Table omitted.
