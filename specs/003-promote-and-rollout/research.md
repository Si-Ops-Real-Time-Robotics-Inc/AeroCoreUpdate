# Phase 0 Research: Closing the publish loop

The promote flow already exists in the previous UI, and it is more careful than it looks.
Reading it first turned up two places where the contract describes less than the server sends
— both of which would have been discovered as missing fields on screen.

## Decision 1 — A backward move is refused with a finding, and the client re-sends an override

**What the server does** (`src/services/catalogAdmin.service.js`): before pointing a channel at
a release, it compares against what the channel holds. If the new version is OLDER and the
request did not carry `allow_rollback`, it refuses with:

```
400 { error: "invalid_parameter",
      details: [{ rule: "channel_rollback", message: "…", from: "<current>", to: "<asked>" }] }
```

**What the client does**: catches the refusal, looks for the finding whose `rule` is
`channel_rollback`, uses its `from` and `to` to state what the rollback actually means, and —
only if the operator confirms — sends the same request again with `allow_rollback: true`.
Declining sends nothing further.

**Decision**: reproduce this exactly. Branch on `rule`, never on the message.

**Why the server refuses rather than warns**: a comment in the service explains it, and the
reasoning is worth carrying into the screen's wording — nodes already updated do NOT go back,
because the node refuses anything not strictly newer. But a device fresh from the factory has
no such protection: it takes whatever the channel points at. So a mistyped promote does not
roll the fleet back, it SPLITS it into "updated before the slip" and "provisioned after".

**Alternative rejected**: sending `allow_rollback: true` on every promote to avoid the
round-trip. That converts a guard into a formality, which is the one thing it must not be.

## Decision 2 — There is a SECOND confirmation, before the request, and it is not the rollback one

A release lives on one channel at a time. Pointing a channel at a release that currently sits
on another channel therefore CLEARS that other channel. The previous UI asks about this
*before* sending anything, and the server reports the result afterwards in `released`.

**Decision**: keep both. They answer different questions — "this will take the release off
somewhere else" is not "this is a rollback" — and an operator can meet either, both, or
neither in a single promote.

**Under-implementing this is the likely failure**: one confirmation dialog covering both cases
would either over-warn on an ordinary forward move or under-warn on a rollback.

## Decision 3 — The contract under-describes `Finding`. Fixing it is part of this feature.

`Finding` in `api/openapi.yaml` declares `rule` and `message` only. The `channel_rollback`
finding also carries `from` and `to`, and the screen needs both to say anything useful.

**Decision**: add `from` and `to` as optional fields on `Finding`, and regenerate the client
types.

**Why not a separate schema**: findings share one shape across bundle inspection and channel
refusals, and the client already discriminates on `rule`. A second schema would mean deciding
which one a `details` array holds, which the server does not distinguish either.

Constitution VI is the reason this is not deferred: a screen rendering `from`/`to` off a type
that does not declare them is hand-writing shapes again.

## Decision 4 — The contract also under-describes stray channels

`Catalog.stray_channels` declares `{system, channel}`. The server sends four fields — the
query behind it counts distinct serials and takes the newest sighting:

| Field | Meaning |
|---|---|
| `system`, `channel` | which channel, on which kind of device |
| `nodes` | how many distinct devices are asking for it |
| `last_seen` | when the most recent one asked |

**Decision**: describe all four, and render all four. The count and the timestamp are what turn
a banner from a curiosity into something an operator acts on: "three devices, last seen four
minutes ago" is an incident; "a channel exists somewhere" is not.

**This is FR-006, and the easy way to get it wrong** is a bare list of names — which is what
the current contract would let a careful implementer build.

## Decision 5 — No modal, for the same reason as feature 001

The Content-Security-Policy on `/admin/*` is `style-src 'self'` with no `'unsafe-inline'`, and
Radix primitives set inline style attributes. Feature 001 used an inline panel instead.

**Decision**: the promote confirmation is an inline panel that replaces the row's controls
while it is open, not a dialog. The previous UI used `window.confirm`, which is not available
to a React screen that wants to show structured content — two versions, the channels being
cleared, and what each means.

## Decision 6 — Permission gating differs per control on one screen

Three different scopes appear on the Systems screen: reading needs `catalog:read`, creating or
removing a kind of device needs `system:write`, and promoting needs `channel:write`. Only an
admin holds the last.

**Decision**: gate each control independently against the scopes already fetched, and state
the reason where a control is withheld rather than hiding it silently — the pattern feature
001 established.

**Not doing**: hiding the whole screen from a publisher. They have a legitimate reason to read
what is being served; what they may not do is move it.

## Decision 7 — Testing follows feature 001's shape

Pure decisions — is this a rollback, which channels would be cleared, does this account hold
the scope, how are outcomes grouped — go in `webui/src/lib/` and are tested with Vitest. The
screens stay thin.

**Rationale**: it is what let feature 001 test the platform-prompt trigger and the diff
summary without a DOM, and it keeps the branch under test the branch that runs.
