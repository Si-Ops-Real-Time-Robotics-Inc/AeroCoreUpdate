# Quickstart: validating the publish screen

## Prerequisites

- The stack is up: `docker compose up -d` here, and proxy_alpha's Keycloak reachable.
- An account holding `aeroserver-admin` or `aeroserver-publisher` in the `aerotunnel` realm.
- A real bundle to upload. A release already exists on `beta` for system `HERA`, so a second
  one exercises the diff path rather than the empty case.

## Run it

```bash
cd webui
VITE_OIDC_ISSUER=http://192.168.194.129:8081/realms/aerotunnel \
VITE_OIDC_CLIENT_ID=aeroserver-webui npm run dev     # http://localhost:5175/admin/
```

The dev server proxies `/admin/api` to `https://127.0.0.1:9443`, so this runs against the
real server with a real token.

For the packaged form: `docker compose up -d --build aerocoreupdate`, then
`https://192.168.194.129:9443/admin/`.

## Scenarios to walk

| # | Do this | Expect |
|---|---|---|
| 1 | Drag a valid bundle onto the screen | Progress advances; a review appears saying nothing is stored yet |
| 2 | Read the review | Contents, config split into locked and unlocked, plugins named with their product, warnings, and the diff |
| 3 | Discard | Catalog unchanged; no artifact, no release |
| 4 | Upload again and confirm | Release appears on `beta`; the screen says it is on `beta` and needs promotion |
| 5 | Check `stable` | Unchanged. `GET /admin/api/systems/HERA/channels/stable` points where it did |
| 6 | Re-upload the same bundle | Refused by name — "An artifact already exists for &lt;version&gt; &lt;kind&gt; &lt;platform&gt;". **Corrected 2026-09-10:** this scenario originally expected a `no_op` diff. It cannot happen — the duplicate guard fires while staging, before any diff is computed. And a rebuild at a NEW version is not a no-op either: the bundle stamps its version into the core manifest, so the review correctly reads `core linux-x86_64: 9.9.1 → 9.9.3`. `no_op` is real and is covered by the server tests; it is not reachable from this screen with a core bundle. |
| 7 | Upload a settings-only bundle | Asked which devices it targets; answering retries without re-choosing the file |
| 8 | Corrupt a byte and upload | Refused; nothing stored |
| 9 | Sign in as `pilot@rtrobotics.com` (viewer) | No upload control, and the screen says why |
| 10 | Sign in as `engineer@rtrobotics.com` | Can complete 1–4; no promote control anywhere |

## Automated checks

```bash
npm test                 # repo root: full suite, including OpenAPI conformance
cd webui && npm test     # Vitest: the pure logic added by this feature
cd webui && npm run typecheck
```

## Done when

Scenarios 1–10 pass, both suites are green, and `docs/c4.md` has an `L3.x` section for
publishing that matches what the code does.
