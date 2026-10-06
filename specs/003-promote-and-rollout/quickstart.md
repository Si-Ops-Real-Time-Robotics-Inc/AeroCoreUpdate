# Quickstart: validating promote and rollout

## Prerequisites

- Stack up, realm reachable.
- Accounts: an admin (`aeroserver-admin`), a publisher (`aeroserver-publisher`), a viewer
  (`aeroserver-viewer`).
- At least two releases on one system, so a backward move is possible.

## Scenarios

| # | Do this | Expect |
|---|---|---|
| 1 | Open Systems as admin | Every system listed with what `beta` and `stable` each point at; an empty channel reads as "nothing" |
| 2 | Promote a newer release to `stable` | Confirmation naming both versions; after confirming, `stable` points at it |
| 3 | Promote a release that currently sits on another channel | Asked FIRST that the other channel will be cleared; afterwards the screen names what was cleared |
| 4 | Promote an OLDER release to `stable` | Refused, then offered as a rollback with `from` and `to` stated; confirming completes it |
| 5 | Decline the rollback | Nothing is sent; `stable` unchanged |
| 6 | Cause a stray channel | Banner names the channel, the system, how many devices and when last seen |
| 7 | Open Rollout for a release with reports | Outcomes grouped and counted, most common first |
| 8 | Open Rollout for a release with none | Says so plainly; no empty table |
| 9 | Read an individual report | Serial, versions moved between, and both timestamps distinguished |
| 10 | Create then delete a system | Appears with both channels empty; deletion states its consequences first |
| 11 | Sign in as publisher | Can read everything; no promote control, reason stated |
| 12 | Sign in as viewer | Can read; no promote and no create/delete, reason stated |
| 13 | After a promote, ask as a device | `/update/check` offers the newly promoted version |

## Automated

```bash
npm test                 # server, including OpenAPI conformance both ways
cd webui && npm test     # the screens' pure logic
cd webui && npm run typecheck
```

## Done when

Scenarios 1–13 pass, both suites green, and `docs/c4.md` describes promotion — its `L3.1`
currently stops at `beta`.
