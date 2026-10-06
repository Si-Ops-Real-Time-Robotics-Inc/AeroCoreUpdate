---

description: "Task list for 005 — Delete an uploaded build"
---

# Tasks: Delete an uploaded build

**Input**: Design documents from `/specs/005-delete-uploaded-build/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/api-usage.md](./contracts/api-usage.md),
[quickstart.md](./quickstart.md)

**Tests**: REQUESTED. Constitution VII makes them part of done, and the guarantee this feature
adds — a removal cannot silently stop the fleet — is only a guarantee if a test fails the day
it stops being true. Tests are written first and must fail before the task they cover.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different files, no dependency on an incomplete task
- **[Story]**: US1–US4 from spec.md

## Path Conventions

Single project: `src/`, `tests/`, `api/`, `docs/` and `webui/src/`, `webui/tests/` at the
repository root.

---

## ⚠️ Read before starting

1. **One existing test changes on purpose.** `tests/upload.test.js`, "deleting an artifact
   removes its file", removes an artifact of `0.15.0` while `0.15.0` is a channel's latest and
   expects 200 — it asserts the defect (research Finding C). T024 rewrites it to remove from an
   unserved release. Any OTHER existing test that needs editing to pass means a capability was
   removed: stop and reconsider rather than editing it.
2. **TypeScript is red between T005 and T011.** Removing the phantom `Catalog.releases[].channels`
   from the contract makes `r.channels` in `Catalog.tsx` a type error until T011 replaces it.
   Expected; do not work around it in `schema.d.ts`, which is generated.
3. **T036 is outside the spec's scope** (research Decision 5). It is separate so it can be
   dropped without touching anything else.
4. `public/admin/app.js` is the behavioural reference and MUST NOT be modified.

---

## Phase 1: Setup

- [X] T001 Record a baseline before touching anything: `docker compose -f docker-compose.test.yml up -d --wait`, then `TEST_DATABASE_URL=postgres://aerocoreupdate:aerocoreupdate@127.0.0.1:55432/aerocoreupdate_test npm test` and `cd webui && npx vitest run && npx tsc --noEmit`. Save both summary lines. Record `HERA/beta` and `HERA/stable` from the live database for the walkthrough in T042. Anything already red is pre-existing and must be named now, not attributed to this feature later.

**Checkpoint**: green baseline recorded, channel state recorded.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the contract made true, the schema made to refuse, and the pieces every story calls.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

### Tests first

- [X] T002 [P] Extend `tests/openapi.test.js` (no database) with three assertions, all failing now: (a) `Finding` declares `channels:` and still has `required: [rule, message]`; (b) the `delete:` operations under `/admin/api/releases/{version}` and `/admin/api/artifacts/{id}` each declare `"401"`, `"403"`, `"404"` and `"409"`; (c) `Catalog` → `releases` → `items` does NOT declare `channels`. Reuse the file's existing `schemaBlock()` helper for (a).
- [X] T003 [P] Create `tests/catalog-shape.test.js` (database; `hasDatabase` skip guard): upload one release with the harness's `publish()`, `GET /admin/api/catalog` with an admin session, read the property names declared on `Catalog.releases.items` in `api/openapi.yaml`, and assert every one of them is present on a returned release. Fails now on `channels`. The comment must say why this test exists: a field declared and never sent passed every other check (research Finding B).

### Contract

- [X] T004 Edit `api/openapi.yaml` exactly as [contracts/api-usage.md](./contracts/api-usage.md): `deleteRelease` 200 becomes `{ version, artifacts }` with `required: [version, artifacts]`, plus `"401"`, `"403"`, `"404"` and a `"409"` whose description names `rule: release_in_use`; `deleteArtifact` 200 becomes `{ id }` with `required: [id]`, plus `"401"`, `"403"`, `"409"` (keep `"404"`); `Finding` gains optional `channels: { type: array, items: { type: string } }` described as "`release_in_use` only — every `system/channel` serving the release, current at the moment of the refusal"; `Finding.rule`'s description names `release_in_use`; remove `channels` from `Catalog.releases.items.properties`. T002 and T003 now pass.
- [X] T005 Regenerate the client: `cd webui && npm run generate:api` → `webui/src/api/schema.d.ts`. `tsc` fails on `r.channels` in `Catalog.tsx` until T011 — expected (see "Read before starting").

### Server pieces

- [X] T006 [P] In `src/core/errors.js`, change `conflict` to `conflict(message = 'Already exists', details = null)` → `new HttpError(409, 'invalid_parameter', message, { details })`. Every existing caller keeps working unchanged. Comment: a caller that has to act on a conflict needs a `rule` to branch on, the same reason `invalidBundle` carries findings.
- [X] T007 [P] Create `src/db/migrations/011_channel_latest_restrict.sql`: `ALTER TABLE channel DROP CONSTRAINT channel_latest_fkey;` then `ALTER TABLE channel ADD CONSTRAINT channel_latest_fkey FOREIGN KEY (latest) REFERENCES release(version) ON DELETE RESTRICT;`. Header comment in the style of `010_remove_local_auth.sql`: `SET NULL` meant a release deleted while served silently emptied its channel; nothing legitimate relies on it — `deleteSystem` refuses while the system has releases and `upsertChannel` refuses cross-system pointers — so the only path it ever served was losing a race.
- [X] T008 [P] Add four functions to `src/repositories/catalog.repository.js`, each taking the transaction's `client`: `lockRelease(client, version)` → `SELECT version, system FROM release WHERE version = $1 FOR UPDATE`, returning the row or null; `channelsServing(client, version)` → `SELECT system, name FROM channel WHERE latest = $1 ORDER BY system, name`, returning `['system/name', …]`; `deleteReleaseRow(client, version)` and `deleteArtifactRow(client, id)`, each returning the deleted row count. The comment on `lockRelease` must say why `FOR UPDATE`: every path that points a channel at a release runs a foreign-key check taking `FOR KEY SHARE` on that row, and `FOR UPDATE` conflicts with it, so no promote can land between the check and the delete.

### Client pieces

- [X] T009 [P] Create `webui/src/lib/removal.ts` with `RELEASE_IN_USE = "release_in_use"`; `inUse(error)` returning the finding whose `rule` is `release_in_use` or null — keyed on `rule`, never the message, mirroring `rollbackFinding` in `webui/src/lib/promote.ts`; and `servedBy(catalog, release)` returning the names of channels in `catalog.channels` with the same `system` and `latest === release.version`. A lookup, not a comparison: the file compares no version strings.
- [X] T010 [P] In `webui/src/lib/api.ts`, add `deleteArtifact(id)` → `DELETE /artifacts/{id}` typed from the generated `{ id }`, and type `deleteRelease` from the generated `{ version, artifacts }` instead of `void`.
- [X] T011 In `webui/src/routes/Catalog.tsx`, replace every read of `r.channels` with `servedBy(catalog.data, r)` from `webui/src/lib/removal.ts`, so a release a channel serves shows that channel and only an unserved one reads "staged". Fixes the badge that has read "staged" for every release (research Finding B). `tsc` is green again after this.
- [X] T012 Create `webui/tests/removal.test.ts`: `inUse` keys on `rule` (a refusal with the right message and another rule is null), returns null for no `details` and for a non-`ApiError`; `servedBy` returns only same-system channels whose `latest` equals the version, returns `[]` for none and for an unloaded catalog; and, reading `webui/src/lib/removal.ts` with comments stripped, the file contains no `localeCompare`, `isNewer`, `compareVersions` or `parseVersion` — the same structural rule `webui/tests/promote.test.ts` enforces.

**Checkpoint**: the contract describes what is served, the schema refuses to empty a channel, and every story's building blocks exist.

---

## Phase 3: User Story 1 + User Story 2 (Priority: P1) 🎯 MVP

**Goal**: an administrator can remove a build nobody is being offered (US1), and no removal can
silently stop the fleet (US2).

**Why together**: US1 alone hands every administrator a one-click way to stop the fleet updating
with no visible sign. The control and the protection are one increment.

**Independent Test**: with stable serving a release, try to remove it and each of its artifacts
— refused, nothing removed, devices on stable still offered it. Remove an unserved release and
one artifact of another — gone, files gone, audited.

### Tests for US1 + US2

> All in `tests/delete-build.test.js`, so written in sequence rather than `[P]`. They must fail
> before T025–T026, except T018–T019, which verify T007 and pass as soon as it exists.

- [X] T013 [US1] Create `tests/delete-build.test.js`: `startServer()` (the harness pins `AUTO_PROMOTE_CHANNEL` to empty, so `publish()` leaves a release unserved); `admin = await signIn(server)`; fixtures through the harness's `publish()` and `setChannel()`: `7.0.0` with one slim `linux-x86_64` artifact, served by `setChannel(admin, 'stable', { latest: '7.0.0' })`; `7.1.0` unserved with two slim artifacts on two platforms from `KNOWN_PLATFORMS` in `src/domain/platform.js`; `7.2.0` and `7.3.0` unserved with one artifact each. Database access, where a test needs it, through `const { getPool } = await import('../src/db/pool.js')` after `startServer()`. Resolve artifact files on disk the same way `tests/upload.test.js`'s `listVersionDir` does.
- [X] T014 [US2] Test in `tests/delete-build.test.js`: `DELETE /admin/api/releases/7.0.0` → 409; `details[0].rule === 'release_in_use'`; `details[0].channels` includes `'default/stable'`; `7.0.0` is still in the catalog.
- [X] T015 [US2] Test in `tests/delete-build.test.js`: `DELETE /admin/api/artifacts/{id of 7.0.0's artifact}` → 409 with the same finding; the file is still on disk; the artifact is still listed.
- [X] T016 [US2] Test in `tests/delete-build.test.js` (SC-002): after T014 and T015, `GET /api/v1/update/check?serial=SN-1&platform=linux-x86_64&version=0.1.0&channel=stable` with `fleetHeaders()` → `update_available: true`, `version: '7.0.0'`. The refusals changed nothing a device sees.
- [X] T017 [US2] Test in `tests/delete-build.test.js` (US2 scenario 4): `setChannel(admin, 'stable', { latest: '7.2.0' })`, then `DELETE /admin/api/releases/7.0.0` → 200. Once the channel is pointed elsewhere, the removal goes ahead.
- [X] T018 [US2] Test in `tests/delete-build.test.js` (backstop): `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'channel'::regclass AND conname = 'channel_latest_fkey'` → `'r'`.
- [X] T019 [US2] Test in `tests/delete-build.test.js` (backstop): a direct `DELETE FROM release WHERE version = '7.2.0'` through `getPool()` rejects with `code === '23503'`, and `stable` still points at `7.2.0`. The database refuses on any path, including ones not written yet.
- [X] T020 [US2] Test in `tests/delete-build.test.js` (the lock): open a raw client with `getPool().connect()`, `BEGIN`, `UPDATE channel SET latest = '7.3.0' WHERE system = 'default' AND name = 'beta'` and do NOT commit — its foreign-key check holds `FOR KEY SHARE` on `7.3.0`. Fire `DELETE /admin/api/releases/7.3.0` without awaiting; assert it has not resolved after 300 ms; `COMMIT` the raw client; await the request → 409 `release_in_use` naming `'default/beta'`, and `7.3.0` is still present. Release the raw client in `finally`. The 300 ms check is the only timing assumption; the 409 after the commit is the guarantee.
- [X] T021 [US1] Test in `tests/delete-build.test.js`: `DELETE /admin/api/artifacts/{one of 7.1.0's two}` → 200 `{ id }`; its file is gone; the other artifact is still listed; the audit log has `artifact.delete` with subject `7.1.0/<file>`.
- [X] T022 [US1] Test in `tests/delete-build.test.js`: `DELETE /admin/api/releases/7.1.0` → 200 `{ version: '7.1.0', artifacts: 1 }`; its version directory is gone; it is not in the catalog; the audit log has `release.delete` with subject `7.1.0`.
- [X] T023 [US1] Test in `tests/delete-build.test.js` (FR-010): repeat T022's request → 404; repeat T021's → 404.
- [X] T024 [P] [US2] Rewrite, deliberately, "deleting an artifact removes its file" in `tests/upload.test.js`: instead of the fleet artifact of the served `0.15.0`, `publish()` an unserved `0.16.0` fleet artifact and remove that → 200, file gone. Leave "a release that is a channel latest cannot be deleted" unchanged. Confirm the rewritten test passes on the current code before T026 — it must pass both before and after.

### Implementation for US1 + US2

- [X] T025 [US2] Rewrite `deleteRelease(version, actor)` in `src/services/catalogAdmin.service.js`: inside `withTransaction`, `lockRelease` → null throws `notFound('No release <version>')`; `channelsServing` → non-empty throws `conflict('Release <v> is the latest of: <list>. Point that channel at another release first.', [{ rule: 'release_in_use', message, channels }])`; `deleteReleaseRow`; audit `release.delete` with `{ artifacts: n }`; `bumpRevision`. Files removed after commit, unchanged. Catch `err.code === '23503'` and rethrow as the same refusal, building `channels` from `catalog.listChannels()` filtered on `latest === version`. Remove the raw `client.query('DELETE FROM release …')`. The comment states the order — lock, check, delete — and why the lock and `RESTRICT` both exist (research Decision 1).
- [X] T026 [US2] Rewrite `deleteArtifact(id, actor)` in `src/services/catalogAdmin.service.js`: `findArtifactById` → null throws `notFound`; inside `withTransaction`, `lockRelease(client, artifact.version)` → null throws `notFound` (the release went with it); `channelsServing` → non-empty throws `conflict('Artifact <file> belongs to release <v>, which is the latest of: <list>. Point that channel at another release first.', [finding])` with the same `rule`; `deleteArtifactRow` → 0 rows throws `notFound` (already gone); audit and bump as today; file removed after commit. Remove the raw `client.query('DELETE FROM artifact …')`. T013–T023 now pass.
- [X] T027 [P] [US1] Create `webui/src/components/catalog/RemovePanel.tsx`, an inline panel (not a dialog — the `/admin/*` CSP forbids the inline styles the dialog primitive needs; follow `webui/src/components/systems/DeleteSystemPanel.tsx`). Props: the target (`{ kind: 'release', version, system, artifactCount }` or `{ kind: 'artifact', id, file, platforms, version }`), `servedBy: string[]`, `refusal: string[] | null`, `gone: boolean`, `busy`, `onConfirm`, `onCancel`. States: **served** (from the catalog) names the channels and says to point them at another release first, and renders NO destructive button; **refused** names the channels FROM THE REFUSAL, not from `servedBy`; **gone** says it is already gone; **confirming** asks "Remove <version>?" / "Remove <file>?" with Remove and Cancel — US3 fills in the full statement.
- [X] T028 [US1] Wire removal into `webui/src/routes/Catalog.tsx`: the artifact count becomes a toggle expanding an inline list of the release's artifacts (file, kind, `platform ?? platforms.join(', ')`, size), each with Remove; the row gains Remove release; one `removing` state renders `RemovePanel` beneath the row being acted on. Mutations through `api.deleteRelease` / `api.deleteArtifact`. On success, invalidate `["catalog"]` (FR-009), close the panel and say what was removed. On error: `inUse(err)` → refused state with `finding.channels`; an `ApiError` with status 404 → gone state and invalidate `["catalog"]`; anything else → an `Alert` with the server's message.

**Checkpoint**: builds can be removed from the new UI, and nothing a channel serves can be — not by the UI, not by a race, not by a future path. Shippable alone.

---

## Phase 4: User Story 3 — The operator knows what is about to go (Priority: P2)

**Goal**: the confirmation states exactly what goes, and declining sends nothing.

**Independent Test**: start a removal, read the confirmation, decline; nothing was removed.

- [X] T029 [US3] Extend `webui/tests/removal.test.ts` for `describeRemoval(target)`, failing now: for a release it names the version, the system, the artifact count with correct singular/plural, and the words "cannot be undone"; for an artifact it names the file, its platform(s) and the release version; it never returns an empty statement.
- [X] T030 [US3] Add `describeRemoval(target)` to `webui/src/lib/removal.ts`, returning the title and sentences the confirmation shows. A pure function so the wording FR-006 requires is tested rather than eyeballed.
- [X] T031 [US3] In `webui/src/components/catalog/RemovePanel.tsx`, render the confirming state from `describeRemoval(target)`; in `webui/src/routes/Catalog.tsx`, make `onCancel` clear `removing` and call no mutation — declining sends nothing (FR-006).

**Checkpoint**: no build goes without a confirmation that names it.

---

## Phase 5: User Story 4 — Only those who may remove are offered to (Priority: P3)

**Goal**: publisher and viewer accounts see no removal control, and are told which permission it needs.

**Independent Test**: open the catalog as `engineer@rtrobotics.com` and as `pilot@rtrobotics.com`.

- [X] T032 [P] [US4] Extend `webui/tests/scopes.test.ts`: `canRemove` is true for the admin scope set and false for the publisher set, the viewer set, an empty set and `undefined`. Fails now.
- [X] T033 [US4] Add `canRemove = (me) => has(me, "catalog:delete")` to `webui/src/lib/scopes.ts`, with a comment: removing is a third right, distinct from uploading and from moving a channel, and only the admin holds it.
- [X] T034 [P] [US4] Add to `tests/delete-build.test.js`: a publisher session (`signIn(server, 'engineer', ['aeroserver-publisher'])`) and a viewer session (`signIn(server, 'viewer', ['aeroserver-viewer'])`) each get 403 on both delete operations. Existing behaviour through `requireScope`; the test pins it.
- [X] T035 [US4] In `webui/src/routes/Catalog.tsx`, load `me` and render Remove release and every per-artifact Remove only when `canRemove(me)`; otherwise one line, once, not per row: removing a build needs the `catalog:delete` permission, which only an administrator holds.

**Checkpoint**: every account sees exactly the controls it may use.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T036 **Outside the spec's scope — may be dropped (research Decision 5).** In `webui/src/routes/Catalog.tsx`, replace the names-only stray-channel `Alert` and its comment with `<StrayBanner catalog={catalog.data} />` from `webui/src/components/systems/StrayBanner.tsx`, so both screens render the fact with all four fields.
- [X] T037 In `docs/c4.md`, add `## L3.4 — Removing a build` before `## Data`: a mermaid sequence — admin → Catalog → `RemovePanel` → `DELETE` → `catalogAdmin.service` → `catalog.repository` `lockRelease` (`FOR UPDATE`) → `channelsServing` → 409 `release_in_use` | delete row, audit, bump → COMMIT → remove files — and a paragraph on why both the lock and `RESTRICT` exist. In `## L3.3`, one sentence: a release a channel serves cannot be removed until the channel moves. In `## Data`: `channel_latest_fkey` is `ON DELETE RESTRICT` (migration 011), and files are removed after the commit. Every name must be readable from the running code (CLAUDE.md).
- [X] T038 [P] `.env` sweep per CLAUDE.md: this feature adds no configuration. Confirm no variable was added to or orphaned from `.env.example`, `docker-compose*.yml` or `Dockerfile`.
- [X] T039 [P] Run `npm run check`, then check by eye for what this feature left behind: no `r.channels` anywhere in `webui/src/`; no raw `DELETE FROM release` or `DELETE FROM artifact` left in `src/services/catalogAdmin.service.js`; the old stray-banner block gone if T036 was done; no unused imports in the files touched.
- [X] T040 Run everything: `npm test` with `TEST_DATABASE_URL` at the root; `cd webui && npx vitest run && npx tsc --noEmit && npm run build`. Compare with T001. Report any red output verbatim.
- [X] T041 Rebuild and run the production image, `docker compose -f docker-compose.yml up -d --build`; confirm the image has both UIs (`index.html` + `assets/`, and `legacy.html` with `app.js`), and that `git status --porcelain public/admin/` shows only the six pre-existing `M` files.
- [X] T042 Walk quickstart.md Level 2 — eleven scenarios — in Firefox against `https://192.168.194.129:9443/admin/` as admin, engineer and pilot, reusing the scratchpad harness from the 001/003 walkthroughs (snap Firefox binary at `/snap/firefox/current/usr/lib/firefox/firefox`, `security.mixed_content.block_active_content = false`, fixtures under `$HOME` because the snap cannot read `/tmp`). Afterwards return `HERA/beta` and `HERA/stable` to what T001 recorded, and remove every release the walkthrough created.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (1)**: none.
- **Foundational (2)**: after Setup. Blocks every story.
- **US1 + US2 (3)**: after Phase 2. The MVP.
- **US3 (4)**: after T027–T028 (it fills in the panel they create).
- **US4 (5)**: after T028. Independent of US3.
- **Polish (6)**: after the stories being shipped.

### Task Dependencies Worth Naming

- T004 after T002 and T003 — tests first, then the contract they check.
- T005 after T004; T011 after T005 and T009 (tsc is red in between).
- T012 after T009.
- T018 and T019 need T007 only; the other Phase 3 server tests need T025–T026.
- T025 and T026 after T006 and T008.
- T028 after T010, T011 and T027.
- T030 after T029; T031 after T030.
- T033 after T032; T035 after T033.
- T041 after T040; T042 after T041.

### Parallel Opportunities

- T002 ∥ T003; T006 ∥ T007 ∥ T008 ∥ T009 ∥ T010 — all different files.
- T024 alongside the `tests/delete-build.test.js` tasks (a different file).
- T027 (client) alongside T025–T026 (server).
- US3 (Phase 4) and US4 (Phase 5) are independent once Phase 3 lands.
- T038 ∥ T039.

---

## Parallel Example: Phase 2

```bash
Task: "T006 conflict(message, details) in src/core/errors.js"
Task: "T007 migration 011_channel_latest_restrict.sql"
Task: "T008 lockRelease/channelsServing/deleteReleaseRow/deleteArtifactRow in src/repositories/catalog.repository.js"
Task: "T009 servedBy/inUse in webui/src/lib/removal.ts"
Task: "T010 deleteArtifact + typed deleteRelease in webui/src/lib/api.ts"
```

## Parallel Example: Phase 3

```bash
Task: "T024 rewrite the defect-asserting test in tests/upload.test.js"
Task: "T027 RemovePanel in webui/src/components/catalog/RemovePanel.tsx"
# while tests/delete-build.test.js (T013–T023) and then T025–T026 proceed in sequence
```

---

## Implementation Strategy

### MVP (Phases 1–3)

Removal restored, and removal made unable to stop the fleet — including the race that exists
today with no UI involved at all. Shippable alone.

### Then

1. **US3** — small, and it is what makes a destructive control trustworthy.
2. **US4** — presentation; the server refuses regardless.
3. **Polish** — T037 and T040 are Constitution VII; the feature is not done without them. T036
   is optional.

---

## Notes

- One migration. No new table, no new column, no new permission, no new configuration.
- A refused removal writes no audit row — nothing happened, and an admin removing a served build
  is a mistake the refusal corrects, not an escalation (data-model.md).
- The single most important line is the `FOR UPDATE` in T008. T020 is the test that keeps it.
- **Correction found while preparing T042, applied before the image was built.** T028 showed
  "already gone" inside the row's panel. When a whole release is the thing already gone, the
  catalog refetch removes its row, and the message went with it — FR-010 unmet in exactly the
  case it names. The 404 now closes the panel and says so at the top of the page;
  `RemovePanel` no longer has a `gone` state.
