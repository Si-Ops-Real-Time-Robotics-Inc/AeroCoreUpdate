---

description: "Task list for feature 003 — promote a release, and see what the fleet said back"
---

# Tasks: Closing the publish loop — promote, and see what came back

**Input**: Design documents from `/specs/003-promote-and-rollout/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/api-usage.md](./contracts/api-usage.md)

**Tests**: Included. Constitution VII requires them, and the promote decisions are exactly the kind that must not be verified by clicking.

**Organization**: Grouped by user story.

## Two rules that shape every task below

**The server owns the rollback comparison.** No task adds a version comparison to the browser.
The client sends, catches the refusal carrying `rule: "channel_rollback"`, and offers the
override. A second implementation in the browser is a second opinion about the one action that
reaches an aircraft, and the two disagreeing is worse than the round trip it saves.

**`public/admin/app.js` is read, never written.** It is the behavioural reference for this
feature and remains the working UI until these screens land.

---

## Phase 1: Setup

- [X] T001 Record the current channel state as a baseline: `docker exec aerocoreupdate-db psql -U aerocoreupdate -d aerocoreupdate -tAc "select system, name, coalesce(latest,'(none)') from channel order by 1,2;"` and record it in this file (`specs/003-promote-and-rollout/tasks.md`). Every promote scenario later is judged against it
  - **Baseline 2026-09-10:**
    - `HERA|beta|0.13.4`
    - `HERA|stable|(none)`
    `stable` holds nothing, so the first promote in T039 is also the first time this system
    serves anything to the fleet at all — which makes it the cleanest possible check that a
    promote reaches a device.

- [X] T002 [P] Read the reference implementation before writing anything: the promote flow in `public/admin/app.js` (the `losing` pre-confirmation and the `channel_rollback` catch) and the four cases in `tests/ui.test.js` named "a forward move goes straight through", "a refused rollback is offered, not left as a dead end", "declining the rollback sends nothing more", "any other error is rethrown untouched"
  - **Read during Phase 0**, findings in [research.md](./research.md): the server refuses a
    backward move with `invalidBundle([{rule:'channel_rollback', message, from, to}])`, and
    the client re-sends with `allow_rollback: true` only after a confirmation. There is a
    SECOND, earlier confirmation about channels the promote would clear.

**Checkpoint**: the behaviour to reproduce is understood, and the starting channel state is written down.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Close the two contract gaps, then build the decision layer both screens sit on.

**⚠️ CRITICAL**: T003–T006 block every screen task. A screen written first would type its own
shapes, which is the failure Constitution VI names.

- [X] T003 Add `from` and `to` to the `Finding` schema in `api/openapi.yaml` as OPTIONAL string fields — optional because bundle-inspection findings do not carry them, while `channel_rollback` does. Document in the schema that they name the version being moved from and to
- [X] T004 Add `nodes` (integer) and `last_seen` (string, date-time) to `Catalog.stray_channels` items in `api/openapi.yaml`. The server's query counts distinct serials and takes the newest sighting; without both, the banner degrades into a list of names
- [X] T005 Regenerate the client types: `cd webui && npm run generate:api`, producing `webui/src/api/schema.d.ts`
- [X] T006 Extend `tests/openapi.test.js` with a check that `Finding` declares `from` and `to`, and that `Catalog.stray_channels` items declare `nodes` and `last_seen` — so neither can quietly shrink back
- [X] T007 [P] Create `webui/src/lib/promote.ts`: the state machine from [data-model.md](./data-model.md) (`idle → confirming → sending → done`, with `confirmingRollback` reachable only from a refusal), plus `rollbackFinding(error)` returning the finding whose `rule` is `"channel_rollback"` or null. NO version comparison in this file
- [X] T008 [P] Create `webui/src/lib/rollout.ts`: group outcomes for display and answer "were there any reports at all" as its own state, so an empty result cannot render as a clean pass
- [X] T009 [P] Add `webui/src/lib/channels.ts` exporting `channelsLosing(catalog, version, target)` — which OTHER channels currently point at this version and would therefore be cleared. Reads the catalog's channel list; it is a lookup, not a comparison
- [X] T010 Extend `webui/src/lib/api.ts` with `systems`, `createSystem`, `deleteSystem`, `getChannel`, `setChannel(system, channel, version, { allowRollback })` and `reports`, all typed from `webui/src/api/schema.d.ts`
- [X] T011 [P] Add `webui/tests/promote.test.ts` covering: every transition, that `confirmingRollback` is reachable ONLY from a refusal, that declining either question ends in a state that sends nothing, and that no exported function compares two version strings
- [X] T012 [P] Add `webui/tests/rollout.test.ts` covering grouping order (most common first), the "no reports at all" state as distinct from "all succeeded", and a report missing optional fields
- [X] T013 [P] Add `webui/tests/channels.test.ts` covering: a version on no other channel, on one, on several, and the target channel itself never counted as losing

**Checkpoint**: `npm run generate:api` is clean, `npm run typecheck` passes, and the decision layer is tested without a DOM.

---

## Phase 3: User Story 1 — Let a release reach the fleet (Priority: P1)

**Goal**: An admin can point the fleet's channel at a reviewed release.

**Independent test**: Promote a release and confirm a device asking what to run is offered it.

- [X] T014 [US1] Replace the stub in `webui/src/routes/Systems.tsx` with the screen shell and the promote state machine from `webui/src/lib/promote.ts` held in component state
- [X] T015 [US1] Create `webui/src/components/systems/PromotePanel.tsx` — an INLINE panel, not a dialog. The Content-Security-Policy on this surface is `style-src 'self'` with no `'unsafe-inline'`, and Radix primitives set inline style attributes (see [research.md](./research.md), Decision 5)
- [X] T016 [US1] Add the FIRST confirmation in `PromotePanel.tsx`: when `channelsLosing()` returns anything, state that promoting also clears those channels and that devices there keep what they have and are offered nothing new. Asked BEFORE any request is sent
- [X] T017 [US1] Wire the send in `webui/src/routes/Systems.tsx` through `api.setChannel(...)` WITHOUT `allowRollback`, and invalidate the `["catalog"]` query on success
- [X] T018 [US1] Add the SECOND confirmation in `webui/src/components/systems/PromotePanel.tsx`: on refusal, use `rollbackFinding()` to detect `channel_rollback` and render its `from` and `to`. State that devices already updated will NOT go back, but newly provisioned ones would take the older version — so the fleet splits across two versions. Any other error is rethrown untouched
- [X] T019 [US1] On confirming the rollback, re-send the identical request with `allowRollback: true`. On declining, send nothing further and return to `idle`
- [X] T020 [US1] In `webui/src/routes/Systems.tsx`, after a successful promote, name every channel in the response's `released` — a release lives on one channel at a time, so promoting can empty another and the operator must not discover that later
- [X] T021 [P] [US1] Add `webui/tests/promote-panel.test.ts` asserting the two confirmations are distinct: an ordinary forward move with no losing channels asks nothing before sending, and a rollback is never offered without a refusal having arrived

**Checkpoint**: a release can be promoted, and both refusal paths behave.

---

## Phase 4: User Story 2 — See what is being served right now (Priority: P1)

**Goal**: An operator can read what every system's two channels point at.

**Independent test**: Open the screen and read, per system, what each channel serves.

- [X] T022 [US2] Create `webui/src/components/systems/ChannelTable.tsx` listing each system with what its two channels point at. A channel pointing at nothing MUST read as "nothing", never as a blank cell
- [X] T023 [US2] Load the screen from one `GET /admin/api/catalog` in `webui/src/routes/Systems.tsx` — it carries systems, channels and stray channels together
- [X] T024 [US2] Create `webui/src/components/systems/StrayBanner.tsx` rendering ALL FOUR fields: the channel, the system, `nodes` (how many distinct devices are asking) and `last_seen`. A count and a recent timestamp are what make this an incident rather than a curiosity — those devices are being told they are up to date and will never update
- [X] T025 [P] [US2] Add `webui/tests/stray.test.ts` asserting the banner's summary names the count and the time, and that zero stray channels renders nothing at all

**Checkpoint**: the screen answers "what is the fleet running?" before anyone promotes anything.

---

## Phase 5: User Story 3 — Read what the fleet said back (Priority: P2)

**Goal**: An operator can see how a release fared.

**Independent test**: Open Rollout for a release with reports and read the outcome.

- [X] T026 [US3] Replace the stub in `webui/src/routes/Rollout.tsx` with the screen, loading from `api.reports()` and optionally filtered by version
- [X] T027 [P] [US3] Create `webui/src/components/rollout/Outcomes.tsx` rendering grouped counts most common first, with anything other than success counted against the release
- [X] T028 [P] [US3] Create `webui/src/components/rollout/RecentReports.tsx` showing each device's serial, the versions it moved between, and BOTH timestamps labelled distinctly — `at` is what the device claims, `received_at` is what this server recorded, and node clocks are not trustworthy
- [X] T029 [US3] Render the "no reports at all" case as a sentence in `webui/src/routes/Rollout.tsx`. An empty table reads as a clean pass, which is the opposite of what no data means

**Checkpoint**: a promote decision can be made from evidence on screen.

---

## Phase 6: User Story 4 — Add or remove a kind of device (Priority: P3)

**Goal**: An operator can define or retire a system.

**Independent test**: Create one, see both channels empty, remove it.

- [X] T030 [US4] Add create and delete to `webui/src/routes/Systems.tsx` via `api.createSystem` and `api.deleteSystem`, invalidating `["catalog"]` after either
- [X] T031 [US4] Before deleting, state what removing the system would affect — releases filed under it and the channels that would go with it — in `webui/src/components/systems/ChannelTable.tsx` or its own inline panel

**Checkpoint**: the system list is manageable without the previous UI.

---

## Phase 7: User Story 5 — See only the controls you may use (Priority: P3)

**Goal**: A control that would be refused is not offered, and its absence is explained.

**Independent test**: Sign in as publisher and as viewer; check which controls appear.

- [X] T032 [US5] Gate the three controls independently in `webui/src/routes/Systems.tsx` using `webui/src/lib/scopes.ts`: reading needs `catalog:read`, create and delete need `system:write`, and promote needs `channel:write`. State the reason wherever a control is withheld rather than hiding it silently
- [X] T033 [P] [US5] Extend `webui/tests/scopes.test.ts` with the three scope sets this realm issues, asserting that a publisher sees no promote control and that only an admin does — Constitution II, enforced rather than trusted

**Checkpoint**: the permission boundary reads as a boundary, not as a broken page.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T034 Add `## L3.3 — Promoting a release to the fleet` to `docs/c4.md` with a `mermaid` diagram: review on beta → confirm → PUT the channel → refusal path for a rollback → override. `L3.1` describes publishing and stops at `beta`, so promotion is currently undrawn
- [X] T035 [P] Update `docs/c4.md`'s L3.1 to point forward to L3.3, so the two halves of publishing read as one workflow rather than two documents
- [X] T036 Remove the "Not ported to this UI yet" stubs' reasoning from `webui/src/routes/Systems.tsx` and `webui/src/routes/Rollout.tsx`, and check that `Fleet.tsx` and `Security.tsx` still link to `/admin/legacy.html` — two tabs remain unported and must keep saying so
- [X] T037 Re-run the orphaned-export scan over `webui/src/` and delete anything this feature left behind (Constitution IV and the cleanup rule)
- [X] T038 Run `npm test` at the repository root and `npm test` in `webui/`, and report the output as it is
- [X] T039 DONE 2026-09-10 — all thirteen walked against the running container: scenarios 2, 3, 4, 5 and 13 by probe (the `latest` field, the `channel_rollback` finding's `from`/`to`, the override, and a device offered the promoted build), and 1, 6, 7, 8, 9, 10, 11, 12 in Firefox, 8/8 pass. Channels were returned to where the walkthrough found them: HERA/beta 0.13.4, HERA/stable nothing.

---

## Dependencies

```text
Phase 1 (baseline + read the reference)
   └─▶ Phase 2 (contract fixes, then the decision layer) ─┬─▶ Phase 3 (US1, P1) ─┐
                                                          ├─▶ Phase 4 (US2, P1) ─┤
                                                          ├─▶ Phase 5 (US3, P2) ─┼─▶ Phase 8
                                                          ├─▶ Phase 6 (US4, P3) ─┤
                                                          └─▶ Phase 7 (US5, P3) ─┘
```

- **T003–T006 block everything.** The screens render fields the contract does not yet declare.
- **T007–T009 before their screens.** The decisions are tested without a DOM; the screens stay thin.
- **US1 and US2 ship together.** A promote control without the view is the more dangerous half
  alone — an operator who cannot see what the fleet runs today is guessing about the only
  action that reaches an aircraft.
- **US3, US4, US5 are independent** of each other once Phase 2 is done.
- T034 before T035. T038 and T039 last.

## Parallel execution examples

**Phase 2**: T007, T008 and T009 are three separate files with no shared state; T011–T013 are
their tests and can be written alongside.

**Phase 3 and 4** touch `Systems.tsx` in common, so they interleave rather than parallelise —
but T021 and T025 are separate test files.

**Phase 5**: T027 and T028 are two components with nothing between them.

**Across stories**: once Phase 2 lands, one person can take Phase 5 while another takes
Phases 3–4.

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3 + Phase 4.** That is the smallest slice that closes the
publish loop, and the two P1 stories are inseparable for the reason above.

**Increment 2**: Phase 5 — the evidence for the decision. The decision can be made without it,
which is why it is not P1, and it is not much less important.

**Increment 3**: Phases 6 and 7 — managing systems, and matching controls to permissions.

**Then Phase 8**, which is not optional: under Constitution VII a feature whose tests have not
been run and whose C4 does not describe it is not done.

**Rollback**: everything here is a front end change plus two additive schema fields. `git
revert` restores it completely — the one thing that is not reversible is a channel actually
moved during T039, which is why T001 records where the channels started.
