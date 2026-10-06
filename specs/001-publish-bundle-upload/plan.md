# Implementation Plan: Publish a firmware bundle from the new admin UI

**Branch**: `001-publish-bundle-upload` | **Date**: 2026-09-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-publish-bundle-upload/spec.md`

## Summary

Restore the ability to publish a firmware release from the new admin UI, which currently
ships a stub for it — so the container cannot do the job the server exists for.

The approach ports the previous screen rather than redesigning it: stage with a browser-side
integrity hash and a real progress indication, present what the server found, then confirm or
discard. Confirming lands the release on `beta` and cannot do anything else. Two supporting
pieces come with it, both required by the constitution rather than by the feature: the
OpenAPI schemas this screen renders get tightened so its types stay generated, and the admin
UI gets a test runner it does not yet have.

## Technical Context

**Language/Version**: TypeScript 5.6 on Node 22 (build); ES2022 in the browser

**Primary Dependencies**: React 18, Vite 5, TanStack Router + Query, Tailwind v4, Radix
primitives — the set proxy_alpha's web UI already uses. This feature adds no runtime package.

**Storage**: None client-side. The staged token lives in component state and is deliberately
not persisted: a token that outlives the tab is a half-finished publish nobody remembers
starting.

**Testing**: `node --test` for the server (unchanged); Vitest, added here, for the admin UI's
pure logic. Manual walkthrough in [quickstart.md](./quickstart.md) for the upload path.

**Target Platform**: Desktop browsers, served over HTTPS from this server's own static
middleware at `/admin/`, built inside the Docker image.

**Project Type**: Web application — an existing single-page admin UI plus an unchanged
Node server.

**Performance Goals**: Progress must update visibly during transfer. No throughput target:
the limit is the operator's link, and the server already caps the bundle at
`UPLOAD_MAX_BYTES`.

**Constraints**: `crypto.subtle` needs a secure context — satisfied, the admin surface is
HTTPS only. Hashing holds the whole file in memory, up to the 512 MB default cap (see
[research.md](./research.md), Decision 2). The `/admin/*` Content-Security-Policy has
`style-src 'self'` with no `'unsafe-inline'`, which rules out components that set inline
style attributes (Decision 3).

**Scale/Scope**: One screen, one upload path, four server operations. Roughly the 200 lines
of `public/admin/app.js` that the previous Publish tab occupies, plus its rendering helpers.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Pre-design | Post-design |
|---|---|---|
| I. Identity belongs to proxy_alpha | PASS — spends the existing token, mints nothing | PASS |
| II. Uploading is not publishing | PASS — see below | PASS |
| III. Node protocol frozen | PASS — `/api/v1` untouched | PASS |
| IV. One runtime dependency | ACTION — adds a test runner | PASS, justified below |
| V. Layering is not advisory | N/A server-side; front end keeps transport in `lib/` and screens in `routes/` | PASS |
| VI. The contract is a file | **FAIL** — see below | PASS once the two tasks land |
| VII. Done means tested and drawn | **FAIL** — see below | PASS once the two tasks land |
| VIII. Comments explain why | PASS by convention | PASS |
| IX. Admin surface is HTTPS only | PASS — unchanged | PASS |

**II is satisfied mechanically, not by discipline.** Confirming an upload calls an operation
that takes no channel argument, so the screen has nowhere to ask for `stable` even if it
wanted to. This plan adds no call to the channel endpoint, and the tasks must not introduce
one. An admin using this screen holds `channel:write` — the guarantee is that this screen
gives them no way to spend it.

**VI fails today and the failure is already in the tree.** Two problems:

1. `webui/src/lib/api.ts` declares `discardUpload` as `DELETE /admin/api/uploads/{token}`.
   That route does not exist — uploads has exactly two routes, both POST. The declaration was
   hand-written rather than generated, which is the precise thing VI forbids.
2. `StagedUpload.inspection` and `Diff` are `additionalProperties: true` in
   `api/openapi.yaml`. This screen renders their internals, so leaving them open means typing
   them by hand under another name.

Both are tasks in this feature, not follow-ups.

**VII fails today.** `webui/` has no test runner at all, and `docs/c4.md` does not exist —
it was deleted and deliberately not restored, so this feature is the one that rebuilds the
document and adds the publishing section. Neither is optional under VII.

## Project Structure

### Documentation (this feature)

```text
specs/001-publish-bundle-upload/
├── plan.md              # This file
├── research.md          # Phase 0: transport, hashing, modal-vs-panel, types, testing
├── data-model.md        # Phase 1: received shapes + the screen's state machine
├── quickstart.md        # Phase 1: how to validate, ten scenarios
├── contracts/
│   └── api-usage.md     # Phase 1: operations used, and what is relied on beyond shapes
├── checklists/
│   └── requirements.md  # Spec quality checklist + the clarification record
└── tasks.md             # Phase 2 — created by /speckit-tasks, not by this command
```

### Source Code (repository root)

```text
api/
└── openapi.yaml                    # tighten Inspection and Diff schemas

src/                                # server — unchanged by this feature
└── routes/admin.routes.js          # read only, to confirm what exists

webui/
├── package.json                    # + vitest (devDependency)
├── src/
│   ├── api/schema.d.ts             # regenerated from api/openapi.yaml
│   ├── lib/
│   │   ├── api.ts                  # remove the invented discardUpload
│   │   ├── upload.ts               # NEW — XHR upload with progress, shares auth + errors
│   │   └── hash.ts                 # NEW — SHA-256 of a File
│   ├── components/publish/         # NEW — dropzone, progress, inspection, diff, commit panel
│   └── routes/Publish.tsx          # replaces the stub
└── tests/                          # NEW — Vitest: platform prompt, progress, scopes, errors

docs/
└── c4.md                           # rebuild, with an L3.x section for publishing

public/admin/                       # previous UI — read to port from, not modified
```

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Vitest added to `webui/` | Constitution VII requires tests, and the admin UI has none. The cost of not having them is already recorded: a sign-out that never called the server shipped from this same client. | Testing through the server suite cannot reach browser-side logic — the hash, the progress arithmetic, the platform-prompt trigger. Manual-only was the status quo and it failed. |
| A second package tree in the repo | Constitution IV names `pg` as the only **runtime** dependency and grants the admin UI its own tree. Vitest is a dev dependency and never enters the server image — the Dockerfile builds the UI in a separate stage and copies only the bundle. | None needed; IV already anticipated this. Recorded here so the exemption is visible rather than assumed. |
| Rebuilding `docs/c4.md` inside a feature | VII makes the C4 section part of done, and the file does not exist. The first feature after its deletion is the one that pays. | Deferring it would make this feature "done" under a rule it does not meet, and the next feature would inherit the same debt. |
