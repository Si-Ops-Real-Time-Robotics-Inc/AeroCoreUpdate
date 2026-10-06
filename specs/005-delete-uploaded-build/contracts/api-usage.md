# Contract: what removal uses, and five places the contract is wrong today

`api/openapi.yaml` is the source of truth; `tests/openapi.test.js` asserts routes and spec agree
in both directions. The client types in `webui/src/api/schema.d.ts` are regenerated after every
edit below — never hand-edited.

| Operation | Route | Permission |
|---|---|---|
| `deleteRelease` | `DELETE /admin/api/releases/{version}` | `catalog:delete` |
| `deleteArtifact` | `DELETE /admin/api/artifacts/{id}` | `catalog:delete` |
| `catalog` | `GET /admin/api/catalog` | `catalog:read` |

## Gap 1 — `deleteRelease` declares only success

It returns 404 for a release that does not exist and 409 for one a channel is serving — the 409
was observed live on 2026-09-10. The contract says neither.

**Fix**:

```yaml
responses:
  "200":
    description: Removed, with every artifact in it. Files are removed after the commit.
    content:
      application/json:
        schema:
          type: object
          required: [version, artifacts]
          properties:
            version: { $ref: "#/components/schemas/Version" }
            artifacts: { type: integer, description: How many artifacts went with it. }
  "401": { $ref: "#/components/responses/Unauthorized" }
  "403": { $ref: "#/components/responses/Forbidden" }
  "404": { $ref: "#/components/responses/NotFound" }
  "409":
    description: |
      A channel is serving this release. `details` carries a finding with
      `rule: release_in_use` and the channels, so a caller can say which one to move
      without parsing the message.
    content:
      application/json:
        schema: { $ref: "#/components/schemas/Error" }
```

## Gap 2 — `deleteArtifact` declares success and 404 only

After this feature it also refuses with 409 (FR-004).

**Fix**: the same 401 / 403 / 409, and a 200 body of `{ id }` instead of `Ok`.

## Gap 3 — both 200s are declared as `Ok`

`Ok` is `{ ok: true }`. The server sends `{ version, artifacts }` and `{ id }`. Corrected above.

## Gap 4 — `Finding` cannot carry the channels

**Fix**: add to `Finding`, optional because every other rule describes a bundle or a move:

```yaml
channels:
  type: array
  items: { type: string }
  description: |
    `release_in_use` only — every `system/channel` serving the release, current at the moment
    of the refusal. Show these rather than a list from an earlier catalog fetch.
```

and name `release_in_use` in `rule`'s description beside `config_only_needs_platforms` and
`channel_rollback`.

## Gap 5 — `Catalog.releases[].channels` is never sent

Declared; never produced by the server. It is removed. A client works out which channels serve
a release from `Catalog.channels` — same system, `latest` equal to the version — which is the
fact the server's rule reads.

## What a caller does with a refusal

| Status | `details[].rule` | Meaning | Screen |
|---|---|---|---|
| 409 | `release_in_use` | a channel serves it | name `channels` from the finding; say to point it elsewhere first |
| 404 | — | already gone | say so; refresh the catalog |
| 403 | — | no `catalog:delete` | should not be reachable — the control is not offered |

## What must not change

`uploadArtifact`, `stageUpload`, `commitUpload` and `putChannel` — their contract entries stay
exactly as they are.
