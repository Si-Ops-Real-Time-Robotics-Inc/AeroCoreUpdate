# Phase 1 Data Model: what these two screens read and own

Nothing is stored by the browser. These are the shapes received, plus the one state machine
the promote control owns.

## Received from the server

Generated into `webui/src/api/schema.d.ts`. `System`, `Channel`, `ChannelMoved`, `RolloutStat`
and `NodeReport` were tightened in feature 001; two others need work first — see
[contracts/api-usage.md](./contracts/api-usage.md).

### System and Channel

A system has exactly two channels. A channel points at one release or at nothing.

| Field | Meaning to the screen |
|---|---|
| `System.name`, `System.description`, `System.created_at` | the row |
| `Channel.latest` | the release served, or NULL — rendered as "nothing", never as blank |
| `Channel.updated_at` | when it last moved |

The catalog response carries `systems`, `channels` and `stray_channels` together, which is why
one request populates the whole screen.

### ChannelMoved

What a successful promote returns: `system`, `name`, `latest`, and **`released`** — the
channels this release was taken off. A release lives on one channel at a time, so promoting
can silently empty another; `released` is how the screen says which.

### StrayChannel

A channel naming a system that no longer defines it.

| Field | Why it is on screen |
|---|---|
| `system`, `channel` | which one |
| `nodes` | how many distinct devices are asking for it |
| `last_seen` | when the most recent one asked |

`nodes` and `last_seen` are what make this actionable. Those devices are being told they are
up to date and will never update — a count and a recent timestamp say that is happening now.

### RolloutStat and NodeReport

`RolloutStat` groups outcomes: `result`, `error` (`(none)` when the device reported no text),
`count`, most common first. Anything other than success counts against the release.

`NodeReport` is one device's account: `serial`, `from_version`, `to_version`, `result`,
`error`, and **two timestamps** — `at` is when the device says it happened, `received_at` is
when this server recorded it. Node clocks are not trustworthy, so both are shown and labelled.

### The rollback finding

A refused backward move returns `details` carrying a finding with `rule: "channel_rollback"`,
plus `from` and `to`. Branch on `rule`; `message` is prose and may be reworded.

## Owned by the screen

### Promote state machine

```text
idle ──choose version──▶ confirming ──confirm──▶ sending ──▶ done
                              │                     │
                              │            refused: rollback
                              ▼                     ▼
                          cancelled ◀──decline── confirmingRollback ──confirm──▶ sending(override)
```

| State | What is true |
|---|---|
| `idle` | nothing pending |
| `confirming` | the operator has been told which release is being replaced, by which, and which other channels would be cleared. **Nothing has been sent.** |
| `sending` | the request is in flight, without an override |
| `confirmingRollback` | the server refused: this is a backward move. Holds `from` and `to` from the finding. **Nothing has been stored.** |
| `sending(override)` | the same request again, carrying the override |
| `done` | the channel moved; `released` names anything cleared |
| `cancelled` | the operator declined at either question. **Nothing further is sent.** |

Two confirmations, not one, and they answer different questions:

1. **Before sending** — this release currently sits on another channel, and promoting clears
   it. Only asked when that is true.
2. **After a refusal** — this is a rollback. Only reachable from the server's refusal, never
   predicted client-side; the server owns the comparison.

Declining either sends nothing more. There is no state from which the channel moves without a
person having read a sentence naming both versions.
