# Phase 0 Research: Delete an uploaded build

Four questions were set before planning. Answering them turned up three things nobody had
noticed, and two of them change the plan more than the questions did.

## Finding A — the database is an accomplice, not a guard

`channel.latest` has a foreign key to `release.version`, named `channel_latest_fkey`, and it is
`ON DELETE SET NULL` (verified on the live database: `confdeltype = n`). If a release is deleted
while a channel points at it, the database does not refuse: it quietly points the channel at
nothing. A channel pointing at nothing answers every device "no update" — the silent failure
this feature exists to prevent, performed by the schema itself.

Today the only thing standing in the way is the check at the top of `deleteRelease`, and it
runs **outside** the transaction that deletes. A promote that lands between the check and the
delete loses the race in exactly the way that empties a channel with no sign.

Nothing legitimate relies on `SET NULL`. `deleteSystem` refuses while the system has any
release, so it never deletes one; `upsertChannel` refuses to point a channel at another
system's release, so no channel of a system being removed can reference anything. The only
path that deletes a release is `deleteRelease`, which already means to refuse in that case.

## Finding B — a field the contract promises and the server never sends

`Catalog.releases[].channels` is declared in `api/openapi.yaml`. The server never sends it:
`mapRelease` has no such field and `getCatalog` adds only `artifacts`. `Catalog.tsx` renders
its badges from it, so **every release shows as "staged"**, including the one stable is
serving. No test noticed, because the conformance checks cover routes and some row schemas'
SQL columns, not this response.

It matters to this feature directly: whether a release is being served is the same fact that
decides whether it may be removed. A row reading "staged" beside a panel reading "served by
stable, cannot be removed" contradicts itself.

## Finding C — the suite asserts the defect as correct behaviour

`tests/upload.test.js`, "deleting an artifact removes its file", deletes the fleet artifact of
`0.15.0` and expects **200**. The very next test, "a release that is a channel latest cannot be
deleted", proves `0.15.0` is a channel's latest. So the suite states, in so many words, that
removing an artifact from a served release must succeed.

FR-004 makes that request a 409, so that test goes red — deliberately. It is the tightening the
spec's Assumptions names, not a regression. The test keeps its purpose (the file goes with the
row) by deleting from an **unserved** release; the served case becomes a refusal test of its
own. This is the one existing test this feature changes, and it is called out rather than
edited quietly.

## Decision 1 — Lock the release, check, then delete; and make the schema refuse too

**Decision**, for both operations, inside one transaction:

1. `SELECT … FROM release WHERE version = $1 FOR UPDATE`
2. `SELECT system, name FROM channel WHERE latest = $1`
3. any row → refuse (Decision 2); none → delete the row, audit, bump the revision
4. after commit, remove the files — unchanged, for the reason already in the code

**And** migration `011` replaces `channel_latest_fkey` with the same key `ON DELETE RESTRICT`.

**Why this is atomic under READ COMMITTED** (the pool sets no isolation level, so Postgres'
default applies). Every path that points a channel at a release — `upsertChannel`'s UPDATE and
`store()`'s INSERT … ON CONFLICT — runs a foreign-key check that takes `FOR KEY SHARE` on the
referenced release row. `FOR UPDATE` conflicts with `FOR KEY SHARE`. So once step 1 holds the
lock, no promote can land until this transaction ends; and a promote that committed before
step 1 is visible to step 2, because READ COMMITTED gives every statement a fresh snapshot.

**Why both, when either alone looks sufficient.** `RESTRICT` alone closes the race for whole
releases and does nothing for artifacts — no key runs from a channel to an artifact. The lock
alone closes both races, but only for code that remembers to take it; the next path that
deletes a release without it would reach `SET NULL` again. The lock is the guarantee this
feature makes; `RESTRICT` is the guarantee that survives whoever writes the next path.

After the lock-then-check, a `23503` (foreign-key violation) from `deleteRelease` cannot happen.
It is still mapped to the same refusal, so that if a future path trips `RESTRICT` the operator
reads which channel is serving the release instead of a 500.

**Where the SQL lives (Constitution V).** Four functions in `catalog.repository.js`, each taking
the transaction's `client`: `lockRelease`, `channelsServing`, `deleteReleaseRow`,
`deleteArtifactRow`. `catalogAdmin.service.js` currently runs its two DELETE statements as raw
`client.query` calls — an existing deviation. This feature moves those two into the repository
and adds no new raw SQL to the service.

**Rejected:**
- *Check-then-act, as today* — the window is real, and for releases losing it fires `SET NULL`.
- *One guarded statement, `DELETE … WHERE NOT EXISTS (SELECT … FROM channel …)`* — under READ
  COMMITTED the subquery is evaluated against the statement's snapshot, and when the DELETE has
  to wait, Postgres re-checks only the target row, not the subquery. A promote that commits
  while the DELETE waits is not seen, and the delete proceeds.
- *SERIALIZABLE for these two transactions* — correct, but it trades the race for a
  serialization failure that the pool has no retry for, surfacing as a 500 on a rare timing.
- *Narrower rule: refuse only the last artifact serving a platform* — rejected in the spec,
  because "last one serving a platform" depends on the slim→fleet fallback setting.

## Decision 2 — The refusal is a finding the UI branches on, carrying the channels

**Decision**: status 409, `error: "invalid_parameter"` (the closed enum, unchanged), and
`details: [{ rule: "release_in_use", message, channels: ["HERA/beta", …] }]`. The same `rule`
for both operations, so the UI handles one shape. The artifact message names the release it
belongs to.

`conflict(message)` gains an optional second argument, `details`, defaulting to null. Every
existing caller is unchanged. `errorHandler` already emits `details` for any `HttpError` that
carries them, so nothing else in the envelope moves.

**The UI shows the channels from the refusal, not from the catalog.** The refusal is the
current answer; the catalog on screen is by definition as old as the last fetch, and the spec's
edge case is precisely a channel moving onto the release while the panel was open.

**The UI also pre-empts with the catalog.** When the catalog already shows the release as
served, the removal panel says so and offers no destructive button. This reads a fact present
in the payload — which channel's `latest` equals this version — which is a lookup, not a
judgment. That is the difference from the rollback comparison, which the project keeps on the
server because ordering versions is a decision. The server refuses regardless.

**Contract**: `Finding` gains an optional `channels: string[]`; `rule` names `release_in_use`.

**Rejected:**
- *Catalog data alone* — stale in exactly the case the edge case describes.
- *Parse the message* — the standing rule is to branch on `rule`, never on prose.

## Decision 3 — Served-by comes from the top-level channel list; the phantom field goes

**Decision**: the UI derives which channels serve a release from `catalog.channels` (same
system, `latest === version`) — the same fact the server's rule reads, and what
`webui/src/lib/channels.ts` already does for promotion. `Catalog.releases[].channels` is removed
from the contract, because the server does not send it (Constitution VI: the contract
describes what is served). The "staged" badge is fixed by the same change.

A DB-backed test asserts that every property the contract declares on a catalog release
appears in a real response — the class of drift that let Finding B through every check.

**Rejected**: *make the server send per-release channels* — it would duplicate the top-level
list already in the same response, as server code, for no information the client lacks.

## Decision 4 — One artifact is reached by expanding its release

**Decision**: each release row gains a control showing its artifact count that expands an
inline list — file, kind, platform(s), size — with a Remove control per artifact. The row also
gains "Remove release". One inline `RemovePanel` renders beneath whichever row is being acted
on, for either target, in the pattern of `DeleteSystemPanel`.

**Rejected:**
- *A separate artifact page* — more surface for a list the row can already hold.
- *A modal* — the `/admin/*` CSP forbids the inline styles the dialog primitive positions with.
- *Always show every artifact* — a fleet bundle plus thirteen slim ones per release makes the
  catalog unreadable.

## Decision 5 — The catalog's stray banner is replaced, as a labelled task

**Decision**: `Catalog.tsx` swaps its names-only banner for `StrayBanner` from feature 003.

It is outside this feature's stated scope, so it is its own task and said here rather than
done in passing. It is done because this feature edits that file anyway; because feature 003
named a names-only banner the easy under-implementation, and it is still on this screen; and
because two screens rendering one fact two ways is drift. The component already exists and
is tested.

**Rejected**: *leave it* — knowingly keeping a banner the previous feature called broken, in
the file being edited, would be the silence this project keeps writing against.

## Two more contract gaps, found while checking the responses

Both delete operations declare their 200 as `Ok` (`{ ok: true }`). The server returns
`{ version, artifacts }` for a release and `{ id }` for an artifact. The contract is corrected
to what is sent.
