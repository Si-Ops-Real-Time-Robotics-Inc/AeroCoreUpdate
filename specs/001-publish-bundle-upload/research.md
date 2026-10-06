# Phase 0 Research: Publish a firmware bundle from the new admin UI

## Decision 1 — Upload transport: XMLHttpRequest, not fetch

**Decision**: Add a separate XHR-based upload path in `webui/src/lib/upload.ts`, sharing the
bearer token and the `ApiError` mapping with the existing fetch client.

**Rationale**: `fetch` cannot report upload progress; there is no event for bytes sent.
FR-003 requires a progress indication, and a 300 MB bundle over a slow link with no feedback
is indistinguishable from a hang. The previous UI reached the same conclusion
(`public/admin/api.js`, `upload()`), and the comment there says so explicitly.

The body is the raw file with `Content-Type: application/gzip` — no multipart, so neither
side needs a parser.

**Alternatives considered**:
- `fetch` with a `ReadableStream` body: upload streaming requires HTTP/2 and duplex support,
  is unevenly implemented, and still reports no progress.
- Chunked upload with per-chunk progress: would change the server contract, which
  Constitution III and the spec's assumptions both rule out.

## Decision 2 — Integrity: whole-buffer SHA-256 via `crypto.subtle`

**Decision**: Hash the file with `crypto.subtle.digest('SHA-256', await file.arrayBuffer())`
and send it as `X-Expected-SHA256`, exactly as the previous UI does.

**Rationale**: The server refuses a bundle whose bytes do not hash to the header, before
anything is stored (FR-002). Web Crypto has no streaming digest, so the buffer is the only
route that does not involve writing or importing a SHA-256 implementation.

`crypto.subtle` is available: the admin surface is HTTPS only (Constitution IX), and the dev
server runs on `localhost`, which is also a secure context.

**Known cost, accepted**: `arrayBuffer()` holds the whole file in memory. With the default
`UPLOAD_MAX_BYTES` of 512 MB this is a real allocation, and a low-memory machine may fail on
the largest allowed bundle. This is not a regression — the previous UI has the same
behaviour — and the alternative contradicts Constitution IV.

**Alternatives considered**:
- Incremental SHA-256 in JavaScript: needs a package, or a hand-written implementation, for
  a problem no operator has reported.
- Skip the client hash and let the server detect corruption: the server would then have to
  read and store the whole upload before refusing it, which is the thing this header exists
  to avoid.

## Decision 3 — Confirm/discard is an inline panel, not a modal

**Decision**: Render the staged result and its two actions as a panel in the page flow. Do
not use a Radix dialog for this feature.

**Rationale**: Two independent reasons point the same way.

1. The previous UI already does this (`#commit-wrap` in `public/admin/index.html`), and the
   review is long — inspection, config slices, plugins, warnings, diff. A modal that has to
   scroll is a worse reading surface than the page itself.
2. The Content-Security-Policy on `/admin/*` is `style-src 'self'` with no `'unsafe-inline'`
   (`src/core/csp.js`). Radix primitives set inline `style` attributes for positioning and
   scroll locking, and `style-src-attr` falls back to `style-src`, so a dialog would be
   partially neutered in ways that are awkward to test. Avoiding the component avoids the
   question; relaxing the policy for a component we do not need would weaken the surface
   for no gain.

**Alternatives considered**: adding `'unsafe-inline'` to `style-src`, or a nonce/hash
scheme. Both are real work and both weaken or complicate a policy that currently costs
nothing. Revisit only if a later screen genuinely needs a modal.

## Decision 4 — Types come from the generated client

**Decision**: `StagedUpload`, `CommittedUpload`, `Artifact` and `Diff` are imported from
`webui/src/api/schema.d.ts`, regenerated with `npm run generate:api`. No shape is written by
hand.

**Rationale**: Constitution VI, and recent evidence: three hand-written shapes in this same
client were wrong (`/auth/me`, the sign-in response, and the error envelope's field name),
and one invented column set reached a schema before a test caught it.

**Gap found**: the spec's `StagedUpload.inspection` and `Diff` are currently typed as open
objects (`additionalProperties: true`). The publish screen renders their internals, so it
would be typing them by hand in all but name. Tightening those two schemas in
`api/openapi.yaml` is part of this feature, not a follow-up.

## Decision 5 — Scope gating from `/auth/me`

**Decision**: Read `scopes` from the existing `me` query and render the upload control only
when it contains `artifact:write`.

**Rationale**: FR-010. The server refuses regardless, so this is presentation, not security —
which is why the screen must also state *why* the control is absent rather than simply
hiding it.

## Decision 6 — Testing the front end

**Decision**: Add Vitest as a `devDependency` of `webui/` and test the pure logic: the
platform-prompt trigger, the progress arithmetic, scope gating, and the error mapping.

**Rationale**: Constitution VII requires tests, and the admin UI currently has none — a bug
in this same client (sign-out never calling the server) shipped for exactly that reason.

**Constitution IV check**: IV names `pg` as the only *runtime* dependency and explicitly
grants the admin UI its own package tree. Vitest is a dev dependency of `webui/`, never
installed into the server image, which the Dockerfile's separate build stage already
guarantees. No violation.

**Not doing**: browser-driven end-to-end tests. The upload path needs a real file, a real
server and a real token; that is a manual quickstart step here, not an automated suite.
