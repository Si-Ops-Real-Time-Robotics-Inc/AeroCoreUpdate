# Phase 1 Data Model: Delete an uploaded build

One migration, no new table, no new column. What changes is one foreign key's delete rule and
the order in which a removal takes its locks.

## Schema change — migration `011_channel_latest_restrict.sql`

| | Before | After |
|---|---|---|
| Constraint | `channel_latest_fkey` | `channel_latest_fkey` |
| Definition | `FOREIGN KEY (latest) REFERENCES release(version)` | same |
| On delete | `SET NULL` — deleting a served release empties its channel silently | `RESTRICT` — deleting a served release is refused by the database |

Applied inside the runner's own per-file transaction: drop the constraint, add it back with
`RESTRICT`. Existing rows are unaffected — `RESTRICT` only matters at the moment a release is
deleted. Nothing relies on `SET NULL`; see research Finding A for why.

## Entities touched

### Release (`release`)

| Field | Role here |
|---|---|
| `version` | primary key; locked `FOR UPDATE` by a removal |
| `system` | which system's channels can serve it |

Deleting it cascades to its artifacts (`artifact.version … ON DELETE CASCADE`, unchanged).

### Artifact (`artifact`)

| Field | Role here |
|---|---|
| `id` | what the per-artifact removal names |
| `version` | the release whose channels decide whether it may go |
| `file`, `kind`, `platform`, `platforms`, `size` | what the confirmation states |

### Channel (`channel`)

| Field | Role here |
|---|---|
| `system`, `name` | named in the refusal as `system/name` |
| `latest` | the rule reads it: any row with `latest = version` blocks the removal |

## The rule

```
may remove release V              ⟺  no channel has latest = V
may remove artifact A of release V ⟺  no channel has latest = V
```

Same condition for both — see the spec's Assumptions for why an artifact is not judged by
whether it is the last one serving a platform.

## Order of operations (both removals)

```
BEGIN                                     -- READ COMMITTED, the pool's default
  release row  ← SELECT … FOR UPDATE      -- blocks any promote's FK check (FOR KEY SHARE)
  if none      → 404, already gone
  serving      ← SELECT system, name FROM channel WHERE latest = V
  if any       → 409, finding release_in_use with serving
  DELETE the release row  |  DELETE the artifact row
  audit        release.delete | artifact.delete
  bump catalog revision
COMMIT
remove files                              -- after commit: an orphaned file is recoverable,
                                          -- a row pointing at missing bytes is not
```

For a single artifact the release is looked up through the artifact first (`findArtifactById`
→ its `version`), then locked. An artifact already gone is a 404 before any lock is taken.

## Refusal (existing envelope, new finding)

```json
{
  "error": "invalid_parameter",
  "message": "Release 0.13.5 is the latest of: HERA/stable. Point that channel at another release first.",
  "details": [
    { "rule": "release_in_use", "message": "…", "channels": ["HERA/stable"] }
  ]
}
```

`error` stays in the closed enum; the UI branches on `details[].rule`.

## Audit rows (existing actions, unchanged)

| Action | Subject | Detail |
|---|---|---|
| `release.delete` | version | `{ artifacts: n }` |
| `artifact.delete` | `version/file` | `{ id, kind, platform }` |

A refused removal writes no audit row: nothing happened, and unlike feature 004's
`channel.denied` nobody asked for more than they hold — an admin removing a served build is a
mistake the refusal corrects, not an escalation.

## Screen state (Catalog)

| State | What is on screen |
|---|---|
| row collapsed | version, system, served-by badges, artifact count, "Remove release" |
| row expanded | the release's artifacts, each with file, kind, platform(s), size, "Remove" |
| panel: served | "Served by HERA/stable — point it at another release first"; no destructive button |
| panel: confirming | what goes (release: version, system, n artifacts; artifact: file, platform, release) and "cannot be undone" |
| panel: refused | the channels **from the refusal**, and what must happen first |
| panel: already gone | said plainly; the catalog refreshes |
| no permission | no removal control; the permission it needs is named once |
