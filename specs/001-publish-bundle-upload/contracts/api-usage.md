# Contract: server operations this screen uses

The contract itself is `api/openapi.yaml`; this file records which operations this feature
depends on and what it relies on beyond the shapes. Nothing here redefines the contract — if
the two disagree, the spec wins and the conformance tests in `tests/openapi.test.js` will say
so.

| Operation | operationId | Scope | Used for |
|---|---|---|---|
| `POST /admin/api/uploads` | `stageUpload` | `artifact:write` | Stage. Optional `?platforms=`, header `X-Expected-SHA256`. |
| `POST /admin/api/uploads/{token}` | `commitUpload` | `artifact:write` | Confirm. Returns the artifact and the channel it landed on. |
| `GET /admin/api/auth/me` | `me` | `self` | Scope gating. |

## Relied-upon behaviour beyond the shapes

1. **Staging stores nothing.** `stored: false` is part of the answer, not an inference.
2. **Confirming targets `beta` and takes no channel argument.** The screen cannot ask for
   `stable`, because the operation has nowhere to put such a request. This is the mechanical
   half of Constitution II.
3. **A refusal carries a machine-readable reason.** The error envelope is
   `{ error, message, details? }` where `error` is the closed enum. The platform prompt keys
   off a finding in `details` with `rule: "config_only_needs_platforms"` — on `details`, never
   on `message`, which is prose and may be reworded.
4. **Size refusals arrive as HTTP 413** with the limit in `message`.

## Discard has no endpoint, and that is correct

There is no `DELETE /admin/api/uploads/{token}`. Checked against the route table
(`src/routes/admin.routes.js`): uploads has exactly two routes, both POST.

Discard is therefore **client-side only** — drop the token, clear the panel. Nothing was
stored, so there is nothing to undo; the staged file is never referenced again and the
server's pruner sweeps it within the hour. The previous UI says exactly this in a comment at
`public/admin/app.js:1084`.

Two consequences for this feature:

1. The screen MUST NOT claim the server deleted anything. "Discarded — nothing was stored"
   is the honest sentence, and it is what the previous UI shows.
2. **`webui/src/lib/api.ts` currently declares `discardUpload` as a `DELETE` to that path.**
   That method does not exist and the call would be refused. It was hand-written rather than
   generated — the exact failure Constitution VI exists to prevent — and removing it is a
   task in this feature.
