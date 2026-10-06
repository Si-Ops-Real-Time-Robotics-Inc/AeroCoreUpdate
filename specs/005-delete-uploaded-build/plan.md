# Implementation Plan: Delete an uploaded build

**Branch**: `005-delete-uploaded-build` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-delete-uploaded-build/spec.md`

## Summary

The new admin UI lost the controls for removing an uploaded build. This plan restores them on
the Catalog screen — a whole release, or one artifact — behind `catalog:delete`, with an
inline confirmation that states what goes.

The larger part is making removal unable to silently stop the fleet. Removing an artifact of a
served release is refused like removing the release itself. Both refusals become atomic: the
removal locks the release row, reads which channels serve it, and only then deletes, so no
promote can land in between. Migration `011` changes `channel_latest_fkey` from
`ON DELETE SET NULL` — which today empties a channel silently if the race is lost — to
`RESTRICT`, so the schema refuses as well. The refusal carries the serving channels as a
finding the UI branches on.

Three things found in Phase 0 are fixed on the way: the contract's phantom
`Catalog.releases[].channels` (which makes every release read "staged"), both delete
operations' undeclared responses, and one test that asserts the defect as correct behaviour.

## Technical Context

**Language/Version**: Node 22 ESM (server); TypeScript 5.6, React 18 (webui)

**Primary Dependencies**: `pg` only on the server (Constitution IV). No new dependency either side.

**Storage**: PostgreSQL, READ COMMITTED (the pool sets no isolation level). Artifact files
under `/data/artifacts`. One migration, `011_channel_latest_restrict.sql`.

**Testing**: `node --test` (server), Vitest (webui). New: `tests/delete-build.test.js`,
`tests/catalog-shape.test.js`, `webui/tests/removal.test.ts`. Changed deliberately:
`tests/upload.test.js` (one test, research Finding C). Extended: `tests/openapi.test.js`,
`webui/tests/scopes.test.ts`.

**Target Platform**: Linux container behind proxy_alpha's gateway.

**Project Type**: Web service with a generated TypeScript admin client.

**Performance Goals**: N/A. The lock is on one release row, held for a delete; promotes of
that same release wait milliseconds.

**Constraints**: CSP `style-src 'self'` — inline panels, no dialog. The previous UI
(`public/admin/app.js`) is the behavioural reference and is not modified. The node protocol
(`/api/v1`) is untouched.

**Scale/Scope**: two services, one repository, one migration, one controller untouched, the
contract, one screen and four components/modules on the webui side.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — see below.*

| Principle | Bearing | Verdict |
|---|---|---|
| **I. Identity belongs to proxy_alpha** | Untouched | N/A |
| **II. Uploading is not publishing** | Removing a build must not become a way to change what the fleet is offered; FR-004 and the lock enforce it | PASS — this feature extends II to removal |
| **III. Node protocol frozen** | No `/api/v1` change; the refusal's `error` stays in the closed enum | PASS |
| **IV. One runtime dependency** | None added | PASS |
| **V. Layering is not advisory** | The four new SQL functions live in `catalog.repository.js`; the two raw DELETEs already in `catalogAdmin.service.js` move there too — net removal of a deviation | PASS, improves |
| **VI. The contract is a file** | Five gaps closed (contracts/api-usage.md); `schema.d.ts` regenerated; a new DB-backed shape test catches declared-but-never-sent | PASS, with work |
| **VII. Done means tested, drawn and tidied** | Full suite; new `## L3.4 — Removing a build` in `docs/c4.md`; Data section records `RESTRICT` and file removal after commit; no config added | PASS, with work |
| **VIII. Comments explain why** | The lock order and why both lock and `RESTRICT` exist need comments; that reasoning is the feature | PASS |
| **IX. HTTPS only** | Untouched | N/A |

**Stated plainly**: this feature changes one existing test's expectation
(`tests/upload.test.js`, "deleting an artifact removes its file"). The test removed an artifact
of a served release and expected success — the defect, asserted. It now removes from an
unserved release; the served case is a refusal test. That is the deliberate tightening in the
spec's Assumptions, not a regression.

### Post-Design Re-check

Phase 1 introduced no violation. It sharpened two things:

- The schema change turned out to be needed for correctness, not just defence: with
  `SET NULL`, the existing release check is itself racy, and losing the race performs the exact
  silent failure the spec forbids. The migration is in scope, not optional.
- Decision 5 (swapping in `StrayBanner`) is outside the spec's scope. It stays as a separately
  labelled task so it can be dropped without touching the rest.

## Project Structure

### Documentation (this feature)

```text
specs/005-delete-uploaded-build/
├── plan.md              # This file
├── research.md          # Phase 0 — five decisions, three findings
├── data-model.md        # Phase 1 — the rule, the lock order, the migration
├── quickstart.md        # Phase 1 — how it is proven
├── contracts/
│   └── api-usage.md     # Phase 1 — five contract gaps
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── db/migrations/011_channel_latest_restrict.sql   # new — SET NULL → RESTRICT
├── repositories/catalog.repository.js              # + lockRelease, channelsServing,
│                                                    #   deleteReleaseRow, deleteArtifactRow
├── services/catalogAdmin.service.js                # deleteRelease / deleteArtifact: lock → check → delete
├── core/errors.js                                  # conflict(message, details = null)
└── controllers/admin.controller.js                 # unchanged

api/openapi.yaml                                    # five gaps
webui/src/api/schema.d.ts                           # regenerated
webui/src/lib/api.ts                                # + deleteArtifact; typed results
webui/src/lib/removal.ts                            # new — servedBy() lookup, inUse() keyed on rule
webui/src/lib/scopes.ts                             # + canRemove (catalog:delete)
webui/src/components/catalog/RemovePanel.tsx        # new — inline confirmation, both targets
webui/src/routes/Catalog.tsx                        # expandable artifacts, Remove, served badges, StrayBanner

docs/c4.md                                          # + L3.4, Data
tests/delete-build.test.js                          # new
tests/catalog-shape.test.js                         # new
tests/upload.test.js                                # one test changed deliberately
tests/openapi.test.js                               # extended
webui/tests/removal.test.ts                         # new
```

**Structure Decision**: the existing layered layout. No new module on the server; one new
pure module and one component in the webui.

## Complexity Tracking

No Constitution Check violations. Table omitted.
