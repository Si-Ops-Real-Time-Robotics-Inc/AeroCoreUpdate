# Phase 1 Data Model: Publish a firmware bundle

Nothing here is stored by the browser. These are the shapes the screen receives and the one
state machine it owns.

## Received from the server

All four are generated into `webui/src/api/schema.d.ts` from `api/openapi.yaml`. They are
listed with the fields this screen actually reads; the generated type is authoritative.

### StagedUpload

The result of staging. **Not a release, and nothing is stored.**

| Field | Meaning to this screen |
|---|---|
| `token` | Identifies the staged bundle for confirm or discard. Held in component state only. |
| `version`, `system`, `platform`, `platforms` | What the server read out of the bundle. |
| `size`, `sha256` | Shown so an operator can match them against what they built. |
| `stored` | Always `false` here. Rendered as a statement, never assumed. |
| `diff` | See below. |
| `inspection` | See below. |

`stored` is the field that keeps the panel honest. The previous UI added it after a review
panel that came *after* the write was mistaken for one that came before.

### CommittedUpload

What confirming returns: an `Artifact` plus `release_created`, `promoted_to`, `system` and
`stored: true`. `promoted_to` names the channel the release landed on — `beta`, and the
screen states that rather than implying the job is finished (FR-012).

### Inspection

What the server found inside the bundle: contents, the settings it carries, the plugins it
holds, and warnings. Two renderings are required and both are load-bearing:

- **Config slices split by locked parameter.** A parameter a device has locked will not be
  applied; showing it beside the ones that will is how an operator reads what actually
  changes.
- **Plugin folders named with the product they belong to**, not filed under the core slice.
  A plugin shared with another system, or built only for this bundle, are different
  situations and the screen must not flatten them.

### Diff

How the bundle differs from the release below it, with `no_op` true when it differs in
nothing. `no_op` is rendered as a sentence, not as an empty list — an empty list reads as a
loading failure.

**Both `Inspection` and `Diff` are currently `additionalProperties: true` in the spec.
Tightening them is a task in this feature**, because a screen that renders their internals
against an open type is hand-writing shapes with extra steps (Constitution VI).

## Owned by the screen

### Publish state machine

```text
idle ──choose file──▶ chosen ──upload──▶ hashing ──▶ sending ──▶ staged
  ▲                     │                                          │
  │                     │                             confirm ─────┤──▶ published
  │                     │                             discard ─────┤──▶ idle
  │                     ▼                                          │
  └──────────────── needsPlatforms ◀────refused: no target─────────┘
```

| State | What is true |
|---|---|
| `idle` | No file chosen. Nothing staged, nothing to discard. |
| `chosen` | A file is selected; nothing has been sent. |
| `hashing` | Reading and digesting locally. Cancellable by navigating away; nothing exists server-side. |
| `sending` | Transferring, progress known. Still nothing stored. |
| `needsPlatforms` | Refused because the bundle names no targets. Holds the chosen file so a retry does not ask for it again (FR-008). |
| `staged` | Server has read and described the bundle. Holds `token`. **Nothing stored.** |

Discarding is a local transition: there is no discard endpoint, because nothing was written.
The token is dropped, the panel clears, and the staged file is swept server-side within the
hour. The screen must say "nothing was stored" rather than implying a deletion it did not
perform.
| `published` | Confirmed. A release exists on `beta`. |

Transitions out of `staged` are the two the operator chooses. There is no path from any
state to moving a channel: this screen never calls the channel endpoint (Constitution II).

### Progress

`{ loaded, total }` from the transfer, plus a phase label. Percentage is derived, never
stored — a stored percentage is how a progress bar ends up disagreeing with its own caption.
