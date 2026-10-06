# Quickstart: proving a build can be removed and a removal cannot stop the fleet

## Prerequisites

- Test Postgres: `docker compose -f docker-compose.test.yml up -d --wait`
- For the walkthrough: the `aerotunnel-platform` stack and this server running with
  `docker compose -f docker-compose.yml up -d` (NOT the dev override — it bind-mounts
  `./public` and serves the previous UI at `/admin/`).

## Level 1 — the suites

```bash
TEST_DATABASE_URL=postgres://aerocoreupdate:aerocoreupdate@127.0.0.1:55432/aerocoreupdate_test npm test
cd webui && npx vitest run
```

New server coverage in `tests/delete-build.test.js`:

| Proves | Request | Expect |
|---|---|---|
| FR-003 | admin removes a release stable serves | 409, `rule: release_in_use`, `channels` names it; release still listed |
| FR-004 | admin removes an artifact of that release | 409, same finding; file still on disk |
| SC-002 | after either refusal, a device on stable checks | still offered the release |
| FR-001 | admin removes an unserved release | 200 `{ version, artifacts }`; files gone; audit `release.delete` |
| FR-002 | admin removes an artifact of an unserved release | 200 `{ id }`; file gone; rest of release intact; audit `artifact.delete` |
| FR-010 | either removal, twice | second is 404 |
| FR-007 | publisher, viewer | 403 on both |
| backstop | `channel_latest_fkey` | `ON DELETE RESTRICT` |
| migration | a release deleted directly in SQL while served | refused by the database |

Also:

- `tests/catalog-shape.test.js` — every property the contract declares on a catalog release is
  present in a real response. This is the check that would have caught the phantom `channels`.
- `tests/upload.test.js` — "deleting an artifact removes its file" now removes from an
  unserved release. It previously removed from a served one and expected 200, which asserted
  the defect; see research Finding C.
- `tests/openapi.test.js` — `Finding` declares `channels`; both delete operations declare
  401, 403, 404 and 409.

## Level 2 — the walkthrough

In Firefox against `https://192.168.194.129:9443/admin/`, as `admin@rtrobotics.com`,
`engineer@rtrobotics.com` and `pilot@rtrobotics.com`. The dev realm is HTTP behind an HTTPS
page, so the discovery fetch is active mixed content; a scripted browser needs
`security.mixed_content.block_active_content = false` (see the 001/003 walkthroughs).

| # | Do | See |
|---|---|---|
| 1 | Open Catalog as admin | a served release shows its channel; none reads "staged" wrongly |
| 2 | Expand a release | each artifact: file, kind, platform(s), size, Remove |
| 3 | Remove an artifact of an unserved release, decline | nothing removed |
| 4 | Remove it, confirm | gone; the rest of the release remains |
| 5 | Remove an unserved release, confirm | gone with every artifact |
| 6 | Try to remove the release stable serves | the panel says it is served by stable and offers no destructive button |
| 7 | Try to remove one of its artifacts | the same |
| 8 | Promote onto a release while its removal panel is open, then confirm | refused; the channels shown come from the refusal |
| 9 | Remove something another session already removed | "already gone"; the catalog refreshes |
| 10 | Open Catalog as engineer, then as pilot | no Remove anywhere; `catalog:delete` named |
| 11 | Stray-channel banner on Catalog | all four fields, as on Systems |

Scenario 8 is the race made visible. It is timing-sensitive by hand; the guarantee behind it is
the lock order in [data-model.md](./data-model.md), and the backstop is tested at Level 1.

## Leave it as you found it

Channels are returned to where the walkthrough found them, and any release it created is
removed. Record `HERA/beta` and `HERA/stable` before starting.
