# Contract: the parameter this feature is about is not in the contract

`api/openapi.yaml` is the source of truth and `tests/openapi.test.js` asserts it against the
route table in both directions. Two operations carry the defect:

| Operation | Route | Scope on the route |
|---|---|---|
| `uploadArtifact` | `POST /admin/api/artifacts` | `artifact:write` |
| `uploadArtifactToRelease` | `POST /admin/api/releases/{version}/artifacts` | `artifact:write` |

Both are registered against the same handler, so one fix covers both — and one test must cover
both, because sharing a handler is exactly what makes the second easy to forget.

## Gap 1 — neither operation documents `channel`

They document a body, a 201 and a 413. The query parameter that decides whether an upload
reaches an aircraft appears nowhere. A generated client cannot send it; a reader cannot learn
the rule from the contract.

**Fix**: add to both operations

```yaml
- name: channel
  in: query
  required: false
  description: |
    Point this channel at the uploaded release, in the same transaction.

    Omitted, the release lands on the automatic promotion target. Present and
    empty, it lands nowhere. Naming any channel other than the staging channel
    requires `channel:write` — uploading fills the catalog, moving a channel is
    what reaches an aircraft, and they are deliberately different rights.
  schema: { type: string }
```

`kind` and `platforms` are undocumented on these two operations as well and are read by the
same validator. They are in scope for the same reason: the fix is one edit to each operation,
and leaving two of three parameters undescribed reproduces the gap in a smaller form.

## Gap 2 — neither operation documents a refusal it can now produce

**Fix**: add to both

```yaml
"400": { $ref: "#/components/responses/BadRequest" }
"401": { $ref: "#/components/responses/Unauthorized" }
"403": { $ref: "#/components/responses/Forbidden" }
```

403 already exists as a shared response and already says "authenticated, but this principal
lacks the scope the operation needs" — which after this feature is true of these two
operations for the first time.

## Response body, on the refusal

The existing envelope, unchanged:

```json
{
  "error": "invalid_api_key",
  "message": "This upload may not point \"gcs/stable\" at the release: it lacks the \"channel:write\" permission. The upload itself is allowed — send it without ?channel= and it will land on beta, where an administrator can review and promote it."
}
```

`error` is the closed enum's code for 403 (`src/core/errors.js` maps `forbidden` to
`invalid_api_key`); the enum is closed because nodes branch on it (Constitution III), so the
message carries what FR-005 requires: the missing permission, and that uploading was fine.

## Rollback finding — same shape, new producer

The upload path begins producing the finding `upsertChannel` already produces:

```json
{ "error": "invalid_parameter",
  "message": "gcs/beta is on 0.13.5; 0.13.4 is older. …",
  "details": [{ "rule": "channel_rollback", "message": "…", "from": "0.13.5", "to": "0.13.4" }] }
```

No contract change: `Finding` gained `from` and `to` in feature 003. What changes is that a
caller of the upload can now receive it — which is the point of FR-007, and is why the
override must be reachable from the upload too.

## Override on the upload path

`upsertChannel` takes `allow_rollback` in its JSON body. The upload's body is the bundle, so
the override arrives as a query parameter:

```yaml
- name: allow_rollback
  in: query
  required: false
  description: Proceed even though the named channel would move backwards.
  schema: { type: boolean }
```

Named to match the publish path's field so an operator reading one refusal message can act on
either. Requires `channel:write` like naming a channel does — it is meaningless without it.

## What must not change

`POST /admin/api/uploads` and `POST /admin/api/uploads/{token}` — the two-step publish. The
commit hardcodes the staging channel and takes no channel from the caller. Their contract
entries stay exactly as they are, and a test asserts the commit still works for a caller
holding `artifact:write` alone.
