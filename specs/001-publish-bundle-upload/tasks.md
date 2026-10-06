---

description: "Task list for feature 001 — publish a firmware bundle from the new admin UI"
---

# Tasks: Publish a firmware bundle from the new admin UI

**Input**: Design documents from `/specs/001-publish-bundle-upload/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/api-usage.md](./contracts/api-usage.md)

**Tests**: Included. Constitution VII makes them part of done, and the admin UI has none today.

**Organization**: Grouped by user story so each stays independently testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: Which user story the task serves

## Path Conventions

Server is unchanged except `api/openapi.yaml` and `docs/c4.md`. Front end lives in `webui/`,
built into `public/admin/` inside the Docker image.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Give the admin UI a test runner it does not have.

- [X] T001 Add `vitest` as a devDependency and a `"test": "vitest run"` script in `webui/package.json`, then `npm install` in `webui/`
- [X] T002 Create `webui/vitest.config.ts` with the same `@` → `./src` alias as `webui/vite.config.ts`, so tests resolve imports the way the bundle does
- [X] T003 [P] Add `webui/tests/smoke.test.ts` asserting the runner executes and the `@` alias resolves — a suite that cannot import the code under test passes vacuously
- [X] T004 [P] Add `webui/coverage/` and `webui/.vitest/` to `.gitignore`, and confirm `.dockerignore` keeps `webui/tests/` out of the image build context

**Checkpoint**: `cd webui && npm test` runs and reports one passing test.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Close the two constitution gates and build the transport this feature needs.

**⚠️ CRITICAL**: No user story work begins until this phase is complete — every story below
renders generated types or uses the upload path.

- [X] T005 Delete the `discardUpload` entry from `webui/src/lib/api.ts`. It declares `DELETE /admin/api/uploads/{token}`, which does not exist — `src/routes/admin.routes.js` registers exactly two upload routes, both POST. Discard is client-side only (see [contracts/api-usage.md](./contracts/api-usage.md))
- [X] T006 Read `serializeInspection` in `src/services/publish.service.js` and the diff builder used by `diffForInspection`/`diffAgainstPrevious` in `src/controllers/admin.controller.js`, and write down the exact field names each emits — the schemas in T007 must describe what the code returns, not what the UI wishes for
- [X] T007 Replace `additionalProperties: true` on the `Inspection` and `Diff` schemas in `api/openapi.yaml` with the fields found in T006. `Diff` MUST keep `no_op` (boolean, true when the release changes nothing). Inspection MUST name its config slices, the locked-parameter split, plugin entries and warnings
- [X] T008 Regenerate the client types: `cd webui && npm run generate:api`, producing `webui/src/api/schema.d.ts`
- [X] T009 Extend `tests/openapi.test.js` with a check that `Inspection` and `Diff` declare no open `additionalProperties`, so these two cannot silently reopen
- [X] T010 [P] Create `webui/src/lib/hash.ts` exporting `sha256(file: File): Promise<string>` using `crypto.subtle.digest('SHA-256', await file.arrayBuffer())`, returning lowercase hex. Document the whole-file memory cost and the 512 MB `UPLOAD_MAX_BYTES` ceiling in a comment
- [X] T011 Create `webui/src/lib/upload.ts` exporting an XHR-based `stageBundle(file, { platforms, expectedSha256, onProgress })`. It MUST set `Content-Type: application/gzip`, `X-Requested-With: fetch`, `Authorization: Bearer <token>` from `accessToken()`, and `X-Expected-SHA256`. It MUST map failures to the same `ApiError` shape as `webui/src/lib/api.ts`, reading `error`/`message`/`details` from the body
- [X] T012 [P] Add `webui/tests/hash.test.ts` covering a known vector (empty input, and a short fixed byte string) so a wrong hex encoding cannot pass
- [X] T013 [P] Add `webui/tests/upload.test.ts` with a stubbed `XMLHttpRequest` covering: headers set, progress callback arithmetic, non-2xx mapped to `ApiError` with `code` taken from the body's `error` field, and network failure surfaced rather than swallowed

**Checkpoint**: types regenerate cleanly, `npm run typecheck` passes, both suites green.

---

## Phase 3: User Story 1 — Publish a release (Priority: P1)

**Goal**: An operator can put a bundle into the catalog on `beta` again.

**Independent test**: Upload a known-good bundle, confirm it, see it in the catalog on `beta`
with `stable` unchanged.

- [X] T014 [US1] Replace the stub in `webui/src/routes/Publish.tsx` with the real screen shell: page header, and the state machine from [data-model.md](./data-model.md) (`idle → chosen → hashing → sending → staged → published`) held in component state
- [X] T015 [P] [US1] Create `webui/src/components/publish/Dropzone.tsx` — drag-and-drop plus a file input fallback, both reaching the same handler (FR-001)
- [X] T016 [P] [US1] Create `webui/src/components/publish/Progress.tsx` rendering phase label and `loaded/total`. Derive the percentage at render; never store it, or the bar and its caption drift apart
- [X] T017 [US1] Wire the flow in `Publish.tsx`: hash via `lib/hash.ts`, stage via `lib/upload.ts`, surface refusals with the server's `message` rather than a generic failure (FR-011)
- [X] T018 [US1] Add the commit action calling `commitUpload` from `webui/src/lib/api.ts`, and invalidate the `["catalog"]` query on success so the Catalog screen reflects it
- [X] T019 [US1] In `webui/src/routes/Publish.tsx`, after a successful commit, state that the release is on `beta` and that reaching the fleet needs a separate promotion (FR-012). Do NOT add any call to the channel endpoint — Constitution II
- [X] T020 [P] [US1] Add `webui/tests/publish-state.test.ts` covering the state machine transitions, including that no transition leads to a channel move
- [X] T021 [US1] Handle HTTP 413 in `webui/src/routes/Publish.tsx` by showing the server's stated limit from the error `message`, not a generic failure

**Checkpoint**: a bundle can be uploaded and committed end-to-end; `stable` verified unchanged.

---

## Phase 4: User Story 2 — Look before committing (Priority: P1)

**Goal**: Nothing is stored until a person has seen what is in the bundle and said yes.

**Independent test**: Upload, verify the catalog is unchanged, discard, verify nothing was
ever stored.

- [X] T022 [US2] Create `webui/src/components/publish/CommitPanel.tsx` — an inline panel, NOT a modal (see [research.md](./research.md), Decision 3). It MUST state that nothing has been stored yet, reading `stored` from the response rather than assuming it (FR-004)
- [X] T023 [P] [US2] Create `webui/src/components/publish/Inspection.tsx` rendering bundle contents, config slices with locked parameters shown apart from unlocked ones, plugin folders named with the product each belongs to, and warnings (FR-006)
- [X] T024 [P] [US2] Create `webui/src/components/publish/DiffView.tsx` rendering the change summary, and rendering `no_op` as a sentence — an empty list reads as a loading failure (FR-007)
- [X] T025 [US2] Add the discard action in `webui/src/components/publish/CommitPanel.tsx`, clearing the token held in `webui/src/routes/Publish.tsx`: drop the token, clear the panel, and report "Discarded — nothing was stored". It MUST NOT call any endpoint and MUST NOT claim a deletion (FR-005)
- [X] T026 [P] [US2] Add `webui/tests/inspection.test.ts` covering the locked/unlocked split, a plugin shared with another system versus one built only for this bundle, and a bundle whose slice config is empty
- [X] T027 [P] [US2] Add `webui/tests/diff.test.ts` covering `no_op: true` rendering as a statement, and a diff arriving without optional keys

**Checkpoint**: the full review is on screen and discard leaves nothing behind.

---

## Phase 5: User Story 3 — Settings-only bundles (Priority: P2)

**Goal**: A bundle that names no target devices can still be published.

**Independent test**: Upload a settings-only bundle, answer the prompt, upload proceeds.

- [X] T028 [US3] Detect the refusal in `webui/src/routes/Publish.tsx` by looking for a finding in `details` with `rule === "config_only_needs_platforms"`. Key off `details`, never off `message` — message is prose and may be reworded
- [X] T029 [P] [US3] Create `webui/src/components/publish/PlatformPrompt.tsx` letting the operator pick target platforms from the values the protocol defines
- [X] T030 [US3] In `webui/src/routes/Publish.tsx`, retry through `stageBundle` (`webui/src/lib/upload.ts`) with `?platforms=` from the held file, without asking the operator to choose the file again (FR-008)
- [X] T031 [P] [US3] Add `webui/tests/platform-prompt.test.ts` asserting the prompt triggers on that rule and on no other refusal

**Checkpoint**: a settings-only bundle publishes without leaving the screen.

---

## Phase 6: User Story 4 — See only what you may do (Priority: P3)

**Goal**: A read-only account is not shown a control whose only outcome is a refusal.

**Independent test**: Sign in as `pilot@rtrobotics.com` and confirm the upload control is
absent and the reason is stated.

- [X] T032 [US4] Gate the upload control in `webui/src/routes/Publish.tsx` on `artifact:write` being present in the `scopes` array from the existing `["me"]` query, and state why it is withheld rather than silently hiding it (FR-010)
- [X] T033 [P] [US4] Add `webui/tests/scopes.test.ts` covering admin, publisher and viewer scope sets against the gate

**Checkpoint**: viewer sees an explained read-only screen; engineer sees the full flow.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T034 Rebuild `docs/c4.md`: `# C4 — AeroServer`, then `## L1 — Context` (including proxy_alpha as the gateway and issuer), `## L2 — Container`, and `## Data`. Do not restore the version in git history — it describes the architecture before proxy_alpha, so its L1 and L2 are wrong
- [X] T035 Add `## L3.x — Publishing a release` to `docs/c4.md` with a `mermaid` diagram of stage → review → commit → `beta`, naming only modules, routes and tables that exist in running code (Constitution VII)
- [X] T036 Remove the Publish entry from the "Not ported yet" set: `webui/src/routes/Publish.tsx` no longer links to `/admin/legacy.html`
- [X] T037 Run `npm test` at the repository root and `npm test` in `webui/`, and report the output as it is
- [X] T038 DONE 2026-09-10 — walked in Firefox against the running container (`https://192.168.194.129:9443/admin/`), 12/12 checks pass across admin, engineer and pilot accounts. Scenario 6 was WRONG as written and is corrected in quickstart.md: re-uploading the same bundle is refused by the duplicate guard while staging, before any diff exists. Walk all ten scenarios in [quickstart.md](./quickstart.md) against the running container, including scenario 5 — verify `stable` did not move
  - **Partially done 2026-09-10.** Verified by machine: scenario 5 (`stable` unchanged across
    the rebuild, `HERA|stable` still empty), scenario 8 (a wrong `X-Expected-SHA256` is
    refused with `sha256 mismatch` before the archive is read), and the auth/scope path
    (an `aeroserver-publisher` token reaches the staging endpoint and its refusal arrives as
    `{error, message}`). Scenarios 1–4, 6, 7, 9 and 10 need a person with a browser and a
    real bundle: dragging a file, reading the review, discarding, and confirming.

---

## Dependencies

```text
Phase 1 (Setup)
   └─▶ Phase 2 (Foundational) ─┬─▶ Phase 3 (US1, P1) ─┐
                               │                       ├─▶ Phase 7 (Polish)
                               ├─▶ Phase 4 (US2, P1) ─┤
                               ├─▶ Phase 5 (US3, P2) ─┤
                               └─▶ Phase 6 (US4, P3) ─┘
```

- **Phase 2 blocks everything.** US1 cannot stage without `lib/upload.ts`; US2 cannot render
  what it does not have generated types for.
- **US1 and US2 are separable but not shippable apart.** US2 renders what US1 stages; US1
  without US2 is a screen that publishes with no review, which is the property the spec
  argues for. Ship them together.
- **US3 and US4 are genuinely independent** of each other and of US2 once Phase 2 is done.
- T034 blocks T035. T037 and T038 come last.

## Parallel execution examples

**Phase 2**: T010, T012 and T013 run alongside T006/T007 — different files, and the hash path
does not depend on the schema work.

**Phase 3**: T015 and T016 are separate components with no shared file; T020 can be written
against the state machine as soon as T014 lands.

**Phase 4**: T023, T024, T026 and T027 are four separate files.

**Across stories**: once Phase 2 is done, one person can take Phase 5 while another takes
Phase 4 — they touch different components and only meet in `Publish.tsx`.

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3 + Phase 4.** That is the smallest slice that restores
publishing without removing the review that makes publishing safe. Both stories are P1 for
that reason.

**Increment 2**: Phase 5 — settings-only bundles, the one class the MVP still cannot publish.

**Increment 3**: Phase 6 — presentation for read-only accounts. Nothing unsafe happens
without it; the server refuses regardless.

**Then Phase 7**, which is not optional: under Constitution VII a feature without its tests
run and its C4 section is not done, whatever the screen looks like.

The previous UI stays at `/admin/legacy.html` throughout, so an incomplete increment is
inconvenient rather than blocking.
