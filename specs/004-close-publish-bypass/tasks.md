---

description: "Task list for 004 — Uploading must not be able to ship"
---

# Tasks: Uploading must not be able to ship

**Input**: Design documents from `/specs/004-close-publish-bypass/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/api-usage.md](./contracts/api-usage.md),
[quickstart.md](./quickstart.md)

**Tests**: REQUESTED and mandatory. Constitution VII, and this feature's whole deliverable is a
guarantee that must be re-checked on every run — a fix nothing tests is a fix that lasts until
the next refactor.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different files, no dependency on an incomplete task
- **[Story]**: US1–US4 from spec.md

## Path Conventions

Single project. `src/`, `tests/`, `api/`, `docs/`, `webui/src/` at repository root.

---

## ⚠️ One consequence discovered while ordering these tasks

Adding the backward-move guard to `store()` (FR-007) changes the **two-step publish** as well,
because the commit path also writes a channel through `store()`. A commit that would point
`beta` at an older release will start being refused with a `channel_rollback` finding.

That is consistent with FR-007 — "on every path that can do it" — and with the incident that
produced the requirement (`beta` moved 0.13.5 → 0.13.4 during an ordinary upload). It sits
awkwardly with FR-004's "the two-step publish MUST be unaffected", which was written about
naming a channel and permissions, not about rollback. Read together: the commit remains unable
to name a channel and needs no new permission, and it gains the same confirmation every other
path has.

**It cannot be left there**, because the new `webui/` has no rollback handling anywhere — only
the legacy `public/admin/app.js` does, and only on the promote path. Without T031–T033 an
operator re-publishing an older build through the Publish screen gets a refusal the screen
cannot act on. Those tasks are in US4 and are not optional.

---

## Phase 1: Setup

**Purpose**: know what green looks like before touching anything, and confirm the defect is
still there to be fixed.

- [X] T001 Bring up the test database and record a green baseline: `docker compose -f docker-compose.test.yml up -d --wait`, then `TEST_DATABASE_URL=postgres://aerocoreupdate:aerocoreupdate@127.0.0.1:55432/aerocoreupdate_test npm test`. Save the summary line. Any test already red is pre-existing and must be identified now, not discovered later and blamed on this feature.
- [X] T002 [P] Confirm the defect still reproduces on the running system using the scratchpad probes (`scope_probe.py` to show the token holds `artifact:write` and not `channel:write`, `upload_probe.py --channel stable` to show the refusal comes from the archive reader). Record the exact message — it is what T012 asserts must no longer happen.

**Checkpoint**: baseline known, defect confirmed present.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the contract, and the two pure rules the rest of the feature calls.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [X] T003 In `api/openapi.yaml`, document both upload operations — `uploadArtifact` (`POST /admin/api/artifacts`) and `uploadArtifactToRelease` (`POST /admin/api/releases/{version}/artifacts`). Add to EACH: query parameters `channel` (string, optional — describe all three states: absent means the automatic promotion target, present-and-empty means land nowhere, a name means land there and requires `channel:write` unless it is the staging channel), `kind` (string), `platforms` (string), `allow_rollback` (boolean, optional); and responses `"400": {$ref: "#/components/responses/BadRequest"}`, `"401": {$ref: "#/components/responses/Unauthorized"}`, `"403": {$ref: "#/components/responses/Forbidden"}`. Both operations today list only 201 and 413 and describe no parameters at all. Exact YAML in [contracts/api-usage.md](./contracts/api-usage.md).
- [X] T004 In `api/openapi.yaml`, add the `allow_rollback` query parameter (boolean, optional) to `commitUpload` (`POST /admin/api/uploads/{token}`), because T029 makes that path capable of the rollback refusal too.
- [X] T005 Regenerate the client types: `cd webui && npm run generate:api`, producing `webui/src/api/schema.d.ts`. Constitution VI — the client is generated from the contract, never hand-edited.
- [X] T006 Add the pure predicate `mayLandOnChannel({ channel, scopes, stagingChannel })` to `src/domain/scopes.js`, returning true when `channel === null` OR `channel === stagingChannel` OR `scopes.has(SCOPE.CHANNEL_WRITE)`. **The caller must pass `config.stagingChannel` (the literal `'beta'`), never `config.autoPromoteChannel`** — the comment on this function must say why: `autoPromoteChannel` is env-driven, so anchoring on it would let `AUTO_PROMOTE_CHANNEL=stable` silently reopen this exact hole through configuration. Pure, no I/O, no config import (Constitution V).
- [X] T007 [P] Create `src/domain/channel.js` with the pure function `rollbackFinding(system, name, current, next)`, returning the existing finding object `{ rule: 'channel_rollback', message, from: current, to: next }` when `current && isNewer(current, next)`, and `null` otherwise. Move the message text verbatim out of `src/services/catalogAdmin.service.js:222-225` — do not reword it; the legacy UI at `public/admin/app.js:336` and the operators both read it. Imports `isNewer` from `src/domain/version.js`.
- [X] T008 Create `tests/publish-rule.test.js` covering both pure functions with no database: `mayLandOnChannel` for all six combinations of (null / staging / other channel) × (has / lacks `channel:write`), and explicitly a case proving the predicate ignores `autoPromoteChannel` entirely; `rollbackFinding` for newer, older, equal, and absent-current.
- [X] T009 Add `tests/publish-rule.test.js` to the `test:unit` script in `package.json` so the rule is checked even without Postgres.

**Checkpoint**: the contract describes what the routes serve, and the two rules exist and are proven in isolation.

---

## Phase 3: User Story 1 + User Story 2 (Priority: P1) 🎯 MVP

**Goal**: an upload cannot reach the fleet (US1), and everyone who could publish before still
can (US2).

**Why together**: US1 alone is a change that removes a capability without proof it removed only
the wrong one. The check and the evidence it did not break an automated caller are one
increment.

**Independent Test**: with a publisher credential, upload naming `stable` — refused, `stable`
unmoved; upload naming nothing — lands on `beta`. With an admin credential, repeat naming
`stable` — it moves, exactly as before.

### Tests for US1 + US2

> Write these first; they must FAIL before T018. All in one file, so they run in sequence
> rather than `[P]`.

- [X] T010 [US1] Create `tests/upload-cannot-publish.test.js`: harness setup following `tests/upload-lands-on-beta.test.js` (`startServer({ env: { AUTO_PROMOTE_CHANNEL: 'beta', REQUIRE_CUMULATIVE_CONFIG: '0' } })`, `hasDatabase` skip guard), plus a publisher session and an admin session. Mint the publisher token the way `tests/scopes.test.js` does — `server.token({ aud: OIDC_AUDIENCE_ADMIN, roles: ['aeroserver-publisher'] })` — and the admin one via `signIn(server)`.
- [X] T011 [US1] Test in `tests/upload-cannot-publish.test.js`: publisher `POST /admin/api/artifacts?channel=stable` with a VALID bundle → 403, and `stable` still points where it did (assert via `GET /admin/api/catalog` with the admin session). Proves FR-001 and SC-001.
- [X] T012 [US1] Test in `tests/upload-cannot-publish.test.js`: publisher `POST /admin/api/releases/{version}/artifacts?channel=stable` → 403. The two routes share one handler, which is exactly why the second is easy to forget; assert it separately.
- [X] T013 [US1] Test in `tests/upload-cannot-publish.test.js`: publisher `POST /admin/api/artifacts?channel=stable` with a **deliberately invalid gzip body** → 403, NOT the archive reader's "The gzip stream does not contain a tar archive." This is the regression test for the original finding: the defect was the ORDER of the two refusals, so asserting the status alone would pass on the broken code.
- [X] T014 [US1] Test in `tests/upload-cannot-publish.test.js`: publisher `POST /admin/api/artifacts` with no `?channel=` → 201, `promoted_to: "beta"`. Proves FR-002 — a publisher can still get a build in front of the test group, which is most of the role's job.
- [X] T015 [US1] Test in `tests/upload-cannot-publish.test.js`: publisher `POST /admin/api/artifacts?channel=beta` → 201, lands on `beta`. Naming the channel it would have landed on anyway asks for nothing extra (spec edge case).
- [X] T016 [US1] Test in `tests/upload-cannot-publish.test.js`: publisher `POST /admin/api/artifacts?channel=` (present, empty) → 201, `promoted_to: null`, no channel moved. Landing nowhere reaches nobody (spec edge case).
- [X] T017 [US2] Test in `tests/upload-cannot-publish.test.js`: admin `POST /admin/api/artifacts?channel=stable` → 201, `stable` now points at the uploaded version. Proves FR-003 — the operation is not withdrawn, only gated.
- [X] T018 [US2] Test in `tests/upload-cannot-publish.test.js`: publisher stages via `POST /admin/api/uploads` and commits via `POST /admin/api/uploads/{token}` → 201, lands on `beta`, no channel named by the caller. Proves FR-004.

### Implementation for US1 + US2

- [X] T019 [US1] In `src/controllers/admin.controller.js`, in `uploadArtifact`, add the check immediately after `validateUploadQuery` and **before** `publish.uploadArtifact` is called — therefore before a byte of the body is read. Call `mayLandOnChannel({ channel, scopes: req.user.scopes, stagingChannel: config.stagingChannel })`; on false throw `forbidden(...)`. Comment must record why the check is here and not in the validator (it cannot see the caller) or the service (shared with the safe two-step commit). Message text is T024's task — leave a placeholder that names the scope.
- [X] T020 [US2] Run the untouched set and confirm all still pass with no edits to them: `tests/upload-lands-on-beta.test.js`, `tests/upload.test.js`, `tests/staged-upload.test.js`, `tests/publish-auto.test.js`, `tests/scopes.test.js`. If any needs modification to pass, the change removed a capability — stop and reconsider rather than editing the test.

**Checkpoint**: the hole is closed and demonstrably nothing else was taken away. This is the MVP and is worth shipping alone.

---

## Phase 4: User Story 3 — A refusal explains itself (Priority: P2)

**Goal**: the operator refused reads the message and knows the upload was fine and which
permission was missing; an administrator can find the attempt afterwards.

**Independent Test**: trigger the refusal, read the message, then look for the audit row.

- [X] T021 [US3] Test in `tests/upload-cannot-publish.test.js`: the 403 body's `message` contains `channel:write`, names the channel that was asked for, and states that uploading itself is allowed. Assert on substance, not on the exact sentence.
- [X] T022 [US3] Test in `tests/upload-cannot-publish.test.js`: `error` on that 403 is `"invalid_api_key"` — the closed enum's code for 403 (`src/core/errors.js`). It looks wrong and is deliberate: the enum is closed because nodes branch on it (Constitution III). A test stops someone "fixing" it into a new code.
- [X] T023 [US3] Test in `tests/upload-cannot-publish.test.js`: after the refusal, the `audit` table holds a row with the caller as `actor`, action `channel.denied`, the requested channel as `subject`, and `detail` recording `missing: 'channel:write'`. Query it through the admin session's audit endpoint or directly, following whichever pattern the existing suite uses.
- [X] T024 [US3] In `src/controllers/admin.controller.js`, write the refusal message in full: name the system/channel asked for, name the missing `channel:write` permission, and say the upload itself is permitted and would land on the staging channel where an administrator can review and promote it. FR-005 — an engineer whose upload suddenly fails will otherwise assume the build is at fault.
- [X] T025 [US3] In `src/controllers/admin.controller.js`, before throwing, write the audit row via `insertAudit({ actor: req.user.username, action: 'channel.denied', subject: channel, detail: { requested: channel, missing: 'channel:write', route: 'upload' } })` from `src/repositories/audit.repository.js` — with NO client argument, because the refusal happens before the upload's transaction exists. Comment why this is the one audit row recording something that did not happen.

**Checkpoint**: the boundary reads as a boundary, and asking for more than you hold leaves a trace.

---

## Phase 5: User Story 4 — Every path that reaches the fleet gets the same care (Priority: P3)

**Goal**: a backward channel move is identified on the upload path exactly as it is on the
publish path, with the same finding and the same override.

**Independent Test**: point a channel backwards through the upload and through the promote
endpoint; both refuse identically, and both proceed with the override.

- [X] T026 [US4] Test in `tests/upload-cannot-publish.test.js`: admin uploads a version OLDER than what `beta` currently points at, with `?channel=beta` → 400, `details[0].rule === 'channel_rollback'`, carrying `from` and `to`. Proves FR-007 on the upload path.
- [X] T027 [US4] Test in `tests/upload-cannot-publish.test.js`: the same upload with `?allow_rollback=true` → 201 and the channel moves.
- [X] T028 [US4] Test in `tests/upload-cannot-publish.test.js`: the same backward move through `PUT /admin/api/systems/{system}/channels/{name}` refuses with an identical `rule`, `from` and `to`. Both paths, one shape — a scripted caller handles one refusal, not two.
- [X] T029 [US4] In `src/validators/admin.validator.js`, have `validateUploadQuery` parse `allow_rollback` from the query (`Boolean` of the presence of a truthy value, matching how `src/validators/admin.validator.js:278` treats the JSON body field) and return it alongside `channel`. The validator still knows nothing about the caller — this is parsing, not authorisation.
- [X] T030 [US4] In `src/services/catalogAdmin.service.js`, replace the inline guard at lines 216-231 of `upsertChannel` with a call to `rollbackFinding(...)` from `src/domain/channel.js`, throwing `invalidBundle([finding])` when it returns one. Behaviour must be byte-identical — `tests/systems.test.js` and the legacy UI both depend on the message.
- [X] T031 [US4] In `src/services/publish.service.js`, inside `store()`'s transaction and before the `INSERT INTO channel ... ON CONFLICT`, read the channel's current `latest` with the transaction's `client` and call `rollbackFinding(...)`; throw `invalidBundle([finding])` unless `allowRollback` was passed. Inside the transaction so the artifact write rolls back with it — a stored artifact whose channel move was refused is a half-done release.
- [X] T032 [US4] Thread `allowRollback` from `uploadArtifact` in `src/controllers/admin.controller.js` through `publish.uploadArtifact` (`src/services/publish.service.js:255`) into `store()` (line 265). Gate it on `channel:write` in the controller the same way naming a channel is — the override is meaningless without the permission it overrides.
- [X] T033 [US4] In `src/controllers/admin.controller.js`, have `commitUpload` accept `allow_rollback` from the query and pass it into `publish.commitUpload` → `store()` (`src/services/publish.service.js:240`). The two-step path can now hit the guard too; it must be able to carry the answer.
- [X] T034 [US4] In `webui/src/routes/Publish.tsx` (and `webui/src/lib/upload.ts` if the commit call lives there), catch a 400 whose `details` contain `rule === 'channel_rollback'`, show the finding's `from` and `to`, and offer re-sending the commit with `allow_rollback=true`. Declining must send nothing further. `public/admin/app.js:306-346` is the behavioural reference and MUST NOT be modified. Without this the Publish screen shows an operator a refusal it cannot act on.
- [X] T035 [US4] Add a Vitest case under `webui/src/` for the new branch: a commit response carrying a `channel_rollback` finding produces the confirmation, and declining issues no second request.

**Checkpoint**: one rule, one message, one override, every path.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T036 Update `docs/c4.md` section `## L3.1 — Publishing a release`: the flow stops at "lands on beta" and says nothing about who may ask for another channel. Add the permission split to the mermaid sequence — upload gated on `artifact:write`, naming a non-staging channel additionally on `channel:write` — and the backward-move guard now common to both paths. Constitution VII makes this part of done, not documentation debt.
- [X] T037 [P] Confirm the `.env` sweep required by CLAUDE.md: this feature adds no configuration, so verify `AUTO_PROMOTE_CHANNEL` is still read by `src/config/index.js`, still documented in `.env.example` with its reason, and that nothing was left behind. Add a line to its `.env.example` comment noting it no longer decides who may publish — a reader who sets it to `stable` must not expect the old behaviour.
- [X] T038 [P] Run `npm run check` and check by eye for anything this feature orphaned — the inline guard text moved out of `catalogAdmin.service.js`, and any now-unused import in the files touched. `check-refs` finds calls without definitions, not definitions without callers.
- [X] T039 Run the full suite: `npm run test:docker`. Report the output verbatim if anything is red. Compare against the T001 baseline so a pre-existing failure is not attributed here.
- [X] T040 Run quickstart.md Level 2 against the running platform: `upload_probe.py --channel stable` must now return 403 naming `channel:write`, and `upload_probe.py` with no channel must return 201 landing on `beta`. Confirm from the catalog that `stable` did not move. This is what SC-006 means by demonstrable.
- [X] T041 Update [plan.md](./plan.md)'s source-tree section to record two refinements this breakdown made: the rule lives as a pure predicate in `src/domain/scopes.js` and the rollback finding in a new `src/domain/channel.js`, both so they are testable without a database; and `webui/` and `commitUpload` are in scope because the guard reaches the two-step path. Also record the FR-004/FR-007 reading from the top of this file.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup. **Blocks every story.**
- **US1+US2 (Phase 3)**: after Phase 2. The MVP.
- **US3 (Phase 4)**: after T019 exists to attach the message and audit to.
- **US4 (Phase 5)**: after Phase 2 (needs T007). Independent of US3.
- **Polish (Phase 6)**: after the stories being shipped are complete.

### Task Dependencies Worth Naming

- T005 depends on T003 and T004 — regenerate after both contract edits, not between them.
- T008 depends on T006 and T007.
- T019 depends on T006.
- T030 and T031 both depend on T007 — the extraction precedes both call sites, which is the whole point of extracting rather than duplicating.
- T032 depends on T029 and T031.
- T034 depends on T033.
- T040 depends on T039 — do not probe the live platform with a build the suite has not passed.

### Within Each Story

Tests first and failing, then implementation. Every test in Phase 3–5 lands in the same file,
so they are written in sequence; the `[P]` marker is deliberately absent there rather than
forgotten.

### Parallel Opportunities

- T002 alongside T001.
- T007 alongside T003–T005 (different files entirely).
- T037 and T038 alongside each other.
- US3 (Phase 4) and US4 (Phase 5) are independent once Phase 3 lands, and can be taken by different people.

---

## Implementation Strategy

### MVP (Phases 1–3)

The hole closed, with proof that only the wrong capability was removed. Shippable on its own:
after T020 a leaked publisher credential stages a file and cannot ship firmware, which is the
sentence the constitution already claims.

### Then

1. **US3** — cheap, and it decides whether the fix reads as a boundary or as a broken upload.
2. **US4** — larger than it looks, because it reaches the two-step publish and therefore the
   Publish screen. Do not start it without T033–T035 in the same increment.
3. **Polish** — T036 and T039 are Constitution VII; the feature is not done without them.

---

## Notes

- No migration and no schema change anywhere in this feature. The `audit` table already has
  every column the new row needs.
- No new permission. Two already exist and the distinction between them is exactly what is
  being enforced.
- The single most important line of code in this feature is the one that reads
  `config.stagingChannel` instead of `config.autoPromoteChannel` (T006, T019). T008 is the test
  that keeps it that way.
