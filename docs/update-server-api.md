# Update Server API

The contract between an **update server** and a **GCS node** that pulls updates from it. This document is normative: a server that implements it correctly will work with any conforming node, and vice-versa.

Machine-readable form: [`update-server-openapi.json`](update-server-openapi.json) (OpenAPI 3.0).

The node asks *"given who I am and what I'm running, what should I be running?"* and the server answers. Because the node identifies itself — including which **system** it is — the server hands each device its own product's release line, and can hold a build on a test channel before the fleet sees it.

> **Scope.** This specifies the server side and the wire format. The node-side client is `library/update/UpdateClient.cpp`; `UpdateClient::check` builds the request in [§2](#2-get-apiv1updatecheck) and `UpdateService` supplies its fields. What the node does *after* the package lands — verify, apply, fan out to the paired AIR, restart — is documented in [ota-flow.md](ota-flow.md).

---

## 1. Conventions

| | |
|---|---|
| Base URL | operator-configured, e.g. `http://updates.example.com` — the node stores it and appends the paths below |
| Content type | `application/json; charset=utf-8` for all JSON; `application/gzip` for packages |
| Auth | `X-API-Key: <key>` on **every** request (see [§10](#10-security)) |
| Timestamps | RFC 3339 UTC, e.g. `2026-07-28T09:00:00Z` |
| Encoding | UTF-8 everywhere; base64 is standard (RFC 4648) with padding |

### Version strings

Dotted numeric — `MAJOR.MINOR.PATCH`, e.g. `0.15.0`. Compared **component-wise as integers**, with the shorter side zero-padded:

```
0.9.0  <  0.10.0        because 9 < 10
0.13.3 <  0.13.10
1.0    == 1.0.0
```

> **Do not compare these as strings.** Lexically `"0.9.0" > "0.10.0"`, which silently inverts the rollout. Both sides must compare numerically. This rule is new to both sides — the node's existing apply path only tests string *equality* (`current == target`), so it never needed ordering before.

### Platform strings

`<os>-<arch>`, produced by the node's `detect_platform()` and stamped into the runtime's `manifest.json` at build time.

| os | arch |
|---|---|
| `linux`, `windows`, `android`, `macos` | `x86_64`, `aarch64`, `arm`, `x86` |

In practice you will see `linux-x86_64`, `linux-aarch64`, `android-aarch64`, `android-x86_64`, `windows-x86_64`. Treat the value as an opaque string and match it exactly — do not parse it apart.

### System strings

The kind of device this AeroCore runs on — e.g. `HERA`, `drone`, `GCS`. Stamped into the runtime's `manifest.json` at build time, alongside `version` and `platform`:

```json
{ "package": "AeroCoreEngine", "version": "0.13.4",
  "platform": "linux-x86_64", "system": "HERA" }
```

A system has **its own plugin set, its own config and its own version line**. Version numbers are never reused across systems, because a version number is what identifies a version line.

Opaque, case-sensitive, matched exactly. The node reads it and sends it back; it never invents one, and it never derives one from `platform` or from `link.role` — a `HERA` GCS and a `HERA` drone are the same system on different platforms, while a `drone` and a `GCS` build are different systems that may share a platform. Only the build knows which.

**A string names one system; a list declares compatibility.** Both shapes appear, and they mean different things:

| Where | Shape | Meaning |
|---|---|---|
| a node's own runtime `manifest.json` | string | this node **is** that system |
| a core slice's `manifest.json` | string | this core is **for** that system — it names the bundle's system |
| a plugin's `manifest.json` | string **or** array | the products this plugin is **valid on**, the plugin author's call |
| absent, or empty | — | compatible with everything |

So a plugin declaring `["HERA", "drone"]` does not put a bundle into two systems — it says it works in either. Only the core names the system a bundle belongs to, and a bundle belongs to exactly one.

Sharing a plugin across systems is ordinary, not an exception: the same plugin is packaged into each system's bundle, every bundle still names one system, and nothing is flagged. What is flagged is a plugin whose list does **not** cover the bundle it is in — that plugin is skipped on every device that installs it.

Case matters. `system_covers()` compares with `==` on `std::string`, so `Hera` and `HERA` are two different systems, and a server should say so plainly when two names differ only in case.

This mirrors `system_covers()` in the node's `PackageApply.cpp`, which is what actually decides at apply time: an unstamped node accepts anything, a stamped one installs only what covers it, and a package it does not cover is **skipped, not failed** — see [§5](#4-what-can-and-cannot-be-updated).

> **Systems are created by an operator, never by a node or a package.** A server that met an unknown system name by creating it would turn one typo in a build script into a second, invisible version line that no node is ever offered anything from. See [§2](#placing-a-node) for what a server does instead.

### Error envelope

Every non-2xx response carries:

```json
{ "error": "invalid_api_key", "message": "API key not recognised" }
```

`error` is a stable machine code the node branches on; `message` is human text for the operator. Codes:

| Code | HTTP | Meaning |
|---|---|---|
| `missing_parameter` | 400 | a required query parameter is absent or empty |
| `invalid_parameter` | 400 | present but malformed (bad version, unknown platform) |
| `invalid_api_key` | 401 | missing or unrecognised `X-API-Key` |
| `not_found` | 404 | no such version/platform artifact |
| `range_not_satisfiable` | 416 | `Range` outside the resource |
| `rate_limited` | 429 | too many requests — `Retry-After` header is set |
| `server_error` | 500 | unexpected server fault |
| `maintenance` | 503 | temporarily unavailable — `Retry-After` header is set |

---

## 2. `GET /api/v1/update/check`

The core of the protocol. Safe, idempotent, cacheable — poll it freely within the etiquette in [§9](#9-polling-etiquette).

### Request

| Param | Req | Description |
|---|---|---|
| `serial` | ✅ | the node's serial, from `link.serial` in `core.json`. Identifies the device for targeting |
| `platform` | ✅ | see above — the node's own platform |
| `version` | ✅ | the currently installed core version, from the runtime `manifest.json` |
| `system` | ◻ | the node's system, from the same `manifest.json` — see [§1](#system-strings). Send it whenever the manifest has it |
| `channel` | | release channel, default `stable`. From `update.channel` in the node's `core.json` — see [Channels are per system](#channels-are-per-system) |
| `plugins` | | comma-separated `Name@version` list, so the server can offer plugin-only updates |

◻ = not required, but a node that can send it must. A build old enough to have no `system` in its manifest omits it and the server falls back; see [Placing a node](#placing-a-node).

Headers: `X-API-Key` (required), `If-None-Match` (optional — the `ETag` from a previous check).

```http
GET /api/v1/update/check?serial=SN-42&platform=linux-x86_64&version=0.13.3&system=HERA&channel=stable HTTP/1.1
Host: updates.example.com
X-API-Key: 2f8c1e9a4b7d6c3e
If-None-Match: "chk-0.15.0-linux-x86_64"
```

### Response — update available

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
ETag: "chk-0.15.0-linux-x86_64"
Cache-Control: no-cache
```
```json
{
  "update_available": true,
  "version": "0.15.0",
  "url": "/api/v1/update/download/0.15.0?platform=linux-x86_64&system=HERA",
  "size": 12582912,
  "sha256": "87224aca0ca2bfd6391dd4a3c8d51355ad6c90615a966b11874e58c252ea04f9",
  "target": "linux-x86_64",
  "system": "HERA",
  "min_version": "0.13.0",
  "mandatory": false,
  "notes": "Adds ZMQ bus self-description. Fixes config reset on OTA.",
  "published_at": "2026-07-28T00:00:00Z",
  "signature": {
    "alg": "ed25519",
    "key_id": "rtr-ota-2026",
    "value": "7cLkk/EB+PmRUrjyQg9ZtXGtOMCOLefHMw8HMm8fCHPtN2rSynY/ZsakBHjWwyRAbuAirhLY/tEN1oNUXZ/qBg=="
  }
}
```

| Field | Req | Description |
|---|---|---|
| `update_available` | ✅ | `true` here; `false` form below |
| `version` | ✅ | the offered version. Must be **newer** than the node's `version` by [§1](#version-strings) ordering |
| `url` | ✅ | where to fetch it. Absolute, or relative to the base URL. May carry its own query string |
| `size` | ✅ | exact package size in bytes. The node checks it before and after download |
| `sha256` | ✅ | lowercase hex SHA-256 of the package |
| `target` | ✅ | the platform set this artifact covers. The node must verify the signature over it **and** confirm its own platform is in it — see [§7](#6-manifest-signature) |
| `min_version` | | upgrade floor — see [§8](#7-min_version-and-mandatory) |
| `mandatory` | | display hint only — see [§8](#7-min_version-and-mandatory) |
| `notes` | | release notes shown to the user before they accept |
| `published_at` | | RFC 3339 timestamp, display only |
| `signature` | ✅ | see [§7](#6-manifest-signature) |

### Response — already current

```json
{ "update_available": false }
```

Return this — not a 404 — when the node is on the newest version for its channel and platform, or when its channel is not handing anything out yet. The node treats both identically.

**200, never 204.** The node's client treats any status other than 200 as a failure and never parses the body, so an empty 204 reads as a broken server rather than as "you are current".

### `channels` — on both shapes

Every check response, update or not, carries the channels this node's system has:

```json
{ "update_available": false, "channels": ["stable", "beta"] }
```

A flat array of names. The node reads it in `UpdateClient::check` (strings only — objects are dropped) and `UpdateService::sync_channel_options` writes them into `update.channel`'s `options`, turning the device's setting into a dropdown of what this server really offers.

**It has to be on the no-update shape.** A node whose `update.channel` names something this server does not have receives exactly that shape, forever, with no error anywhere. The list is the only thing that can correct it — omit it there and the one node that needs it is the one node that never gets it.

| Rule | Why |
|---|---|
| Always both names | Every system has exactly `beta` and `stable`. The set is closed, so the list never shrinks and a device's dropdown never loses an entry it had yesterday. |
| Only this node's system | Channels are keyed by `(system, name)`. Another product's channel names could only mislead. |
| Omit the key when there is nothing to send | An unplaced node has no system, so no correct list exists. The node reads an absent or empty list as "server said nothing" and leaves the setting alone. |
| Cover it in the `ETag` | Otherwise a channel added today never reaches a node holding a 304. |

The server **never sets the value** — only the options. Which channel to sit on is the operator's choice, and a locked `update.channel` outranks the server here exactly as it does in the OTA config merge.

### Response — not modified

```http
HTTP/1.1 304 Not Modified
ETag: "chk-0.15.0-linux-x86_64"
```

Send this when `If-None-Match` matches what you would have returned. The node keeps its previous answer. Make the `ETag` a function of everything that affects the response — at minimum version, platform, **system** and channel — so a rollout change invalidates it. A node reassigned to another system must not keep serving a cached answer from its old one.

### Placing a node

Channels, pins and rollout are all scoped to one system, so the server has to place a node before it can answer at all. In order:

| # | Source | When it applies |
|---|---|---|
| 1 | an assignment an operator made for that `serial` | always wins — a human already decided |
| 2 | the `system` the node sent | it names a system this server has, **and** does not contradict source 3 |
| 3 | the system of the release carrying the node's `version` | the node sent no `system` |
| 4 | the only system that exists | a single-system server, where there is nothing to confuse it with |

If none apply the server has no basis to answer, and **offers no update** — the [no-update response](#response--already-current), which is `200` with `update_available: false`, never a bare `204`. It must record the sighting, with whatever `system` the node claimed, so an operator can place the device.

Guessing is the one thing it must not do: handing a node another system's core swaps its plugin set and its config in a single step.

Two cases end here rather than in an answer:

- **Unknown system.** The node sent a well-formed name that matches no system on this server — a typo in a build script, or a system nobody created yet. Answer no-update and record it; never `400`, and never create the system. A node is not the authority on which systems exist, and auto-creating would turn one typo into a second, invisible version line that nothing is ever published to.
- **Disagreement.** The node says `HERA`, but the release carrying its `version` belongs to another system. The server does **not** pick a winner. One of the two is wrong and the server cannot tell which, so it records both and waits — unless an operator has already assigned that serial, which is source 1 and settles it.

> The node reports; it does not decide. `system` is evidence, not an instruction.

### Channels are per system

A channel is keyed by `(system, name)`, not by name alone. `stable` for `HERA` and `stable` for `drone` are different channels pointing at different releases, because each system has its own version line.

The node's channel is **operator-chosen on the device**: `update.channel` in `core.json`, a `list` param defaulting to `"stable"`. Its `options` are whatever this server last sent in `channels[]`, so the dropdown offers what actually exists — but the *value* is only ever set by a person, and a value can outlive the list it came from.

So a node can still ask for a channel that does not exist for its system: a device configured before the list reached it, or one whose system changed underneath it. The server answers no-update, not `404` — from the protocol's side there is simply nothing to offer. But that is **indistinguishable from being up to date**, and the device shows no error, so the failure is silent on both ends: one drone that never updates again and nothing anywhere says why.

A server must therefore record checks whose `channel` has no entry for the node's system, and surface them to its operator. This is a reporting duty, not a protocol response — on the wire it stays an ordinary no-update.

### Other responses

`400` `missing_parameter` / `invalid_parameter` · `401` `invalid_api_key` · `429` `rate_limited` (+ `Retry-After`) · `503` `maintenance` (+ `Retry-After`).

> **One request describes one node.** A GCS with a paired AIR asks for itself; the artifact it
> receives covers every platform in the release ([§3](#3-one-artifact-for-the-whole-fleet)), so
> the bytes it copies over the link are usable on the AIR as well.

---

## 3. One artifact for the whole fleet

**Build one bundle per release containing every platform variant and every plugin.** Sign it once. The server picks from that catalog and never composes or signs per request.

This is close to forced by the architecture rather than a preference. The GCS mirrors the *identical* bytes it received to the AIR — the same `begin`/`chunk`/`commit` frames — so both nodes necessarily receive the same artifact. Per-node bundles would require changing how the node fans out, which this protocol deliberately does not touch.

What happens on each node:

```
one bundle, version 0.15.0
  core   variants: linux-x86_64, android-aarch64
  plugin SRTunnel_Plugin: linux-x86_64, android-aarch64
  plugin Camera_Argus_Plugin: android-aarch64

GCS (linux-x86_64)      applies core+SRTunnel for linux-x86_64
                        skips the android variants and Camera_Argus entirely
AIR (android-aarch64)   applies its own variants
                        skips the linux ones
```

**`no_variant_for_platform` is a normal outcome, not an error.** A node reports it for every component that has nothing for its platform and carries on. Do not treat it as a failed update, and do not build separate bundles to avoid it.

The cost is honest: each node downloads variants it will skip. A two-platform bundle is roughly twice the size of a slim one. That is the price of the single-artifact fan-out, and for a handful of platforms it is the right trade.

The single-platform slim form is still legal for a **standalone** node answered through the `GET` form — that is what the `platform` query parameter on the download endpoint is for.

---

## 4. What can and cannot be updated

Everything below is delivered by the same bundle; the node applies each component with the least disruptive mechanism ([ota-flow.md §5](ota-flow.md)).

| Component | Effect | Restart |
|---|---|---|
| `core` | the engine binary plus `webui/`, `docs/` | yes |
| `plugin` | add or replace a plugin, per-platform | no — hot-loaded |
| `config` | set params on core or a plugin | plugin: no, applied live · core: next restart |

An unknown component type is **skipped, not fatal**, so you can introduce new types later and older nodes will ignore them rather than fail.

### Silent skips the server must prevent

Three apply-time outcomes are recorded as `skipped` and are **not** errors. The node still reports `ok`, the fleet dashboard still goes green, and nothing changed on the device:

| `reason` | Cause |
|---|---|
| `same_version` | the core slice's `manifest.json` names the version already installed |
| `system_mismatch` | the slice's `system` does not cover this node's (see [§1](#system-strings)) |
| `no_variant_for_platform` | no variant matches this node's platform |

They are deliberately non-fatal: on a multi-platform artifact, most nodes skip most of it, and that is correct. Which is exactly why they cannot double as error reporting.

**So the server is where these are caught, and it must catch them before publishing.** A server that hands a `drone` release to a `HERA` node produces `system_mismatch` on the whole fleet and learns nothing about it. Place the node ([§2](#placing-a-node)), scope every answer to its system, and validate a bundle's `system` at upload.

### Shipping a param change

A `config` component carries a **slim, value-only payload** — just the params you want to set, not the whole config file:

```json
{ "web":     { "port": 9090 },
  "general": { "fps": 60 } }
```

Group names and param names must match the target's existing config. Both `{"group": {"param": value}}` and a flat `{"param": value}` are accepted; a param that does not exist on the node is ignored.

One component per target. `target` is `core` or a plugin name:

```json
{"type":"config","target":"core","path":"config/core-values.json"}
{"type":"config","target":"Camera_Argus_Plugin","path":"config/camera-values.json"}
```

Three behaviours to design around:

**Locked and readonly params are skipped, not overwritten.** A param an operator has locked in the Web UI, or one the engine owns (`readonly` — ACDP pairing slots, engine-written identity), keeps its value. The node reports the skipped keys back and carries on; the rest of the payload still applies. This is the mechanism operators rely on to keep a tuned value through an update, so **treat a skip as expected, not as a failure**.

**A plugin's config applies live; core config waits for a restart.** Setting a plugin param publishes a reload notification and the plugin picks it up immediately — no restart, no interruption. Core params are read at startup, so they take effect on the next restart. If a release only changes plugin params, nothing restarts at all.

**Config components are applied after core and plugin components in the same bundle**, and when a core is staged in the same release the config merges into the *staged* copy. So "ship a new core and change one of its params" works in a single release, and the param is already set the first time the new core runs. Ordering is handled by the bundler — you do not need to arrange it.

A config-only release still needs a **new package version**: the `version` in the check response is the package version, and a node offered its own installed version will consider itself current. Bump it (`0.15.0` → `0.15.1`) even when no binary changed.

Three limits worth designing around:

**An Android core binary cannot be updated over the air.** On an APK build the binary lives in `nativeLibraryDir`, read-only to the app's uid, so the launcher deliberately skips `bin/` when applying a staged update. Everything else — `config/`, `webui/`, `docs/`, `plugins/` — updates normally. A new core on Android means a new APK.

Say so rather than offering an update that silently will not take:

```json
"core": { "from": "0.13.0", "to": "0.15.0", "blocked": "android_apk_core" }
```

**Per-plugin versions are not in the bundle manifest.** The package records a single package-level `version`; individual plugin versions exist only inside `plugins/<name>/<platform>/manifest.json` in the payload, and the node never reads them back. A server that wants to show which plugin versions a release installs has to read them out of the bundle at publish time and keep them — nothing on the wire carries them, and the node cannot compute them.

**Plugin hot-load on Android is unverified.** The apply path writes the `.so` into the app's files directory and `dlopen`s it with no Android-specific handling, and the only failure path is "install and hope a restart fixes it" — which on Android would fail the same way. Test it on a real device before you promise plugin OTA there.

---

## 5. `GET /api/v1/update/download/{version}`

Serves the package bytes. The body is an ordinary component-aware OTA package — the same artifact `scripts/package_update_bundle.sh` already produces. **No new package format is introduced by this protocol.**

### Request

Path: `{version}` — the version from the check response.
Query: `system` and `platform` — **both required**.
Headers: `X-API-Key` (required), `Range` (optional), `If-None-Match` (optional).

**Do not build this URL.** Use the `url` the check response gave you, verbatim. It already
carries both parameters, which is what lets a node fetch the right bytes without knowing what a
system is.

Three things identify a download and all three are checked:

| | Refusal | What it prevents |
|---|---|---|
| `version` | `404` | — |
| `system` absent | `400 missing_parameter` | a caller composing the URL itself |
| `system` ≠ the release's system | `404` | a device handed another product's firmware, which replaces its plugin set and its config in one step |
| `platform` absent | `400 missing_parameter` | as above |
| `platform` not covered by the package | `404` | a device installing nothing while reporting success — the `no_variant_for_platform` skip |

Both mismatches answer `404`, the same as a version that does not exist, because telling them
apart would leak which versions other systems hold.

The redundancy is deliberate. A version already identifies one release, so neither parameter
carries new information — what each carries is a **refusal**.

`platform` selects as well as checks: the slim artifact built for exactly that platform wins,
and a fleet artifact answers only if it actually covers it.

### Response — full body

```http
HTTP/1.1 200 OK
Content-Type: application/gzip
Content-Length: 12582912
Accept-Ranges: bytes
ETag: "pkg-0.15.0-linux-x86_64"
Content-Disposition: attachment; filename="aerocore-0.15.0-linux-x86_64.tar.gz"
```

`Content-Length` is **mandatory and must be exact**. The node uses it to render a real progress percentage and to reject a truncated body early — chunked transfer without a length degrades both.

### Response — resumed

```http
GET /api/v1/update/download/0.15.0?platform=linux-x86_64&system=HERA HTTP/1.1
Range: bytes=4194304-
```
```http
HTTP/1.1 206 Partial Content
Content-Type: application/gzip
Content-Length: 8388608
Content-Range: bytes 4194304-12582911/12582912
Accept-Ranges: bytes
ETag: "pkg-0.15.0-linux-x86_64"
```

Support at least the open-ended `bytes=N-` form; that is all a resuming download needs. Multi-range (`bytes=0-99,200-299`) is **not** required — reject it with `416` if you do not implement it.

A dropped link on a 12 MB package over a field connection is the difference between a 4-second resume and starting over. This matters more than it looks.

### Other responses

`304` (on `If-None-Match`) · `401` `invalid_api_key` · `404` `not_found` (unknown version or no artifact for that platform) · `416` `range_not_satisfiable` (+ `Content-Range: bytes */<size>`).

---

## 6. Manifest signature

**This is what makes the protocol safe over plain HTTP.** The API key keeps strangers out; the signature is what stops a network attacker from feeding a node a package of their choosing.

Algorithm: **Ed25519**. The node holds the public key; the private key lives in your release pipeline.

### What is signed

Not the JSON. Canonical-JSON schemes invite two implementations disagreeing about key order, whitespace and number formatting, and the failure is silent. Instead sign a **fixed-order, newline-delimited payload**:

```
version   \n
size      \n
sha256    \n
target    \n
min_version \n
published_at
```

Rules:

- Exactly six fields, always in this order, joined by `\n` (U+000A). **No trailing newline.**
- `size` is the decimal integer with no separators or padding.
- An absent or null optional field (`min_version`, `published_at`) contributes the **empty string**, so the separators are still present.
- Encode as UTF-8, sign those bytes, base64 the 64-byte signature into `signature.value`.
- **Six, and only six.** Other manifest fields — `url`, `system`, `mandatory`, `notes`, `channels` — sit alongside the signature and are covered by none of it. Adding one must never change a signed byte. A server that let a new field reach this payload would make every node in the fleet reject its manifests as forged, all at once, with no way to tell why.

**`target` is the platform set this artifact covers**, canonicalised so both sides derive the same string:

| Artifact | `target` |
|---|---|
| slim, one platform (the `GET` form) | that platform — `linux-x86_64` |
| catalog bundle, many platforms (the `POST` form) | every platform in it, **sorted ascending, comma-joined, no spaces** — `android-aarch64,linux-x86_64` |

Sorting is what makes it canonical: without it, two servers listing the same platforms in different orders would produce signatures that fail to verify. Sort the plain strings ascending (byte order) and join with a single `,`.

`target` is also returned as a **top-level manifest field**, because the node cannot rebuild the signed payload without it.

### Verification is two steps

Checking the signature alone is not enough. A node must do both:

1. **Verify the signature** over the payload built from the manifest's own fields, including its `target`.
2. **Check its own platform is in that `target` set.** Reject if not.

Step 1 alone would let an attacker replay a *genuine, correctly-signed* manifest for a different platform — the signature verifies, because it is a real one. Step 2 is what closes that: a `linux-x86_64` node refuses a manifest whose `target` is `android-aarch64`, no matter how validly it is signed. Neither step is optional.

### Worked example

For the manifest in [§2](#2-get-apiv1updatecheck):

```
0.15.0
12582912
87224aca0ca2bfd6391dd4a3c8d51355ad6c90615a966b11874e58c252ea04f9
linux-x86_64
0.13.0
2026-07-28T00:00:00Z
```

As a single string: `"0.15.0\n12582912\n87224aca0ca2bfd6391dd4a3c8d51355ad6c90615a966b11874e58c252ea04f9\nlinux-x86_64\n0.13.0\n2026-07-28T00:00:00Z"` — 121 bytes.

With no `min_version` and no `published_at` it becomes `"0.15.0\n12582912\n87224aca0ca2bfd6391dd4a3c8d51355ad6c90615a966b11874e58c252ea04f9\nlinux-x86_64\n\n"` — note the two trailing separators and the empty final field.

And for a catalog bundle covering two platforms, only the 4th line changes:

```
0.15.0
24117248
87224aca0ca2bfd6391dd4a3c8d51355ad6c90615a966b11874e58c252ea04f9
android-aarch64,linux-x86_64
0.13.0
2026-07-28T00:00:00Z
```

Sign and verify (Python, `cryptography`):

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey, Ed25519PublicKey)
import base64

def canonical_target(platforms) -> str:
    """One platform, or the whole set sorted+comma-joined. Sorting is what
       makes two independent implementations agree."""
    return ",".join(sorted(platforms))

def signing_payload(m: dict, platforms) -> bytes:
    return "\n".join([
        m["version"], str(m["size"]), m["sha256"], canonical_target(platforms),
        m.get("min_version") or "", m.get("published_at") or "",
    ]).encode("utf-8")

priv = Ed25519PrivateKey.generate()
payload = signing_payload(manifest, ["linux-x86_64", "android-aarch64"])
manifest["signature"] = {
    "alg": "ed25519", "key_id": "rtr-ota-2026",
    "value": base64.b64encode(priv.sign(payload)).decode(),
}

# node side — it knows the target from the catalog entry it asked for
pub = Ed25519PublicKey.from_public_bytes(TRUSTED_KEY_BYTES)
pub.verify(base64.b64decode(manifest["signature"]["value"]), payload)  # raises on mismatch
```

### Key rotation

`signature.key_id` names which public key signed this manifest. Ship the node with a small map of `key_id → public key` so a key can be rotated by publishing manifests under a new `key_id` while old nodes still trust the old one. A node that does not recognise the `key_id` must **reject the update**, not fall back to trusting it.

---

## 7. `min_version` and `mandatory`

**`min_version`** is an upgrade floor. If the node's installed version is *older* than `min_version`, it must refuse this update and step through an intermediate release first. Use it when a release cannot safely migrate from arbitrarily old state — a config schema change, a protocol break — so you can retire a migration path instead of carrying it forever.

```
installed 0.12.0, offered 0.15.0 with min_version 0.13.0
  -> node refuses; you must also publish a 0.13.x it can reach first
```

**`mandatory`** is a **display hint for the front-end only** — it lets the app phrase the prompt more urgently. It does **not** bypass the user. The node always requires an explicit accept before applying, and the server has no way to force an unattended restart. Design your rollout on that assumption: a node that has not been accepted stays on its old version indefinitely.

---

## 8. Testing on a channel before the fleet gets it

The intended shape: publish to `beta`, let a few devices take it, then point `stable` at the same version.

```
upload 0.16.0   ->  staged, no channel points at it, no node sees it
beta.latest     =   0.16.0        <- test devices take it
   ... reports come back ...
stable.latest   =   0.16.0        <- the rest of the fleet follows
```

Three things a server has to get right for this to work at all.

### The device has to be able to pick `beta`

`update.channel` is a `list` param. Its `options` come from the `channels` field on the check response ([§2](#channels--on-both-shapes)); without it the device shows whatever menu was frozen into the build, which may not be what this server has.

### The choice has to survive the update

This is the trap. A core slice's `config/` goes through `reconcile_config`, where **the package is the base and every param the node has not locked takes the package's value**. Ship `update.channel: "stable"` unlocked and the sequence is:

```
operator sets device to beta  ->  beta build arrives  ->  applies
                              ->  config/ replaces core.json
                              ->  update.channel back to "stable"
```

The device leaves the test cohort by installing the thing it was testing. Nothing reports an error. **Lock `update.channel` in the build**, or the beta group dissolves on first use.

### Two channels, fixed

A system has exactly `beta` and `stable`, created with it. There is no third, and no way to name one — which is what lets a promote have a single target and no dropdown.

```
upload            ->  beta      the test group
promote           ->  stable    the fleet
```

### One release, one channel

`beta` and `stable` both handing out the same version is not a staged rollout — every node receives the same thing whichever channel it sits on, and the test stage means nothing.

So promoting is a **move**: pointing a channel at a version releases it from whichever channel was serving it, in the same operation. Nodes on the released channel keep the version they already installed and are told there is nothing new until that channel is pointed somewhere again.

A server should report which channel it released, and record it — clearing a channel changes what a different set of devices is offered, and that must not happen silently.

### The promotion must not go backwards

Pointing a channel at an older version looks harmless, because no node downgrades — an offer must be strictly newer by [§1](#version-strings) ordering. But a device provisioned *after* the mistake has no such protection: it takes whatever the channel says. The fleet then splits into "updated before the slip" and "arrived after it", and both are healthy by every check the protocol makes.

A server should refuse to move a channel backwards unless asked to explicitly, and record it when it does.

---

## 9. Polling etiquette

- `check` is a pure `GET` with no side effects. Repeating it is always safe.
- Suggested interval: **once an hour**, jittered. Do not poll a fleet on the exact hour — spread it.
- On `429` or `503`, honour `Retry-After` and back off. A node should also back off exponentially on transport errors, capped at a few hours.
- Use `ETag`/`If-None-Match` so a steady-state check costs a `304` with no body.
- The node may also check on demand when a user opens the update screen. Rate-limit by serial if that concerns you.

---

## 10. Security

The node downloads and executes this code. Be explicit about what each control does and does not do:

**The API key** (`X-API-Key`) keeps scanners and casual clients out and gives you per-fleet revocation. It is **not** an identity proof — over plain HTTP, anyone who reads `core.json` on a device or sniffs the wire has it. Treat it as a coarse gate, never as authorization for anything sensitive.

**The signature is the real control.** A network attacker who can intercept plain HTTP can rewrite the manifest, but cannot forge Ed25519 without the private key, so the node rejects the substitution. This is what makes running over plain HTTP tolerable at all. Do not make the signature optional in your server, and do not let a node skip it.

**The `sha256`** is verified again after download. On its own it proves only that the bytes match the manifest — and an attacker who rewrote the manifest would rewrite the hash too. Its value comes from being *inside the signed payload*: the signature binds the manifest, and the manifest binds the bytes.

**Key handling.** The private signing key belongs in your release pipeline, not on the server that serves files. A server compromise then costs you availability, not fleet integrity.

**If you can use HTTPS, do.** The above makes plain HTTP survivable, not private — an observer still learns your fleet's serials, versions and topology. TLS is not yet available in the node (no TLS backend is compiled into the core on any platform), which is why this protocol is designed to be safe without it.

---

## 11. `POST /api/v1/update/report` (optional)

Recommended, not required — a minimal server may omit it and return `404`.

After an update finishes or fails, the node reports the outcome. Without this you cannot tell a rollout is failing until someone phones in.

```json
{ "serial": "SN-42", "platform": "linux-x86_64", "role": "GCS",
  "from_version": "0.13.3", "to_version": "0.15.0",
  "result": "success",
  "error": "", "at": "2026-07-28T09:12:00Z" }
```

`result` is `success` or `failed`. On failure, `error` carries the node's reason — the existing apply-side codes are `sha_mismatch`, `size_mismatch`, `failed_to_extract`, `missing_manifest`, `no_variant_for_platform`, `config_reconcile_failed` ([ota-flow.md §9](ota-flow.md)).

Reply `200 {"ok": true}`. The node treats any failure here as non-fatal and does not retry — reporting must never block an update.

---

## 12. `GET /api/v1/health`

```json
{ "ok": true, "service": "aerocore-update-server", "time": "2026-07-28T09:00:00Z" }
```

No auth required. Lets a node — and your monitoring — distinguish "server unreachable" from "no update available", which are very different operationally.

---

## 13. Publishing a release

The server derives almost everything from the bundle. What an operator supplies is the bundle
and one decision.

### 1. Build, with config, and lock what must survive

```bash
bash scripts/linux/build_dist_linux.sh -BuildType Release -System HERA
```

Stamp `-System`. The value lands in every slice's `manifest.json` and is what the server files
the release under; a build without it can only be published to the default system.

**Lock the params a package must never overwrite.** A core slice's `config/` goes through
`reconcile_config`, where the package is the base and every param the node has *not* locked
takes the package's value. Unlocked, these are the ones that end a fleet:

| Param | What shipping it unlocked does |
|---|---|
| `update.server_url`, `update.api_key`, `update.enabled` | the device stops being reachable, and no later update can fix it |
| `update.channel` | an operator's channel choice is reset, so a test group dissolves by installing the thing it was testing |
| `link.serial` | the device loses the name it is targeted by |
| `link.role` | an AIR is flipped to GCS and stops answering its own GCS |

The server refuses none of these — the node protects locked params itself — but it names every
one of them back at you at upload time. A build where they are locked produces no such warning.

### 2. Bundle

```bash
bash scripts/package_update_bundle.sh --out aerocore-0.15.0.tar.gz --version 0.15.0 \
  --core   linux-x86_64=dist/runtime_Release \
  --core   android-aarch64=dist/runtime_Release_android-aarch64 \
  --plugin SRTunnel_Plugin:linux-x86_64=dist/plugins_Release/SRTunnel_Plugin \
  --plugin SRTunnel_Plugin:android-aarch64=dist/plugins_Release_android/SRTunnel_Plugin
```

`--version` must equal the version stamped inside every core slice. They disagree and the server
refuses the upload — the node compares the *slice*, so a mismatch means every device downloads
the package and replies `skipped/same_version` with no error anywhere.

Repeat `--core` per platform and `--plugin` per name *and* platform; repeats of one plugin name
become a single component with several variants. Add `--config <target>=values.json` to set
params through a **config component**, which writes only the params it names and skips locked
ones — a narrower instrument than a slice's `config/`.

A config-only release needs no `--core` or `--plugin`, but the upload must then name the
platforms it applies to, because the bundle cannot.

### 3. Upload

Two steps in the web UI. The first opens the bundle and reports the version, the platforms, the
plugin versions, the config params it sets and the diff against the release below — and stores
nothing. The second commits it, onto `beta`.

CI wants one call instead:

```bash
curl -X POST https://updates.example.com/admin/api/artifacts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/gzip' \
  -H "X-Expected-Sha256: $(sha256sum aerocore-0.15.0.tar.gz | cut -d' ' -f1)" \
  --data-binary @aerocore-0.15.0.tar.gz
```

From the bundle alone the server derives the version, the platform set, the kind, the system,
the per-plugin versions, the config params, the size, the sha256 and the **signature**. Nothing
is typed twice, so nothing can disagree.

### 4. Promote

A release lands on `beta`, where only devices set to that channel are offered it. When the
reports say it works, promote it to `stable` — which moves it: `beta` lets go in the same
transaction, because one release runs on one channel.

Everything the server serves is produced ahead of time; nothing is composed or signed per
request. The artifact you tested is byte-for-byte the artifact every device receives.

---

## 14. Reference implementation

**This repository.** It implements every rule in this document, and the tests under `tests/`
are executable assertions of them — `tests/check-get.test.js` and `tests/download.test.js` in
particular read as a conformance suite for §2 and §5.

Where each rule lives:

| Rule | Module |
|---|---|
| version ordering (§1) | `src/domain/version.js` |
| platform strings and `target` (§1, §6) | `src/domain/platform.js` |
| the signed payload (§6) | `src/domain/manifest.js` — `signingPayload` is the whole contract |
| placing a node (§2) | `src/services/update.service.js` — `resolveSystem` |
| the check answer (§2) | `src/services/update.service.js` — `checkSingleNode` |
| download refusals (§5) | `src/services/download.service.js` — `resolveArtifact` |
| bundle rules at publish (§13) | `src/domain/bundle.js` — ~40 rules, returns findings and never throws |
| the tar reader (§13) | `src/core/tar.js` — zero-dependency, streaming, never unpacks to disk |

Two things that are easy to get wrong in any language and worth copying deliberately:

**Reshape your framework's error envelope.** Most frameworks emit their own shape — FastAPI
gives `{"detail": …}`, Express gives HTML. A node branches on the `error` code from
[§1](#error-envelope), so anything else reads as an unparseable response.

**A missing query parameter is `400 missing_parameter`, not your framework's default.** FastAPI
returns `422`, which is not in the closed enum of [§1](#error-envelope) and which a node cannot
branch on.

> An earlier revision of this document carried a ~250-line FastAPI sketch here. It was removed
> once it no longer implemented the protocol: sample code that a reader can copy into a
> non-conforming server is worse than no sample code, and a disclaimer above it does not fix
> that — people copy the code, not the paragraph.

---

## See also

- [ota-flow.md](ota-flow.md) — what the node does once the package lands: verify, apply, config merge, fan-out to AIR, restart
- [zmq-reqrep-api.md](zmq-reqrep-api.md) § 8 — the `update:` verbs a front-end app uses to drive and observe an update
- [update-server-openapi.json](update-server-openapi.json) — this document as OpenAPI 3.0
