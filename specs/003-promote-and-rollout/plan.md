# Implementation Plan: Closing the publish loop — promote, and see what came back

**Branch**: `003-promote-and-rollout` | **Date**: 2026-09-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-promote-and-rollout/spec.md`

## Summary

Port the Systems and Rollout screens so a release can go from upload to the fleet entirely in
the new admin UI.

The promote flow is not designed here — it exists in the previous UI and is more careful than
it appears: two confirmations answering different questions, and a rollback that the SERVER
detects and refuses, which the client then offers as a decision. Phase 0 read it rather than
reinventing it, and in doing so found two places where the contract describes less than the
server sends. Both are closed as part of this work.

## Technical Context

**Language/Version**: TypeScript 5.6, ES2022 in the browser. The server is not modified.

**Primary Dependencies**: React 18, Vite 5, TanStack Router + Query, Tailwind v4, Radix
primitives. Nothing new — Vitest arrived with feature 001.

**Storage**: None client-side. The promote state machine lives in component state and is
deliberately not persisted: a half-answered confirmation that survives a reload is a promote
nobody remembers starting.

**Testing**: Vitest for the pure decisions; `node --test` for the OpenAPI conformance the two
contract fixes must satisfy. Manual walkthrough in [quickstart.md](./quickstart.md).

**Target Platform**: the same bundle served from `/admin/` over HTTPS.

**Project Type**: web application; an existing single-page admin UI.

**Performance Goals**: none. One request populates the Systems screen.

**Constraints**: `style-src 'self'` with no `'unsafe-inline'` on this surface, so confirmations
are inline panels rather than dialogs — the same conclusion feature 001 reached. The rollback
comparison belongs to the server; the client must not predict it.

**Scale/Scope**: two screens, six operations, two contract fixes, one C4 section.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Pre-design | Post-design |
|---|---|---|
| I. Identity belongs to proxy_alpha | PASS — untouched | PASS |
| II. Uploading is not publishing | **This feature is where II lives** — see below | PASS |
| III. Node protocol frozen | PASS — `/api/v1` untouched | PASS |
| IV. One runtime dependency | PASS — server unchanged, no new packages | PASS |
| V. Layering is not advisory | PASS — no server change; the front end keeps decisions in `lib/` | PASS |
| VI. The contract is a file | **FAIL** — two schemas describe less than the server sends | PASS once both are fixed |
| VII. Done means tested, drawn and tidied | ACTION — `docs/c4.md` L3.1 stops at `beta` | PASS once promotion is drawn |
| VIII. Comments explain why | PASS by convention | PASS |
| IX. Admin surface is HTTPS only | PASS — unchanged | PASS |

**II is the whole point of this screen, and the risk it carries.** Every other screen in this
UI adds to a catalog nobody is served from. This one moves a channel, which is the single
action that reaches an aircraft. Three things follow and none is optional:

- The control is offered only to `channel:write`, which only an admin holds. A publisher reads
  the screen and is told why the control is absent.
- No path moves a channel without a person having read a sentence naming both versions.
- The rollback guard is the server's, and the client's job is to surface it — not to
  reimplement the comparison, and not to send the override by default.

**VI fails today in two places, both found by reading the previous UI**:

1. `Finding` declares `rule` and `message`; the `channel_rollback` finding also carries `from`
   and `to`, and the confirmation cannot be written without them.
2. `Catalog.stray_channels` declares two fields of the four the server sends — `nodes` and
   `last_seen` are missing, and they are what make the banner actionable.

Neither is a follow-up. A screen rendering fields the contract does not declare is
hand-writing shapes under another name.

## Project Structure

### Documentation (this feature)

```text
specs/003-promote-and-rollout/
├── plan.md              # This file
├── research.md          # Phase 0: how promote already works, and two contract gaps
├── data-model.md        # Phase 1: shapes received, and the promote state machine
├── quickstart.md        # Phase 1: thirteen scenarios
├── contracts/
│   └── api-usage.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks
```

### Source Code (repository root)

```text
api/openapi.yaml                          # + Finding.from/.to, + stray_channels.nodes/.last_seen

webui/src/
├── api/schema.d.ts                       # regenerated from the two fixes
├── lib/
│   ├── api.ts                            # systems, channels, reports — typed from the schema
│   ├── promote.ts                        # NEW — the state machine and the rollback finding
│   └── rollout.ts                        # NEW — grouping and the empty case
├── components/systems/                   # NEW — channel table, promote panel, stray banner
├── components/rollout/                   # NEW — outcome roll-up, recent reports
├── routes/Systems.tsx                    # replaces the stub
└── routes/Rollout.tsx                    # replaces the stub

webui/tests/                              # promote decisions, rollout grouping, scope gating

docs/c4.md                                # L3.1 stops at beta; promotion needs drawing

public/admin/app.js                       # read as reference; NOT modified
```

## Complexity Tracking

| Choice | Why it is not simpler | Simpler alternative rejected because |
|--------|----------------------|--------------------------------------|
| Two confirmations, not one | They answer different questions — "this clears another channel" is not "this is a rollback", and an operator can meet either, both or neither in one promote | One dialog covering both either over-warns on an ordinary forward move or under-warns on a rollback, and the rollback is the one that splits a fleet across two versions |
| The client does not predict a rollback | Version comparison is numeric and lives in the server's domain layer | A second implementation in the browser is a second opinion, and the two disagreeing is worse than the round trip it saves |
| Fixing two schemas inside a UI feature | Constitution VI, and both were found by reading what the previous UI reads | Deferring them means the screen types its own shapes, which is the failure VI names |
| Inline panels rather than dialogs | The CSP on this surface forbids the inline styles Radix sets | Relaxing `style-src` weakens the whole admin surface to style one confirmation |
